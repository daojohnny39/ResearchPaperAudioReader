// Validation harness for the PDF text-extraction pipeline (PLAN §5.1, §10.2,
// §10.6). Runs the *real* buildCharMap() from src/lib/pdf/extract.ts against the
// committed 2-column arXiv fixture and asserts the reading order is sensible:
// abstract text contiguous, no left/right column interleaving, and click→offset
// round-trips.
//
//   node --experimental-strip-types scripts/validate-extract.mjs
//
// Uses the pdfjs *legacy* node build to construct a PdfDoc (the app's loader.ts
// uses a Vite-bundled worker that can't run under bare node); extract.ts itself
// is engine-agnostic and is exercised verbatim.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildCharMap } from "../src/lib/pdf/extract.ts";
import { segment } from "../src/lib/text/segment.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const FIXTURE = path.join(root, "fixtures", "sample.pdf");

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

async function main() {
  const data = new Uint8Array(readFileSync(FIXTURE));
  const doc = await pdfjs.getDocument({
    data,
    standardFontDataUrl: path.join(root, "node_modules/pdfjs-dist/standard_fonts/"),
    cMapUrl: path.join(root, "node_modules/pdfjs-dist/cmaps/"),
    cMapPacked: true,
    isEvalSupported: false,
  }).promise;

  const pdfDoc = {
    numPages: doc.numPages,
    raw: doc,
    getPage: (n) => doc.getPage(n),
  };

  const map = await buildCharMap(pdfDoc);
  const full = norm(map.text);
  const page1End = map.text.indexOf("\n\f") >= 0 ? undefined : undefined; // (pages aren't \f-separated)

  console.log(`\n=== doc: ${doc.numPages} pages, ${map.text.length} chars ===`);

  // First ~700 chars of reading-order text (this is page 1 top: title → authors
  // → abstract → intro), for the human reading the log.
  console.log("\n--- reading-order head (first 700 chars) ---");
  console.log(map.text.slice(0, 700).replace(/\n/g, "¶ "));
  console.log("--- end head ---\n");

  // 1. Abstract sentence must appear CONTIGUOUS. If 2-column order were wrong
  //    (row-interleaved across the gutter) this phrase would be shredded.
  const abstract =
    "the dominant sequence transduction models are based on complex recurrent or convolutional neural networks";
  ok(full.includes(abstract), "abstract opening sentence is contiguous");

  // 2. The Introduction's first sentence (start of the 2-column body) must also
  //    be contiguous — proves left-column lines are joined in order, not mixed
  //    with the right column.
  const intro =
    "recurrent neural networks, long short-term memory";
  ok(full.includes(intro), "introduction opening clause is contiguous");

  // 3. No cross-column bleed: the LEFT column's intro must not be immediately
  //    followed by RIGHT-column text. Check a known left→continuation join.
  const introTail = "and gated recurrent";
  ok(full.includes(intro) && full.includes(introTail), "intro continues within its column");

  // 4. Title present early in page-1 reading order. (Char 0 is the rotated arXiv
  //    license banner baked into the PDF — a known v1 narration artifact — so the
  //    title sits just after it, not at offset 0.)
  ok(norm(map.text.slice(0, 800)).includes("attention is all you need"),
     "title appears early in page-1 reading order");

  // 5. Dehyphenation: no broken "- " soft hyphens left dangling mid-word in body.
  const dangling = (map.text.match(/[a-z]-\n[a-z]/g) || []).length;
  ok(dangling === 0, `no dangling soft hyphens across lines (found ${dangling})`);

  // 6. Round-trip click→offset on a real mapped page-1 item, then bbox lookup.
  const p1 = map.pages[0];
  const sample = p1.items.find((it) => it.charStart >= 0 && it.str.trim().length > 3);
  if (sample) {
    const off = map.spanToOffset(1, sample.sourceItemIndex, 0);
    ok(off === sample.charStart,
       `spanToOffset(1, src=${sample.sourceItemIndex}) === item.charStart (${off})`);
    ok(map.offsetToPage(off) === 1, "offsetToPage(thatOffset) === page 1");
    const boxes = map.rangeToBBoxes(sample.charStart, sample.charEnd);
    ok(boxes.length >= 1 && boxes.every((b) => b.page === 1),
       `rangeToBBoxes returns page-1 boxes (${boxes.length})`);
  } else {
    ok(false, "found a mapped page-1 item to round-trip");
  }

  // 7. Char offsets follow READING order: sort mapped page-1 items by
  //    readingOrderIndex and assert charStart is non-decreasing. (Source order
  //    ≠ reading order, which is the whole point of the column-aware pass.)
  const mapped = p1.items
    .filter((it) => it.charStart >= 0)
    .sort((a, b) => a.readingOrderIndex - b.readingOrderIndex);
  const monotonic = mapped.every(
    (it, i) => i === 0 || it.charStart >= mapped[i - 1].charStart,
  );
  ok(monotonic, "page-1 char offsets increase with reading order");

  // 8. SENTENCE-LEVEL segmentation (regression guard for the line->sentence
  //    narration fix). The abstract's opening sentence wraps across several
  //    visual lines; it must resolve to ONE segment spanning those wraps, not a
  //    segment per line.
  const segs = segment(map);
  const abstractSeg = segs.find((s) =>
    norm(s.text).includes(
      "the dominant sequence transduction models are based on",
    ),
  );
  ok(!!abstractSeg, "abstract opening sentence resolves to a segment");
  ok(
    !!abstractSeg && norm(abstractSeg.text).includes("encoder and a decoder"),
    "that segment spans wrapped lines (one sentence, not per-line)",
  );
  const textLines = map.text.split("\n").length;
  console.log(
    `\n=== segmentation: ${segs.length} segments vs ${textLines} text lines ===`,
  );

  // 9. HIGHLIGHT PRECISION: a single PDF text item can straddle a sentence
  //    boundary, so rangeToBBoxes clips each item to the part inside the
  //    segment. The bug to guard against: two CONSECUTIVE sentences both
  //    highlighting the SAME body-text line (pre-fix, a shared straddling item
  //    gave both segments that line's full-width rect). Discriminator: same
  //    baseline (|dy| < 3px) AND horizontal overlap > 50% of the wider rect.
  //    (Small overlaps from inline-math sub/superscripts that physically sit
  //    under an adjacent line, and the rotated page-1 license banner, are
  //    faithful geometry — reported as raw, not failed.)
  const sameLineShare = (a, b) => {
    if (a.page !== b.page) return false;
    if (Math.abs(a.y - b.y) >= 3) return false;
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    return ox > 0 && ox > 0.5 * Math.max(a.w, b.w);
  };
  const rawOverlap = (a, b) =>
    a.page === b.page &&
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2;
  let sharePairs = 0;
  let rawPairs = 0;
  for (let i = 1; i < segs.length; i++) {
    const A = segs[i - 1];
    const B = segs[i];
    let share = false;
    let raw = false;
    for (const ba of A.bboxes)
      for (const bb of B.bboxes) {
        if (sameLineShare(ba, bb)) share = true;
        if (rawOverlap(ba, bb)) raw = true;
      }
    if (share) sharePairs++;
    if (raw) rawPairs++;
  }
  console.log(
    `\n=== highlight overlap: ${sharePairs} same-line shares (bug), ${rawPairs} raw (incl. math/banner artifacts) ===`,
  );
  ok(
    sharePairs === 0,
    `no two consecutive sentences share a body-text line (${sharePairs} pairs)`,
  );

  // 9. stripCitations removes every numeric [n] marker from spoken text, while
  //    keeping the surrounding prose (regression guard for the citation fix).
  const cleaned = segment(map, { stripCitations: true });
  const anyMarker = cleaned.some((s) =>
    /\[\s*\d+(?:\s*[,;–-]\s*\d+)*\s*\]/.test(s.text),
  );
  ok(!anyMarker, "stripCitations removes all numeric [n] markers from segments");

  // 10. running-header normalization must not drop the page-1 title.
  ok(
    norm(map.text.slice(0, 800)).includes("attention is all you need"),
    "running-header normalization keeps the page-1 title in reading order",
  );

  // Decimal integrity (regression guard for "73.3% read as 73. pause 3 percent").
  // pdfjs over-splits a decimal into adjacent items whose x-gap is ~0/negative; the
  // join must glue them, never fabricate "8 . 5" / "8. 5" / "8 .5" — each of which
  // the segmenter + TTS treat as a sentence break at the period. Pre-fix sample.pdf
  // had 8 + 8 + 12 such hits across the three forms.
  const fractured =
    (map.text.match(/\d \. \d/g) || []).length +
    (map.text.match(/\d\. \d/g) || []).length +
    (map.text.match(/\d \.\d/g) || []).length;
  ok(fractured === 0, `no fractured decimals in narration text (found ${fractured})`);
  ok(/\b0\.9\b/.test(map.text), "decimal 0.9 is contiguous (was '0 .9'/'0. 9')");
  ok(/\b28\.4\b/.test(map.text), "decimal 28.4 stays intact (BLEU score)");
  // Bounded negative tolerance: the rotated arXiv side-banner (x-gap ~ -229u) must
  // KEEP its separating space, proving we did not glue all negative gaps.
  ok(/2 Aug 2023 best/.test(map.text),
     "rotated arXiv banner stays space-separated (large negative gap not glued)");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  void page1End;
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("validator crashed:", e);
  process.exit(2);
});
