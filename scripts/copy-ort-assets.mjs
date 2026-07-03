// Copies the ONNX-Runtime-Web wasm + Emscripten glue that kokoro-js's nested
// @huggingface/transformers@3.8.1 actually uses into public/ort/ so ORT loads them
// SAME-ORIGIN (no CDN, CSP-clean). Without this, transformers hardcodes ORT's
// wasmPaths to cdn.jsdelivr.net, which the Tauri CSP blocks -> load hangs forever.
// Runs on postinstall and via `npm run sync:ort`. Defensive + idempotent.
import { cp, mkdir, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pub = resolve(root, "public", "ort");

// Canonical names ORT requests (string wasmPaths prefix + filename); both required.
// The .mjs glue is dynamically imported FROM wasmPaths, then fetches the .wasm.
const FILES = ["ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Resolve the SAME @huggingface/transformers instance kokoro-js imports (its nested
// 3.8.1), chaining createRequire through the kokoro-js entry so hoisting can't fool us.
// transformers' `exports` map blocks deep-importing ./package.json, so we resolve the
// main entry (which lives inside dist/) and walk up to the package root, then dist/.
function resolveNestedTransformersDist() {
  const reqRoot = createRequire(import.meta.url);
  const kokoroEntry = reqRoot.resolve("kokoro-js"); // .../kokoro-js/dist/kokoro.{cjs,js}
  const reqFromKokoro = createRequire(kokoroEntry);
  const tfMain = reqFromKokoro.resolve("@huggingface/transformers"); // .../transformers/dist/<entry>
  let dir = dirname(tfMain);
  for (let i = 0; i < 6; i++) {
    try {
      const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
      if (name === "@huggingface/transformers") return join(dir, "dist");
    } catch {
      /* keep climbing */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: the main entry resolved inside dist/ in every known build.
  return dirname(tfMain);
}

async function main() {
  let srcDir;
  try {
    srcDir = resolveNestedTransformersDist();
  } catch {
    console.warn("[copy-ort-assets] kokoro-js/transformers not installed yet — skipping.");
    return;
  }
  await mkdir(pub, { recursive: true });
  for (const f of FILES) {
    const from = join(srcDir, f);
    const to = join(pub, f);
    if (!(await exists(from))) {
      console.warn(`[copy-ort-assets] missing source: ${from} — skipping.`);
      continue;
    }
    await cp(from, to);
    console.log(`[copy-ort-assets] ${f} -> public/ort/${f}`);
  }
}

main().catch((e) => {
  console.error("[copy-ort-assets] failed:", e);
  process.exitCode = 1;
});
