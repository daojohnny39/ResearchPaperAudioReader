// SVG -> square PNG rasterizer using the sidecar's already-installed (win32-x64) sharp.
// Usage: node rasterize-icon.mjs <input.svg> <output.png> [size=1024]
import sharp from "sharp";
import { readFileSync } from "node:fs";

const [, , inPath, outPath, sizeArg] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node rasterize-icon.mjs <input.svg> <output.png> [size]");
  process.exit(2);
}
const size = Number(sizeArg) || 1024;
const svg = readFileSync(inPath);

const out = await sharp(svg, { density: 384 })
  .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

const { writeFileSync } = await import("node:fs");
writeFileSync(outPath, out);
console.log(`OK ${outPath} ${out.length} bytes ${size}x${size}`);
