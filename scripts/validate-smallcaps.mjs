// Deterministic regression guard for gap-aware inter-item spacing in
// buildCharMap (src/lib/pdf/extract.ts). PDF-INDEPENDENT: it drives the real
// buildCharMap with a hand-built mock PdfDoc, so it pins the exact behavior the
// small-caps fix relies on without needing any committed fixture.
//
//   node scripts/validate-smallcaps.mjs
//
// Root cause it guards against: a research PDF typesets product names in
// small-caps; pdfjs emits each as a full-size leading cap run + a smaller-cap
// remainder run sitting horizontally TOUCHING. The old unconditional inter-item
// space turned "Cursor" -> "C URSOR", "Claude Code" -> "C LAUDE C ODE", which
// the TTS then spelled out. The fix only inserts a separator when the gap to the
// next run exceeds ~0.15em, so touching fragments glue back into one word.

import { buildCharMap } from "../src/lib/pdf/extract.ts";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// One mock text item. transform = [a,b,c,d,e,f]; extract.ts reads x=e, y=f, and
// height fallback = |d|, but we pass width/height explicitly to match real pdfjs.
function item(str, x, y, w, h) {
  return { str, transform: [h, 0, 0, h, x, y], width: w, height: h, hasEOL: false };
}
function mockDoc(items, width = 612, height = 792) {
  const page = {
    getViewport: () => ({ width, height }),
    getTextContent: async () => ({ items }),
  };
  return { numPages: 1, getPage: async () => page };
}

async function main() {
  // y descends down the page; each line is a distinct scenario.
  const items = [
    // Line A — small-caps "Cursor": body run ending in the full-size leading
    // cap "C", then the small-cap remainder "URSOR" essentially touching it
    // (gap 0.4u), then a real whitespace item, then the next word.
    item("with C", 100, 700, 30, 10),
    item("URSOR", 130.4, 700, 26, 7), // gap = 130.4 - (100+30) = 0.4 -> glue
    item(" ", 156.4, 700, 3, 7), // explicit space item -> exactly one space
    item("next.", 160, 700, 24, 10),

    // Line B — a REAL positional word gap with no whitespace item: must stay a
    // space.
    item("foo", 100, 650, 20, 10),
    item("bar.", 125, 650, 24, 10), // gap = 125 - (100+20) = 5 -> space

    // Line C — overlapping / negative gap (stand-in for RTL/rotated runs whose
    // x-advance sign is unreliable): must KEEP the separator (no worse than old).
    item("AB", 100, 600, 20, 10),
    item("CD.", 110, 600, 24, 10), // gap = 110 - (100+20) = -10 -> keep space

    // Line D — multi-fragment small-caps "Claude Code": C+LAUDE (glue), real
    // word space, C+ODE (glue) -> "Anthropic's CLAUDE CODE".
    item("Anthropic's C", 60, 550, 60, 10),
    item("LAUDE", 120.3, 550, 24, 7), // gap 0.3 -> glue
    item(" ", 144.3, 550, 3, 7), // word space
    item("C", 148, 550, 6, 10),
    item("ODE", 154.1, 550, 14, 7), // gap = 154.1 - (148+6) = 0.1 -> glue
  ];

  const map = await buildCharMap(mockDoc(items));
  console.log("text => " + JSON.stringify(map.text));

  // 1. Small-caps word glued (THE bug): no spurious internal space.
  ok(!/C URSOR/.test(map.text), "no spurious space inside small-caps 'Cursor'");
  ok(/with CURSOR/.test(map.text), "small-caps leading cap glued: 'with CURSOR'");

  // 2. Multi-fragment small-caps glued, real word space preserved.
  ok(/Anthropic's CLAUDE CODE/.test(map.text), "'Claude Code' glued to 'CLAUDE CODE'");
  ok(!/C LAUDE|C ODE/.test(map.text), "no spurious space inside 'CLAUDE'/'CODE'");

  // 3. Explicit whitespace item still yields exactly one space (no double).
  ok(/with CURSOR next\./.test(map.text), "explicit space item -> one space before 'next.'");

  // 4. Real positional gap (no space item) still inserts a space.
  ok(/foo bar\./.test(map.text), "positional word gap is preserved as a space");

  // 5. Negative/overlap gap keeps the separator (RTL/rotated fallback).
  ok(/AB CD\./.test(map.text), "overlapping/negative gap retains the separator");

  // 6. Offsets exact: each mapped item's [charStart,charEnd) covers its glyphs,
  //    and spanToOffset round-trips. (Source-span invariant unbroken.)
  const ursor = map.pages[0].items.find((it) => it.str === "URSOR");
  ok(!!ursor, "found the 'URSOR' source item");
  ok(
    !!ursor && map.text.slice(ursor.charStart, ursor.charEnd) === "URSOR",
    "URSOR item range covers exactly its glyphs",
  );
  ok(
    !!ursor && map.spanToOffset(1, ursor.sourceItemIndex, 0) === ursor.charStart,
    "spanToOffset(1, URSOR) round-trips to its charStart",
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("validator crashed:", e);
  process.exit(2);
});
