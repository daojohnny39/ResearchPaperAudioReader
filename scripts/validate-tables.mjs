// Validation harness for the TABLE-SKIP feature (.work/table-skip-plan.md,
// "Files to change" item #5). Runs the *real* buildCharMap() from
// src/lib/pdf/extract.ts against the committed 2-column arXiv fixture
// (Attention Is All You Need) twice — once with table-skipping OFF (baseline)
// and once ON (skipped) — and asserts that the ruled-table grids are dropped
// from the narration text while prose + captions are preserved.
//
//   node --experimental-strip-types scripts/validate-tables.mjs
//
// Mirrors scripts/validate-extract.mjs exactly: it uses the pdfjs *legacy* node
// build to construct a PdfDoc (the app's loader.ts uses a Vite-bundled worker
// that can't run under bare node), constructs the {numPages, raw, getPage}
// PdfDoc shim, reuses the ok()/norm() helpers, and process.exit()s non-zero on
// any failed assertion so it can gate CI alongside validate-extract.mjs.
//
// buildCharMap signature exercised here (per plan item #1):
//   buildCharMap(pdfDoc, { skipTables?: boolean } = {})   // default false
// validate-extract.mjs calls buildCharMap(doc) (no opts) and must stay green;
// this script passes the opts object explicitly.
//
// TODO (recommended follow-up — out of this end-to-end script's scope): add
// SYNTHETIC operator-list UNIT tests for the pure band-detection helpers in
// extract.ts (extractHRules / clusterAndBand / lineInBand). They should not need
// a real PDF and should cover:
//   - the constructPath args shape `[ops, coords, minMax]` (read only [0],[1]);
//   - rectangle subop emitting BOTH horizontal edges (top + bottom of tall frames);
//   - CTM tracking across save/restore AND paintFormXObjectBegin/End matrices
//     (rules that live inside a Form XObject must transform into page space);
//   - rotated-page fail-open (page.rotate % 360 !== 0 -> zero bands, nothing skipped);
//   - paint-commit gating (clip/endPath geometry must NOT form a band; only
//     stroke/fill PAINT ops commit pending rules).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildCharMap } from "../src/lib/pdf/extract.ts";

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

  // Build both narration strings from the SAME document. Baseline keeps the
  // table grids; skipped drops them.
  const baseline = await buildCharMap(pdfDoc, { skipTables: false });
  const skipped = await buildCharMap(pdfDoc, { skipTables: true });

  const baseNorm = norm(baseline.text);
  const skipNorm = norm(skipped.text);

  console.log(`\n=== doc: ${doc.numPages} pages ===`);
  console.log(
    `baseline (skipTables:false): ${baseline.text.length} chars\n` +
      `skipped  (skipTables:true):  ${skipped.text.length} chars\n` +
      `delta: ${baseline.text.length - skipped.text.length} chars dropped ` +
      `(${(
        (1 - skipped.text.length / Math.max(1, baseline.text.length)) *
        100
      ).toFixed(1)}%)`,
  );

  // ---------------------------------------------------------------------------
  // 1. BASELINE must CONTAIN the table-cell tokens. If these are missing from
  //    the baseline the fixture/extraction changed and the skip assertions below
  //    would pass vacuously — so guard the baseline first.
  //    - "Self-Attention (restricted)" : a Table 1 row label.
  //    - "GNMT + RL" + 40.46           : a Table 2 model name (left column-half) +
  //                                      a right column-half EN-FR BLEU score.
  //    - 93.3                          : Table 4 (full-width on a single-col page).
  //
  //    NOTE on token choice: the Table 2 grid is verified via "GNMT + RL" and
  //    "40.46" rather than "ByteNet"/"28.4". The latter two are NOT grid-unique —
  //    "ByteNet" also appears in the page-2 Introduction prose ("...the Extended
  //    Neural GPU [16], ByteNet [18] and ConvS2S [9]...") and "28.4" appears in the
  //    page-1 Abstract prose ("Our model achieves 28.4 BLEU on the WMT 2014..."),
  //    neither of which sits inside any ruling-line band. No correct table-skipper
  //    (including the validated reference .work/bandprobe2.mjs) can — or should —
  //    drop those prose mentions, so asserting their absence would contradict this
  //    script's own "abstract/Introduction prose preserved" assertions below.
  //    "GNMT + RL" (left half) and "40.46" (right half) occur ONLY in the Table 2
  //    grid, so they are sound proxies for "the full-width 2-column grid was
  //    dropped from both halves".
  // ---------------------------------------------------------------------------
  ok(
    baseNorm.includes(norm("Self-Attention (restricted)")),
    'baseline contains Table 1 cell "Self-Attention (restricted)"',
  );
  ok(baseNorm.includes(norm("GNMT + RL")), 'baseline contains Table 2 cell "GNMT + RL"');
  ok(/\b40\.46\b/.test(baseline.text), "baseline contains Table 2 BLEU score 40.46");
  ok(/\b93\.3\b/.test(baseline.text), "baseline contains Table 4 number 93.3");

  // ---------------------------------------------------------------------------
  // 2. SKIPPED must NOT contain any of those table-cell tokens — the ruled grids
  //    are dropped from narration. Covers the full-width 2-column Table 2 (both
  //    column-halves: the "GNMT + RL" left half + the right-half EN-FR score 40.46).
  // ---------------------------------------------------------------------------
  ok(
    !skipNorm.includes(norm("Self-Attention (restricted)")),
    'skipped drops Table 1 cell "Self-Attention (restricted)"',
  );
  ok(!skipNorm.includes(norm("GNMT + RL")), 'skipped drops Table 2 cell "GNMT + RL"');
  ok(!/\b40\.46\b/.test(skipped.text), "skipped drops Table 2 BLEU score 40.46");
  ok(!/\b93\.3\b/.test(skipped.text), "skipped drops Table 4 number 93.3");

  // ---------------------------------------------------------------------------
  // 3. SKIPPED must STILL CONTAIN prose + captions — only the grids go.
  //    - abstract opening (also asserted by validate-extract.mjs);
  //    - an Introduction clause (validate-extract.mjs's `intro` constant);
  //    - the Table 2 CAPTION (captions sit outside the rule band and are read).
  // ---------------------------------------------------------------------------
  ok(
    skipNorm.includes(norm("the dominant sequence transduction models are based on")),
    "skipped keeps the abstract opening prose",
  );
  ok(
    skipNorm.includes(norm("recurrent neural networks, long short-term memory")),
    "skipped keeps the Introduction opening clause",
  );
  ok(
    skipNorm.includes(norm("Table 2: The Transformer achieves better BLEU")),
    "skipped keeps the Table 2 caption (captions are read, only grids dropped)",
  );

  // ---------------------------------------------------------------------------
  // 4. NO OVER-REACH sanity bound: narration shrinks only modestly. A runaway
  //    band swallowing whole pages of prose would trip this.
  // ---------------------------------------------------------------------------
  ok(
    skipped.text.length > 0.7 * baseline.text.length,
    `skipped text length (${skipped.text.length}) > 70% of baseline ` +
      `(${(0.7 * baseline.text.length).toFixed(0)}) — no runaway band`,
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("validator crashed:", e);
  process.exit(2);
});
