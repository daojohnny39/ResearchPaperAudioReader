//! Tauri commands backing the Research Paper Audio Reader.
//!
//! Three groups (PLAN §3, §5.5, §5.8, §10.5):
//!  1. `read_file_bytes` — hand a picked PDF's bytes to pdfjs in the webview.
//!  2. document hashing — `doc_hash` (path OR bytes) + `hash_file` (path,
//!     kept for the persistence layer) → stable SHA-256 hex resume key.
//!  3. on-disk audio cache in the app cache dir, keyed by a frontend-computed
//!     `hash(text+voice+rate)` string, with a bounded (bytes + count) LRU so
//!     generated Kokoro WAVs survive restarts without growing without limit.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::Manager;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Soft cap on total bytes held in the audio cache dir (~512 MiB).
const CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Soft cap on the number of cached audio files.
const CACHE_MAX_FILES: usize = 4096;

/// SHA-256 of `bytes`, lower-case hex.
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Read the raw bytes of a file. Used to hand PDF bytes to pdfjs in the webview
/// (after the user picks a file via the dialog plugin → path → these bytes).
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

/// Stable per-document key for resume/progress: SHA-256 hex of the document
/// contents. Accepts EITHER a `path` (read from disk — keeps large PDFs off the
/// IPC bridge) OR raw `bytes` (an HTML5 drag-drop ArrayBuffer that never touched
/// the filesystem). If both are supplied, `bytes` wins.
#[tauri::command]
pub fn doc_hash(path: Option<String>, bytes: Option<Vec<u8>>) -> Result<String, String> {
    let data = match (bytes, path) {
        (Some(b), _) => b,
        (None, Some(p)) => fs::read(&p).map_err(|e| e.to_string())?,
        (None, None) => return Err("doc_hash: provide either `path` or `bytes`".into()),
    };
    Ok(sha256_hex(&data))
}

/// Back-compat alias for the persistence layer (`hash_file` in progress.ts):
/// SHA-256 hex of a file's bytes, read by path.
#[tauri::command]
pub fn hash_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(sha256_hex(&bytes))
}

// ----------------------------------------------------------------------------
// On-disk audio cache (bounded LRU)
// ----------------------------------------------------------------------------

/// `<app cache dir>/audio`, created on demand.
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("audio");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Map a caller-supplied cache key to a safe single-segment filename. Keys are
/// content hashes already, but we never trust them as a path: if the key is not
/// purely `[A-Za-z0-9_-]` (or is empty) we hash it so the mapping stays stable
/// and the filename can never escape the cache dir.
fn key_to_filename(key: &str) -> String {
    let safe = key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !key.is_empty()
        && key.len() <= 128;
    if safe {
        format!("{key}.bin")
    } else {
        format!("{}.bin", sha256_hex(key.as_bytes()))
    }
}

