# Windows Migration Plan - Research Paper Audio Reader

Goal: recreate the macOS Tauri v2 app from `O:\ResearchPaperAudioReader` as a native
Windows 11 app in `E:\Personal Projects\ResearchPaperAudioReader`.

Source (`O:\`) is read-only. Do not edit it. All migration work lands in `E:\`.

## What the app is

Tauri v2 desktop app: drop or pick a research-paper PDF, extract column-aware text, render
PDF pages with pdfjs text layers, read aloud while highlighting the spoken sentence, and
resume progress. The frontend is React 19, Vite 7, TypeScript, Tailwind v4, shadcn/radix,
zustand, and `@tauri-apps/plugin-store`.

TTS engines:

- Web Speech: `speechSynthesis`, offline-immediate default using OS voices.
- Kokoro neural TTS: Node sidecar at `sidecar/kokoro-server.mjs`, using native
  `onnxruntime-node` through `kokoro-js`, spawned by Rust and exposed on an ephemeral
  `127.0.0.1` HTTP port.

Rust backend in `src-tauri/src/commands.rs` provides PDF bytes, document SHA-256,
bounded-LRU audio cache, sidecar path resolution, Node discovery, sidecar spawn, and sidecar
process cleanup. `src-tauri/src/lib.rs` wires commands and drops the sidecar on app exit.
`src-tauri/src/main.rs` already has the release-only `windows_subsystem = "windows"` guard.

## Verified Codebase Facts

- Frontend source under `src/**` has no Windows-only migration patch requirement.
- `tauri.conf.json` already has:
  - `bundle.resources`: `{ "../sidecar": "sidecar" }`, so packaged builds include the whole
    sidecar directory as a Tauri resource.
  - `bundle.targets`: `"all"`, which means Windows builds try both NSIS and MSI.
  - `icon.ico` in the icon list.
  - CSP/devCSP allowing `http://127.0.0.1:*`, `http://localhost:*`, and Hugging Face hosts.
- `capabilities/default.json` allows `fs:allow-read-file` for `"**"`, which matches the
  existing file-picker/read-file design.
- Root `package.json` postinstall runs:
  - `scripts/copy-pdfjs-assets.mjs` -> regenerates `public/cmaps` and
    `public/standard_fonts`.
  - `scripts/copy-ort-assets.mjs` -> regenerates `public/ort` from the nested
    `@huggingface/transformers` instance used by `kokoro-js`.
- Real `public/` assets to copy are only `tauri.svg` and `vite.svg`; `cmaps`,
  `standard_fonts`, and `ort` are generated and should not be copied from macOS.
- Sidecar has its own `package-lock.json`. Copy it and use `npm ci` so Windows installs the
  same sidecar graph: `kokoro-js@1.2.1`, nested `@huggingface/transformers@3.8.1`,
  `onnxruntime-node@1.21.0`, `sharp@0.34.5`, and the Windows optional packages.
- The seeded Kokoro model cache is platform-independent and currently contains:
  - `onnx-community/Kokoro-82M-v1.0-ONNX/config.json`
  - `onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer.json`
  - `onnx-community/Kokoro-82M-v1.0-ONNX/tokenizer_config.json`
  - `onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx` (~92 MB)
- The macOS sidecar `node_modules` contains darwin native binaries, including
  `onnxruntime-node/bin/napi-v3/darwin/*` and `@img/sharp-darwin-arm64`. Do not copy it.
- `Cargo.toml` is edition 2021. Rust 1.85+ is still required because current transitive Rust
  dependencies in the Tauri graph may use edition 2024.

## Windows-Specific Changes Required

| # | Current macOS behavior | Windows fix |
|---|---|---|
| 1 | `find_node()` probes Unix paths such as `/opt/homebrew/bin/node`, `/usr/local/bin/node`, and `$HOME/.volta/bin/node`. | Add a `#[cfg(windows)]` branch. Probe `RPAR_NODE` first, then absolute Windows candidates, then fall back to `node.exe` for dev shells with PATH. |
| 2 | A Node child spawned from the release GUI app can briefly open a console window. | On Windows only, use `std::os::windows::process::CommandExt` and `creation_flags(0x08000000)` (`CREATE_NO_WINDOW`) on the sidecar `Command` before `.spawn()`. |
| 3 | macOS `sidecar/node_modules` native binaries cannot load on Windows. | Exclude all `node_modules`; run fresh installs on Windows with lockfiles. |
| 4 | The seeded model cache lives under a package-managed nested cache path. | Stage the cache before deleting/excluding sidecar `node_modules`, then copy it after `sidecar npm ci` into the freshly installed `sidecar/node_modules/@huggingface/transformers/.cache`. |

Recommended `find_node()` Windows candidate order:

1. `RPAR_NODE`, only if it points to an existing file.
2. `%ProgramFiles%\nodejs\node.exe` and `%ProgramW6432%\nodejs\node.exe` (also catches the
   normal nvm-windows symlink).
3. `%LOCALAPPDATA%\Volta\bin\node.exe`.
4. `%NVM_SYMLINK%\node.exe`, if set.
5. `%NVM_HOME%\v*\node.exe` and `%APPDATA%\nvm\v*\node.exe`, choosing the newest version-like
   directory. Do not use `%APPDATA%\nvm\node.exe`; nvm-windows does not normally place the
   executable there.
6. `%FNM_MULTISHELL_PATH%\node.exe`, if set.
7. `%LOCALAPPDATA%\fnm_multishells\*\node.exe`, choosing the newest directory.
8. Bare `node.exe` fallback.

Keep the existing macOS/Unix behavior behind `#[cfg(not(windows))]` or
`#[cfg(target_os = "macos")]` so the source remains cross-platform.

## Host Prerequisites

Verified on this Windows machine:

| Tool | Status | Action |
|------|--------|--------|
| Node | `C:\Program Files\nodejs\node.exe` v22.22.0 | none |
| npm | v10.9.4 | none |
| WebView2 Runtime | `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\149.0.4022.80` | none |
| Visual Studio C++ tools | VS2022 Community at `C:\Program Files\Microsoft Visual Studio\2022\Community`, MSVC `14.38.33130` | verify with `vswhere`; do not rely on `link.exe` from Git being on PATH |
| Windows SDK | 10.0.22000.0 and 10.0.22621.0 installed | none |
| Rust/cargo/rustup | not installed | install rustup stable MSVC |
| VBSCRIPT optional feature | not verified without elevation | required only when building MSI from `targets: "all"` |

Rust install:

```powershell
rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-msvc --profile minimal
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
rustup show active-toolchain
cargo --version
rustc --version
```

The active toolchain must be `stable-x86_64-pc-windows-msvc`, Rust must be 1.85 or newer, and
the host should be able to locate VS C++ tools through:

```powershell
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

If `npm run tauri build` fails during MSI creation with `light.exe` or VBSCRIPT errors, enable
the Windows VBSCRIPT optional feature and rerun the build. NSIS does not need that feature, but
this app's `"targets": "all"` includes MSI.

## Execution Plan

### Phase 0 - Preflight

- Confirm source exists and remains read-only:

```powershell
Test-Path 'O:\ResearchPaperAudioReader\src-tauri\src\commands.rs'
```

- Confirm destination is the migration workspace:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader'
```

- Confirm Rust/MSVC prerequisites above. Install Rust before dependency/build phases.

### Phase 1 - Copy Source Tree

The current destination initially contains the migration plan files. Do not use a root
`robocopy /MIR` unless those destination-only files are moved aside or excluded from deletion.

Copy source with generated/platform directories excluded:

```powershell
robocopy 'O:\ResearchPaperAudioReader' 'E:\Personal Projects\ResearchPaperAudioReader' /E /MT:8 `
  /XD '.git' '.work' 'node_modules' 'dist' 'src-tauri\target' 'src-tauri\gen' `
      'public\cmaps' 'public\standard_fonts' 'public\ort' 'sidecar\node_modules' `
  /XF '.DS_Store'
```

Robocopy exit codes `0` through `7` are successful or partially successful copy states; treat
`8` or higher as failure.

Required copied items include root `package.json`, root `package-lock.json`, `vite.config.ts`,
`tsconfig*.json`, `components.json`, `index.html`, `src/**`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`,
`src-tauri/src/**`, `src-tauri/capabilities/**`, `src-tauri/icons/**`, `scripts/*.mjs`,
`sidecar/kokoro-server.mjs`, `sidecar/package.json`, `sidecar/package-lock.json`,
`fixtures/**`, and real `public/*.svg` assets.

Stage the model cache separately before deleting or ignoring macOS `sidecar/node_modules`:

```powershell
robocopy `
  'O:\ResearchPaperAudioReader\sidecar\node_modules\@huggingface\transformers\.cache' `
  'E:\Personal Projects\ResearchPaperAudioReader\sidecar\_model_seed' /E /MT:8
```

Verify the staged seed has the four expected files and the ONNX file is present:

```powershell
Get-ChildItem 'E:\Personal Projects\ResearchPaperAudioReader\sidecar\_model_seed' -Recurse -File |
  Select-Object FullName,Length
```

### Phase 2 - Patch Windows Sidecar Launch

Edit only `E:\Personal Projects\ResearchPaperAudioReader\src-tauri\src\commands.rs`.

- Replace the single Unix-oriented `find_node()` with cfg-gated Unix and Windows logic using
  the candidate order above.
- Import `CommandExt` only on Windows:

```rust
#[cfg(windows)]
use std::os::windows::process::CommandExt;
```

- Build the sidecar command as a mutable `Command`, apply `creation_flags(0x08000000)` under
  `#[cfg(windows)]`, then spawn it. Preserve:
  - `current_dir(&script_dir)` so Node resolves sidecar-local `node_modules`.
  - `stdin(Stdio::piped())` so closing parent stdin can terminate the sidecar.
  - `stdout(Stdio::piped())` so Rust can read `KOKORO_SIDECAR_PORT=<port>`.
  - `stderr(Stdio::inherit())` for diagnostics.

No TypeScript, Tauri config, capability, Cargo manifest, or sidecar JS patch is required for
Windows migration.

### Phase 3 - Install Dependencies

Use `npm ci`, not `npm install`, because both root and sidecar have lockfiles and the sidecar
lock pins the nested Kokoro/transformers/ORT graph.

Root install:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader'
npm ci
```

This regenerates `public/cmaps`, `public/standard_fonts`, and `public/ort`.

Sidecar install:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader\sidecar'
npm ci
```

Verify Windows native sidecar binaries:

```powershell
Test-Path '.\node_modules\onnxruntime-node\bin\napi-v3\win32\x64\onnxruntime_binding.node'
Test-Path '.\node_modules\onnxruntime-node\bin\napi-v3\win32\x64\onnxruntime.dll'
Test-Path '.\node_modules\@img\sharp-win32-x64'
```

If those paths are missing, inspect `npm ci` output before continuing. Do not copy native
packages from `O:\`.

### Phase 4 - Restore Offline Kokoro Model Seed

After sidecar `npm ci`, copy the staged cache into the freshly installed transformers package:

```powershell
$dst = 'E:\Personal Projects\ResearchPaperAudioReader\sidecar\node_modules\@huggingface\transformers\.cache'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy 'E:\Personal Projects\ResearchPaperAudioReader\sidecar\_model_seed' $dst /E /MT:8
```

Verify:

```powershell
Test-Path "$dst\onnx-community\Kokoro-82M-v1.0-ONNX\onnx\model_quantized.onnx"
Get-Item "$dst\onnx-community\Kokoro-82M-v1.0-ONNX\onnx\model_quantized.onnx" |
  Select-Object FullName,Length
```

Only remove `_model_seed` after verification:

```powershell
Remove-Item -LiteralPath 'E:\Personal Projects\ResearchPaperAudioReader\sidecar\_model_seed' -Recurse -Force
```

If `kokoro-js@1.2.1` or its nested `@huggingface/transformers@3.8.1` cache path changes in a
future lockfile, the sidecar may download the model on first Kokoro use. Web Speech remains
offline-immediate either way.

### Phase 5 - Verification Gates

Run from the destination:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader'
npm run build
```

Run Rust check:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader\src-tauri'
cargo check
```

Optional sidecar smoke test without Tauri:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader\sidecar'
node .\kokoro-server.mjs
```

Expected first stdout line is `KOKORO_SIDECAR_PORT=<port>`. Stop it with Ctrl+C.

Optional packaged build:

```powershell
Set-Location 'E:\Personal Projects\ResearchPaperAudioReader'
npm run tauri build
```

Because `bundle.targets` is `"all"`, successful Windows packaging should place installers under
`src-tauri\target\release\bundle\nsis\` and `src-tauri\target\release\bundle\msi\`. MSI builds
require WiX/VBSCRIPT support; Tauri's Windows installer docs state MSI uses WiX Toolset v3 and
`targets: "all"` triggers MSI. NSIS produces the setup `.exe`.

Optional GUI smoke:

```powershell
npm run tauri dev
```

Manual checks: open/drop `fixtures\sample.pdf`, confirm Web Speech playback, open the voice
picker to prewarm Kokoro, switch to a Kokoro voice, confirm the sidecar starts without a visible
console flash, and confirm generated audio is cached across app restarts.

## Risks And Mitigations

| Risk | Mitigation |
|------|------------|
| `find_node()` misses a user-managed Node install in packaged GUI launches. | Probe `RPAR_NODE`, Program Files, Volta, nvm-windows symlink/version dirs, fnm env/multishell dirs, then `node.exe`. |
| Console flash from Node sidecar in release GUI app. | Apply Windows-only `CREATE_NO_WINDOW` to the sidecar `Command`. |
| macOS native sidecar packages are accidentally reused. | Exclude all `node_modules`; verify win32-x64 ORT and sharp after sidecar `npm ci`. |
| Sidecar dependency graph drifts and model cache path no longer matches. | Copy sidecar `package-lock.json` and use `npm ci`; verify model path after restore. |
| Root generated assets are stale or macOS-copied. | Exclude generated `public` subdirs and let root postinstall regenerate them on Windows. |
| MSI build fails even though `cargo check` passes. | Verify VBSCRIPT optional feature and WiX/MSI tooling; use NSIS output if MSI is not needed. |
| Antivirus or Windows Defender slows npm/cargo/robocopy. | Treat slow first installs/builds as expected; only investigate hard failures. |
| Long path issues in `node_modules`. | This project path should stay below normal limits, but if npm reports path-length errors, enable Windows long paths or move the workspace closer to a drive root. |
| CRLF/LF churn. | Do not run line-ending normalization over the tree; let npm/cargo consume existing files as-is. |

## Acceptance

- `O:\ResearchPaperAudioReader` remains untouched.
- `E:\Personal Projects\ResearchPaperAudioReader` contains the migrated source, lockfiles,
  sidecar, icons, scripts, fixtures, and real public assets.
- Only the destination `src-tauri/src/commands.rs` has Windows migration code changes.
- Root and sidecar dependencies are installed fresh on Windows with `npm ci`.
- `public/cmaps`, `public/standard_fonts`, and `public/ort` are regenerated by postinstall.
- Sidecar contains win32-x64 native deps and the seeded Kokoro model cache.
- `npm run build` and `cargo check` pass.
- Optional `npm run tauri build` produces NSIS and, if MSI prerequisites are present, MSI
  installer artifacts.
