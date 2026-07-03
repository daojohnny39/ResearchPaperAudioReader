// Copies pdfjs-dist offline assets (cmaps + standard_fonts) into public/ so the
// app renders PDFs fully offline (no CDN). Run automatically on postinstall and
// available manually via `npm run sync:pdfjs`. Defensive: no-op if the source
// package is not present yet.
import { cp, mkdir, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "node_modules", "pdfjs-dist");
const pub = resolve(root, "public");

const assets = ["cmaps", "standard_fonts"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(src))) {
    console.warn("[copy-pdfjs-assets] pdfjs-dist not installed yet — skipping.");
    return;
  }
  await mkdir(pub, { recursive: true });
  for (const a of assets) {
    const from = resolve(src, a);
    const to = resolve(pub, a);
    if (!(await exists(from))) {
      console.warn(`[copy-pdfjs-assets] missing source: ${from} — skipping.`);
      continue;
    }
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
    console.log(`[copy-pdfjs-assets] ${a} -> public/${a}`);
  }
}

main().catch((err) => {
  console.error("[copy-pdfjs-assets] failed:", err);
  process.exitCode = 1;
});