/// Read a cached entry; on a hit, refresh its mtime so the LRU treats it as
/// recently used (best-effort — a failed touch never fails the read).
fn read_cache(app: &tauri::AppHandle, key: &str) -> Result<Option<Vec<u8>>, String> {
    let path = cache_dir(app)?.join(key_to_filename(key));
    match fs::read(&path) {
        Ok(bytes) => {
            if let Ok(f) = fs::OpenOptions::new().write(true).open(&path) {
                let _ = f.set_modified(SystemTime::now());
            }
            Ok(Some(bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write an entry atomically (temp file + rename) then enforce the cache bounds.
fn write_cache(app: &tauri::AppHandle, key: &str, bytes: Vec<u8>) -> Result<(), String> {
    let dir = cache_dir(app)?;
    let path = dir.join(key_to_filename(key));
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    enforce_bounds(&dir);
    Ok(())
}

/// Evict oldest-by-mtime entries until both the byte and file-count caps hold.
/// Best-effort: I/O hiccups during eviction never fail the enclosing `put`.
fn enforce_bounds(dir: &Path) {
    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in read.flatten() {
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let p = ent.path();
        // Skip in-flight temp files.
        if p.extension().and_then(|s| s.to_str()) == Some("tmp") {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total += meta.len();
        entries.push((p, meta.len(), mtime));
    }
    // Oldest first.
    entries.sort_by_key(|(_, _, t)| *t);
    let mut count = entries.len();
    for (p, len, _) in &entries {
        if total <= CACHE_MAX_BYTES && count <= CACHE_MAX_FILES {
            break;
        }
        if fs::remove_file(p).is_ok() {
            total = total.saturating_sub(*len);
            count -= 1;
        }
    }
}

/// Fetch cached generated audio (Kokoro WAV) by content key, or `None` on miss.
#[tauri::command]
pub fn audio_cache_get(app: tauri::AppHandle, key: String) -> Result<Option<Vec<u8>>, String> {
    read_cache(&app, &key)
}

/// Store generated audio (Kokoro WAV) by content key; enforces the LRU bound.
#[tauri::command]
pub fn audio_cache_put(app: tauri::AppHandle, key: String, bytes: Vec<u8>) -> Result<(), String> {
    write_cache(&app, &key, bytes)
}

/// Alias of [`audio_cache_get`] using the PLAN §5.5 `cache_get(key)` name.
#[tauri::command]
pub fn cache_get(app: tauri::AppHandle, key: String) -> Result<Option<Vec<u8>>, String> {
    read_cache(&app, &key)
}

/// Alias of [`audio_cache_put`] using the PLAN §5.5 `cache_put(key, bytes)` name.
#[tauri::command]
pub fn cache_put(app: tauri::AppHandle, key: String, bytes: Vec<u8>) -> Result<(), String> {
    write_cache(&app, &key, bytes)
}

// ----------------------------------------------------------------------------
// Kokoro Node sidecar (round 4)
// ----------------------------------------------------------------------------
//
// Kokoro's neural model CANNOT run inside the WKWebView (onnxruntime-web's
// threaded WASM deadlocks `InferenceSession.create` in a WebView Web Worker —
// proven across 3 rounds; see .work/kokoro-investigation-notes.md). Instead we
// run it in a Node SIDECAR using NATIVE onnxruntime-node (device:"cpu"), and the
// WebView calls it over a tiny localhost HTTP API.
//
// `start_kokoro_sidecar` spawns `node sidecar/kokoro-server.mjs`, reads the
// ephemeral port the sidecar prints to stdout (`KOKORO_SIDECAR_PORT=<port>`),
// remembers the child + base URL in managed state, and returns the base URL. It
// is idempotent: a second call returns the already-running URL. The child is
// killed when the managed state is dropped (app exit) — see `SidecarProcess`'s
// Drop impl and the RunEvent::Exit hook in lib.rs.
//
// PACKAGING (done): the whole `sidecar/` dir — `kokoro-server.mjs`, its own
// `node_modules` (kokoro-js + native onnxruntime-node), and the SEEDED Kokoro
// model under transformers' `.cache` — ships as a Tauri **resource** (see
// `bundle.resources` in tauri.conf.json), so the packaged `.app` is fully
// offline and self-contained. `sidecar_script_path()` resolves it from the
// resource dir when packaged and from the project root under `tauri dev`. A
// `.app` launched from Finder gets only a minimal PATH, so `find_node()`
// resolves an ABSOLUTE `node` (Homebrew/volta/nvm) instead of a bare `node`.

/// A running sidecar process plus the base URL the WebView should call.
pub struct SidecarProcess {
    child: Child,
    base_url: String,
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        // Best-effort: stop the Node process when the app exits / state drops.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Managed state: at most one sidecar at a time.
#[derive(Default)]
pub struct SidecarState(pub Mutex<Option<SidecarProcess>>);

/// Resolve the sidecar script path. Packaged builds ship `sidecar/` (script +
/// its own `node_modules` + the seeded Kokoro model) as a Tauri **resource**, so
/// it lives under `<.app>/Contents/Resources/sidecar/`. In `tauri dev` there is
/// no resource bundle, so fall back to `CARGO_MANIFEST_DIR/../sidecar` (the
/// project root, the reliable dev anchor).
fn sidecar_script_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        // Tauri may place the dir directly or, for `../`-prefixed sources, under
        // an `_up_/sidecar` segment — probe both shapes.
        for cand in [res.join("sidecar"), res.join("_up_").join("sidecar")] {
            let script = cand.join("kokoro-server.mjs");
            if script.exists() {
                return script;
            }
        }
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .unwrap_or(manifest_dir)
        .join("sidecar")
        .join("kokoro-server.mjs")
}

/// Locate a `node` runtime to run the sidecar. A `.app` launched from Finder
/// inherits only a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare
/// `node` won't be found even though the user has one — resolve an ABSOLUTE
/// path. Honors a `RPAR_NODE` override, then probes the usual install locations,
/// then falls back to bare `node` (works under `tauri dev` where PATH is full).
/// Pick the newest node.exe inside a dir of version-like subdirs
/// (nvm-windows v<x.y.z> / fnm multishells). Best-effort, lexicographic.
#[cfg(windows)]
fn newest_versioned_node(root: &Path) -> Option<PathBuf> {
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let node = entry.path().join("node.exe");
        if !node.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        match &best {
            Some((bn, _)) if name <= *bn => {}
            _ => best = Some((name, node)),
        }
    }
    best.map(|(_, p)| p)
}

fn find_node() -> std::ffi::OsString {
    use std::ffi::OsString;
    if let Some(n) = std::env::var_os("RPAR_NODE") {
        if Path::new(&n).is_file() {
            return n;
        }
    }

    #[cfg(windows)]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        // Standard installer / nvm-windows symlink target.
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(var) {
                candidates.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
            }
        }
        // Volta.
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local).join("Volta").join("bin").join("node.exe"));
        }
        // nvm-windows: explicit symlink first.
        if let Some(sym) = std::env::var_os("NVM_SYMLINK") {
            candidates.push(PathBuf::from(sym).join("node.exe"));
        }
        if let Some(nvm_home) = std::env::var_os("NVM_HOME") {
            if let Some(node) = newest_versioned_node(&PathBuf::from(nvm_home)) {
                candidates.push(node);
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            if let Some(node) = newest_versioned_node(&PathBuf::from(appdata).join("nvm")) {
                candidates.push(node);
            }
        }
        // fnm.
        if let Some(ms) = std::env::var_os("FNM_MULTISHELL_PATH") {
            candidates.push(PathBuf::from(ms).join("node.exe"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            if let Some(node) =
                newest_versioned_node(&PathBuf::from(local).join("fnm_multishells"))
            {
                candidates.push(node);
            }
        }
        for c in candidates {
            if c.is_file() {
                return c.into_os_string();
            }
        }
        return OsString::from("node.exe");
    }

    #[cfg(not(windows))]
    {
        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin/node"), // Apple-silicon Homebrew
            PathBuf::from("/usr/local/bin/node"),    // Intel Homebrew / pkg installer
            PathBuf::from("/usr/bin/node"),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".volta/bin/node"));
            candidates.push(home.join(".local/bin/node"));
            candidates.push(home.join(".nvm/versions/node/current/bin/node"));
        }
        for c in candidates {
            if c.is_file() {
                return c.into_os_string();
            }
        }
        return OsString::from("node");
    }
}

