// Smoke test: prove the Kokoro "af_heart" voice generates real WAV audio
// through the actual sidecar HTTP API (same path the app uses).
//
//   node sidecar/smoke-heart.mjs
//
// Spawns kokoro-server.mjs, reads its KOKORO_SIDECAR_PORT line, polls /health
// until ready, POSTs /speak with voice "af_heart", then validates the returned
// bytes are a non-trivial RIFF/WAVE payload. Writes the WAV to .work/heart.wav
// for manual listening. Exits 0 on success, non-zero on any failure.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
}

const child = spawn(process.execPath, [join(here, "kokoro-server.mjs")], {
  cwd: here,
  stdio: ["pipe", "pipe", "inherit"],
});

let port = 0;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  const m = buf.match(/KOKORO_SIDECAR_PORT=(\d+)/);
  if (m && !port) port = Number(m[1]);
});

child.on("exit", (code) => {
  if (!port) fail(`sidecar exited (code ${code}) before printing port`);
});

async function main() {
  // 1) wait for the port line
  const portDeadline = Date.now() + 15_000;
  while (!port && Date.now() < portDeadline) await sleep(100);
  if (!port) throw new Error("never received KOKORO_SIDECAR_PORT");
  const base = `http://127.0.0.1:${port}`;
  console.log(`sidecar port=${port}`);

  // 2) poll /health until ready (cold load downloads/loads the q8 model)
  const readyDeadline = Date.now() + 120_000;
  let ready = false;
  let lastProgress = -1;
  while (Date.now() < readyDeadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        const h = await r.json();
        if (typeof h.progress === "number" && h.progress !== lastProgress) {
          lastProgress = h.progress;
          console.log(`load progress: ${(h.progress * 100).toFixed(0)}%`);
        }
        if (h.error) throw new Error(`model load error: ${h.error}`);
        if (h.ready) {
          ready = true;
          console.log(`voices exposed: ${(h.voices || []).length}`);
          const hasHeart = (h.voices || []).includes("af_heart");
          console.log(`af_heart present in sidecar voices: ${hasHeart}`);
          if (!hasHeart) throw new Error("af_heart not in sidecar voice list");
          break;
        }
      }
    } catch (e) {
      if (String(e.message).includes("model load error")) throw e;
      // otherwise keep polling
    }
    await sleep(500);
  }
  if (!ready) throw new Error("model never became ready (timeout)");

  // 3) synth with af_heart
  const t0 = Date.now();
  const r = await fetch(`${base}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Attention is all you need. The dominant sequence transduction models are based on recurrent or convolutional neural networks.",
      voice: "af_heart",
      speed: 1.0,
    }),
  });
  if (!r.ok) {
    let detail = "";
    try { detail = JSON.stringify(await r.json()); } catch {}
    throw new Error(`/speak HTTP ${r.status} ${detail}`);
  }
  const ab = await r.arrayBuffer();
  const bytes = Buffer.from(ab);
  const ms = Date.now() - t0;

  // 4) validate it's a real WAV
  const riff = bytes.subarray(0, 4).toString("ascii");
  const wave = bytes.subarray(8, 12).toString("ascii");
  console.log(`got ${bytes.length} bytes in ${ms}ms; header=${riff}/${wave}`);
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error(`not a WAV (header ${riff}/${wave})`);
  if (bytes.length < 20_000) throw new Error(`WAV suspiciously small (${bytes.length} bytes)`);

  // PCM duration sanity from the WAV header (data chunk / byte rate)
  const byteRate = bytes.readUInt32LE(28);
  let dataLen = 0;
  // find 'data' chunk
  for (let i = 12; i < bytes.length - 8; ) {
    const id = bytes.subarray(i, i + 4).toString("ascii");
    const sz = bytes.readUInt32LE(i + 4);
    if (id === "data") { dataLen = sz; break; }
    i += 8 + sz;
  }
  const seconds = byteRate ? dataLen / byteRate : 0;
  console.log(`approx audio duration: ${seconds.toFixed(2)}s (byteRate=${byteRate})`);
  if (seconds < 1) throw new Error(`audio too short (${seconds}s) — likely empty synthesis`);

  mkdirSync(join(repoRoot, ".work"), { recursive: true });
  const out = join(repoRoot, ".work", "heart.wav");
  writeFileSync(out, bytes);
  console.log(`wrote ${out}`);
  console.log("SMOKE PASS: af_heart produced valid WAV audio");
}

main()
  .catch((e) => fail(e.message))
  .finally(() => {
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
