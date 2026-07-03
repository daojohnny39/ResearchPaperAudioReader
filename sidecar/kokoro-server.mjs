// Kokoro TTS sidecar — runs the neural model OUT of the WKWebView.
//
// WHY THIS EXISTS (round 4): onnxruntime-web's threaded WASM deadlocks
// `InferenceSession.create` inside a WKWebView Web Worker, so Kokoro cannot run
// in the Tauri WebView (proven across 3 rounds — see
// .work/kokoro-investigation-notes.md). The PROVEN-WORKING path is kokoro-js
// `from_pretrained(dtype:"q8", device:"cpu")` in Node, which uses NATIVE
// onnxruntime-node (no WASM, no WebKit threading): the model loads and
// `generate()` returns a real WAV in ~1.8s (.work/repro-kokoro-cpu.mjs).
//
// This file is that Node runtime exposed over a tiny localhost HTTP API the
// Tauri parent spawns. The frontend SidecarKokoroEngine calls it cross-origin
// (WebView origin -> 127.0.0.1:<ephemeral port>), so every response carries
// permissive CORS and OPTIONS preflight is handled.
//
// Protocol with the Rust parent: we listen on an EPHEMERAL port (bind :0) and
// print the chosen port to stdout as exactly  `KOKORO_SIDECAR_PORT=<port>`  so
// the parent can read it and hand the base URL to the WebView.

import http from "node:http";
import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// ── Model load state (single in-flight load shared by every request) ─────────
let tts = null; // the loaded KokoroTTS once ready
let ready = false; // flips true after from_pretrained resolves
let loadError = null; // last load failure (so /health can report it)
let progress = 0; // monotonic 0..1 aggregate download/load fraction
let loadPromise = null; // the one in-flight load promise

// Byte-weighted, monotonic progress (mirrors the old worker's anchoring so the
// bar moves smoothly and never goes backward). The first cold run downloads the
// q8 model (~80 MB) from Hugging Face; subsequent runs hit the transformers
// cache and resolve near-instantly.
const EXPECTED_MODEL_BYTES = 80_000_000;
const fileBytes = new Map(); // file -> { loaded, total }

function recomputeProgress() {
  let sumLoaded = 0;
  let sumTotal = 0;
  for (const { loaded, total } of fileBytes.values()) {
    sumLoaded += loaded || 0;
    sumTotal += total || 0;
  }
  const denom = Math.max(sumTotal, EXPECTED_MODEL_BYTES);
  const frac = denom > 0 ? sumLoaded / denom : 0;
  const clamped = Math.max(0, Math.min(1, frac));
  if (clamped > progress) progress = clamped; // never go backward
}

function onModelProgress(p) {
  if (!p || typeof p !== "object") return;
  const file = p.file ?? p.name ?? "model";
  if (p.status === "progress") {
    const loaded = typeof p.loaded === "number" ? p.loaded : 0;
    const total =
      typeof p.total === "number" && p.total > 0
        ? p.total
        : typeof p.progress_total === "number"
          ? p.progress_total
          : 0;
    fileBytes.set(file, { loaded, total });
    recomputeProgress();
  } else if (p.status === "done") {
    const prev = fileBytes.get(file);
    if (prev && prev.total > 0) fileBytes.set(file, { loaded: prev.total, total: prev.total });
    recomputeProgress();
  }
}

function loadModel() {
  if (loadPromise) return loadPromise; // one in-flight load, shared
  loadPromise = (async () => {
    // device:"cpu" is MANDATORY — "wasm" deadlocks/errors here (round 1-3).
    const engine = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "cpu",
      progress_callback: onModelProgress,
    });
    tts = engine;
    ready = true;
    progress = 1;
    return engine;
  })().catch((err) => {
    loadError = err?.message ?? String(err);
    loadPromise = null; // allow a later retry
    throw err;
  });
  return loadPromise;
}

function voiceList() {
  try {
    return tts ? Object.keys(tts.voices ?? {}) : [];
  } catch {
    return [];
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, obj) {
  setCors(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    const method = req.method ?? "GET";
    const url = (req.url ?? "/").split("?")[0];

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, {
        ready,
        progress: ready ? 1 : progress,
        error: loadError ?? undefined,
        voices: ready ? voiceList() : undefined,
      });
      return;
    }

    if (method === "POST" && url === "/speak") {
      if (!ready) {
        sendJson(res, 503, { error: "model not ready", progress, ...(loadError ? { loadError } : {}) });
        return;
      }
      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw.toString("utf8") || "{}");
      } catch (e) {
        sendJson(res, 400, { error: `bad request: ${e?.message ?? "invalid JSON"}` });
        return;
      }
      const text = typeof payload.text === "string" ? payload.text : "";
      const voice = typeof payload.voice === "string" && payload.voice ? payload.voice : "af_heart";
      const speed =
        typeof payload.speed === "number" && payload.speed > 0 ? payload.speed : 1.0;
      if (!text.trim()) {
        sendJson(res, 400, { error: "missing text" });
        return;
      }
      try {
        const audio = await tts.generate(text, { voice, speed });
        // kokoro-js RawAudio -> WAV Blob -> raw bytes (NOT .data — see CLAUDE.md).
        const arrayBuf = await audio.toBlob().arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        setCors(res);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": String(buf.length),
        });
        res.end(buf);
      } catch (e) {
        sendJson(res, 500, { error: `synthesis failed: ${e?.message ?? String(e)}` });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    // Never crash the process on a single bad request.
    try {
      sendJson(res, 500, { error: `internal error: ${e?.message ?? String(e)}` });
    } catch {
      /* ignore */
    }
  }
});

// Don't let a flaky client connection take the server down.
server.on("clientError", (_err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    /* ignore */
  }
});

// Ephemeral port on loopback only.
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // The single line the Rust parent greps for. Keep it EXACTLY this shape.
  process.stdout.write(`KOKORO_SIDECAR_PORT=${port}\n`);
  // Begin loading the model immediately so it's warming while the WebView polls.
  loadModel().catch((err) => {
    process.stderr.write(`kokoro sidecar: model load failed: ${err?.message ?? err}\n`);
  });
});

// Exit cleanly when the parent goes away / asks us to stop.
function shutdown() {
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// If stdin closes (parent died), shut down too.
process.stdin.on("end", shutdown);
process.stdin.resume();