/// Strip the Windows `\\?\` verbatim (extended-length) prefix from a path.
/// Tauri's `resource_dir()` hands back verbatim-prefixed paths, but Node's CJS
/// loader can't parse `\\?\E:\…` as its entry script: it mis-resolves and
/// lstat's the bare drive (`E:`), dying with `EISDIR`. Plain DOS paths work, so
/// de-namespace before passing to Node (also fixes `current_dir`). No-op on a
/// path that isn't verbatim-prefixed.
#[cfg(windows)]
fn denamespace(p: &Path) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}
#[cfg(not(windows))]
fn denamespace(p: &Path) -> PathBuf {
    p.to_path_buf()
}

/// Start the Kokoro sidecar (idempotent). Returns the base URL
/// `http://127.0.0.1:<port>` the frontend SidecarKokoroEngine calls.
#[tauri::command]
pub fn start_kokoro_sidecar(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // Already up and still alive → return the existing URL (idempotent).
    if let Some(proc) = guard.as_mut() {
        match proc.child.try_wait() {
            Ok(None) => return Ok(proc.base_url.clone()), // still running
            _ => {
                // Exited/crashed — drop it and respawn below.
                *guard = None;
            }
        }
    }

    let script = sidecar_script_path(&app);
    if !script.exists() {
        return Err(format!(
            "kokoro sidecar script not found at {}",
            script.display()
        ));
    }
    // Run with the sidecar dir as cwd so Node resolves its bundled node_modules
    // and any relative cache writes land beside the script (not in `/`).
    let script_dir = script
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    // De-namespace both paths: Node can't run a `\\?\`-prefixed entry script and
    // `current_dir` rejects verbatim paths too.
    let script = denamespace(&script);
    let script_dir = denamespace(&script_dir);

    let mut cmd = Command::new(find_node());
    cmd.arg(&script)
        .current_dir(&script_dir)
        .stdin(Stdio::piped()) // keep stdin open; closing it tells the sidecar to exit
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // Windows: don't flash a console window when the GUI app spawns Node.
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `node {}`: {e}", script.display()))?;

    // Read stdout on a worker thread until we see the port line (bounded wait so a
    // wedged sidecar can't hang the IPC call forever).
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let (tx, rx) = mpsc::channel::<Result<u16, String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut sent = false;
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if let Some(rest) = l.strip_prefix("KOKORO_SIDECAR_PORT=") {
                        if !sent {
                            sent = true;
                            let parsed = rest
                                .trim()
                                .parse::<u16>()
                                .map_err(|e| format!("bad port `{rest}`: {e}"));
                            let _ = tx.send(parsed);
                        }
                        // keep draining stdout so the pipe never fills + blocks the child
                    }
                }
                Err(_) => break,
            }
        }
        if !sent {
            let _ = tx.send(Err("sidecar closed stdout before printing port".into()));
        }
    });

    let port = match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            let _ = child.kill();
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill();
            return Err("timed out waiting for sidecar port".into());
        }
    };

    let base_url = format!("http://127.0.0.1:{port}");
    *guard = Some(SidecarProcess {
        child,
        base_url: base_url.clone(),
    });
    Ok(base_url)
}
