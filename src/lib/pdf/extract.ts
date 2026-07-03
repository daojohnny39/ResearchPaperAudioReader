// buildCharMap(pdfDoc): extract every page's text, order it column-aware
// (PLAN §5.1), build the ordered narration string while recording a back-pointer
// from each output char to its source text item (PLAN §5.2 / §10.2), and expose
// range→bbox / offset→page / span→offset queries used by highlight + click.

import type { BBox, CharMap, PageLayout, PdfDoc, PdfTextItem } from "./types";

interface RawItem {
  str: string;
  /** PDF-space bbox (origin bottom-left). */
  x: number;
  y: number;
  w: number;
  h: number;
  sourceItemIndex: number;
  hasEOL: boolean;
}

/** Group items on one page into visual lines by baseline proximity. */
interface Line {
  y: number; // representative baseline
  items: RawItem[];
}

function detectColumns(items: RawItem[], pageWidth: number): RawItem[][] {
  if (items.length < 8) return [items];
  const mid = pageWidth / 2;
  const left: RawItem[] = [];
  const right: RawItem[] = [];
  for (const it of items) {
    const xMid = it.x + it.w / 2;
    if (xMid < mid) left.push(it);
    else right.push(it);
  }
  // Treat as two columns only when both sides hold a real share of the text and
  // few items straddle the centre band (typical 2-column arXiv layout).
  const total = items.length;
  const minor = Math.min(left.length, right.length);
  const band = pageWidth * 0.06;
  const straddlers = items.filter(
    (it) => Math.abs(it.x + it.w / 2 - mid) < band,
  ).length;
  if (minor / total > 0.18 && straddlers / total < 0.25) {
    return [left, right];
  }
  return [items];
}

function groupLines(items: RawItem[]): Line[] {
  if (items.length === 0) return [];
  const medianH =
    items.map((i) => i.h).sort((a, b) => a - b)[Math.floor(items.length / 2)] ||
    10;
  const tol = Math.max(2, medianH * 0.5);
  // Sort top→bottom (PDF y grows upward, so descending y), then left→right.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) {
      last.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  for (const ln of lines) ln.items.sort((a, b) => a.x - b.x);
  return lines;
}

function lineText(ln: Line): string {
  return ln.items
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Heuristic running header/footer + bare-page-number detector (PLAN §5.1).
 * Flags the top-most / bottom-most line text on each page if it repeats across
 * many pages or is just a page number.
 */
// Strip a leading ("2 Author…") or trailing ("Title 3") page number so a
// page-numbered running head (LNCS etc.) collapses to one repeating key across
// pages instead of looking unique per page.
function normEdge(t: string): string {
  return t
    .toLowerCase()
    .replace(/^\s*\d{1,4}\s+/, "")
    .replace(/\s+\d{1,4}\s*$/, "")
    .trim();
}

function findRepeatedEdges(pageLines: Line[][]): Set<string> {
  const tally = new Map<string, number>();
  const note = (t: string) => {
    const key = normEdge(t);
    // Only tally information-bearing keys (must contain a letter and be long
    // enough); pure page numbers / punctuation residue (e.g. "5 ." -> ".") are
    // handled separately by BARE_NUMBER at skip time.
    if (key.length >= 4 && /[a-z]/i.test(key))
      tally.set(key, (tally.get(key) || 0) + 1);
  };
  for (const lines of pageLines) {
    if (lines.length === 0) continue;
    note(lineText(lines[0]));
    note(lineText(lines[lines.length - 1]));
  }
  const threshold = Math.max(3, Math.ceil(pageLines.length * 0.4));
  const repeated = new Set<string>();
  for (const [t, n] of tally) if (n >= threshold) repeated.add(t);
  return repeated;
}

const BARE_NUMBER = /^[\s\-–—]*\d{1,4}[\s\-–—]*$/;

// A caption line (Table/Figure/Listing/Algorithm N…) is read normally even when it
// falls inside a ruling-line band — captions sit just outside or atop the rules and
// describe the skipped grid, so they stay in the narration.
const CAPTION = /^(table|figure|fig\.?|listing|algorithm)\s*\.?\s*\d/i;

// ── Table / ruled-region detection (PLAN §10; ported from .work/bandprobe2.mjs) ──
// Tables and framed code/figure listings in research PDFs are delimited by
// horizontal vector ruling lines (booktabs \toprule/\midrule/\bottomrule, \hline,
// or box frames). Those rules live in the page operator list as vector graphics,
// independent of text content. We extract the horizontal rules, cluster them by
// shared x-extent, form vertical bands between consecutive rules, gate each band on
// table-like content, then (in Pass 2) skip any text line whose baseline+x falls
// inside a surviving band — exactly the way running headers/footers are skipped
// (reading order assigned, but no characters contributed to CharMap.text).
//
// ENGINE-AGNOSTIC OPS PIN: extract.ts must NOT import "pdfjs-dist" — loader.ts uses
// a Vite-only bundled build, and the node validator (scripts/validate-extract.mjs)
// builds its own PdfDoc against the legacy build. pdfjs's numeric OPS codes are
// stable in the pinned 4.10.38, so we pin the verified values locally rather than
// importing pdfjs.OPS (which would break the node validator).
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  constructPath: 91,
} as const;

// PAINT ops commit pending rule geometry to the rule list; clip/endPath discard it.
// Geometry alone is not paint — this stops clip rectangles / abandoned subpaths
// from forming false bands.
const PAINT_OPS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);
const DISCARD_OPS = new Set<number>([OPS.clip, OPS.eoClip, OPS.endPath]);

// 2-D affine matrix multiply / point apply (PDF transform matrices, [a b c d e f]).
function matMul(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function matApply(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A near-horizontal ruling line in scale-1 page space (origin bottom-left). */
interface HRule {
  y: number;
  x0: number;
  x1: number;
}

/** A vertical band [yBot,yTop] × [xMin,xMax] in scale-1 page space. */
interface Band {
  xMin: number;
  xMax: number;
  yTop: number;
  yBot: number;
}

/**
 * Walk the operator list, maintaining a CTM stack (save/restore, transform, and
 * Form XObject begin/end — table rules frequently live inside Form XObjects).
 * Collect near-horizontal (|Δy|<1.2), wide (Δx > 0.12·pageWidth) line/rectangle
 * edges into a `pending` buffer, and commit them to the rule list only on a PAINT
 * op. Coordinates map user-space → scale-1 page space (the same space as text item
 * transforms t[4],t[5]). In 4.10.38, constructPath args = [ops, coords, minMax] —
 * we read only [0],[1].
 */
function extractHRules(opList: any, pageWidth: number): HRule[] {
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const rules: HRule[] = [];
  let pending: HRule[] = [];
  const minW = 0.12 * pageWidth;
  const fnArray: number[] = opList.fnArray;
  const argsArray: any[] = opList.argsArray;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm.slice());
    } else if (fn === OPS.restore) {
      if (stack.length) ctm = stack.pop()!;
    } else if (fn === OPS.transform) {
      ctm = matMul(ctm, a);
    } else if (fn === OPS.paintFormXObjectBegin) {
      // push + apply the XObject matrix (args[0]) when it is a 6-length array.
      stack.push(ctm.slice());
      if (Array.isArray(a) && Array.isArray(a[0]) && a[0].length === 6)
        ctm = matMul(ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      if (stack.length) ctm = stack.pop()!;
    } else if (fn === OPS.constructPath) {
      const ops: number[] = a[0];
      const coords: number[] = a[1]; // a[2] (minMax) ignored
      if (!Array.isArray(ops) || !Array.isArray(coords)) continue;
      let ci = 0;
      let cx = 0;
      let cy = 0;
      let sx = 0;
      let sy = 0;
      for (const sub of ops) {
        if (sub === OPS.moveTo) {
          cx = coords[ci++];
          cy = coords[ci++];
          sx = cx;
          sy = cy;
        } else if (sub === OPS.lineTo) {
          const nx = coords[ci++];
          const ny = coords[ci++];
          const [ax, ay] = matApply(ctm, cx, cy);
          const [bx, by] = matApply(ctm, nx, ny);
          if (Math.abs(ay - by) < 1.2 && Math.abs(bx - ax) > minW)
            pending.push({
              y: (ay + by) / 2,
              x0: Math.min(ax, bx),
              x1: Math.max(ax, bx),
            });
          cx = nx;
          cy = ny;
        } else if (sub === OPS.curveTo) {
          ci += 6;
          cx = coords[ci - 2];
          cy = coords[ci - 1];
        } else if (sub === OPS.curveTo2 || sub === OPS.curveTo3) {
          ci += 4;
          cx = coords[ci - 2];
          cy = coords[ci - 1];
        } else if (sub === OPS.closePath) {
          cx = sx;
          cy = sy;
        } else if (sub === OPS.rectangle) {
          const rx = coords[ci++];
          const ry = coords[ci++];
          const rw = coords[ci++];
          const rh = coords[ci++];
          // Transform all 4 corners; emit BOTH horizontal edges (handles tall
          // frames where only the top/bottom rules matter).
          const c = [
            matApply(ctm, rx, ry),
            matApply(ctm, rx + rw, ry),
            matApply(ctm, rx + rw, ry + rh),
            matApply(ctm, rx, ry + rh),
          ];
          const edges = [
            [c[0], c[1]],
            [c[3], c[2]],
          ]; // bottom edge, top edge
          for (const [p0, p1] of edges)
            if (
              Math.abs(p0[1] - p1[1]) < 1.2 &&
              Math.abs(p1[0] - p0[0]) > minW
            )
              pending.push({
                y: (p0[1] + p1[1]) / 2,
                x0: Math.min(p0[0], p1[0]),
                x1: Math.max(p0[0], p1[0]),
              });
          cx = rx;
          cy = ry;
        }
      }
    } else if (PAINT_OPS.has(fn)) {
      if (pending.length) {
        rules.push(...pending);
        pending = [];
      }
    } else if (DISCARD_OPS.has(fn)) {
      pending = [];
    }
  }
  return rules;
}

/**
 * Restrict the line to the band's x-range; "prose" iff it has enough alpha-words,
 * is not numeric-dominated, and is horizontally contiguous (no big internal gap).
 * Per Codex review the terminal-punctuation requirement is dropped: the data-loss
 * asymmetry means we err toward recognizing prose (a multi-word table header may
 * occasionally be read aloud, which is strictly preferable to swallowing a
 * period-less caption/heading between two same-width ruled regions).
 */
function isProseGapLine(ln: Line, xMin: number, xMax: number): boolean {
  const its = ln.items.filter((it) => it.x + it.w > xMin && it.x < xMax);
  if (!its.length) return false;
  const txt = its
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (txt.match(/[A-Za-z]{2,}/g) || []).length;
  const digits = (txt.match(/\d/g) || []).length;
  const alpha = (txt.match(/[A-Za-z]/g) || []).length;
  if (words < 8) return false;
  if (digits >= 3 && digits >= alpha) return false; // numeric data row
  const hs = its.map((i) => i.h).sort((a, b) => a - b);
  const em = hs[hs.length >> 1] || 10;
  for (let k = 1; k < its.length; k++)
    if (its[k].x - (its[k - 1].x + its[k - 1].w) > 1.5 * em) return false; // gappy header
  return true; // contiguous long alpha line = prose / caption
}

/**
 * Dedupe near-identical rules (booktabs draws each rule twice), cluster by shared
 * x-extent (running-mean representative — separates stacked tables of different
 * widths), then form bands between consecutive rules within each x-group (require
 * ≥2 rules), splitting at any inter-rule gap that encloses a prose line OR exceeds
 * 0.4·pageHeight (large-gap backstop). `fullLines` feeds the prose-gap test.
 */
function clusterAndBand(
  rules: HRule[],
  fullLines: Line[],
  pageHeight: number,
): Band[] {
  // dedupe (same y within ~2 and same x0/x1 within ~4)
  const ded: HRule[] = [];
  for (const s of rules)
    if (
      !ded.some(
        (d) =>
          Math.abs(d.y - s.y) < 2 &&
          Math.abs(d.x0 - s.x0) < 4 &&
          Math.abs(d.x1 - s.x1) < 4,
      )
    )
      ded.push(s);
  // cluster by shared x-extent (match against running group min/max)
  const groups: { x0: number; x1: number; ys: number[] }[] = [];
  for (const s of ded) {
    let g = groups.find(
      (gr) => Math.abs(gr.x0 - s.x0) <= 10 && Math.abs(gr.x1 - s.x1) <= 10,
    );
    if (!g) {
      g = { x0: s.x0, x1: s.x1, ys: [] };
      groups.push(g);
    }
    g.ys.push(s.y);
    g.x0 = (g.x0 + s.x0) / 2; // sturdier running-mean representative extent
    g.x1 = (g.x1 + s.x1) / 2;
  }
  const bands: Band[] = [];
  const BIG_GAP = 0.4 * pageHeight;
  for (const g of groups) {
    const ys = [...new Set(g.ys.map((y) => +y.toFixed(1)))].sort(
      (a, b) => b - a,
    );
    if (ys.length < 2) continue;
    let segStart = 0;
    const flush = (s: number, e: number) => {
      if (e > s)
        bands.push({ xMin: g.x0, xMax: g.x1, yTop: ys[s], yBot: ys[e] });
    };
    for (let i = 0; i < ys.length - 1; i++) {
      const top = ys[i];
      const bot = ys[i + 1];
      const proseGap = fullLines.some(
        (ln) =>
          ln.y < top - 1 &&
          ln.y > bot + 1 &&
          isProseGapLine(ln, g.x0 - 4, g.x1 + 4),
      );
      const bigGap = top - bot > BIG_GAP;
      if (proseGap || bigGap) {
        flush(segStart, i);
        segStart = i + 1;
      }
    }
    flush(segStart, ys.length - 1);
  }
  return bands;
}

/**
 * Center-majority membership (NOT raw range-overlap, per Codex review): a line is in
 * a band when its baseline is within PAD_Y of the band AND ≥60% of its item centers
 * (x + w/2) fall inside the band's x-range. Keeps adjacent-column prose at the same
 * baseline out of a single-column-width table band.
 */
function lineInBand(ln: Line, b: Band): boolean {
  const PAD_Y = 2;
  const PAD_X = 4;
  if (ln.y < b.yBot - PAD_Y || ln.y > b.yTop + PAD_Y) return false;
  const inside = ln.items.filter((it) => {
    const cx = it.x + it.w / 2;
    return cx >= b.xMin - PAD_X && cx <= b.xMax + PAD_X;
  }).length;
  return inside >= Math.max(1, Math.ceil(ln.items.length * 0.6));
}

/**
 * CONTENT GATE: keep a band only if it holds ≥2 text lines (by lineInBand) AND ≥1
 * non-prose (short/numeric/gappy) line. Rejects spurious single-line bands (e.g. a
 * decorative rule pair around the page-1 title) and all-prose framed paragraphs.
 */
function bandHasTable(b: Band, columnLines: Line[]): boolean {
  const inside = columnLines.filter((ln) => lineInBand(ln, b));
  if (inside.length < 2) return false;
  const nonProse = inside.filter(
    (ln) => !isProseGapLine(ln, b.xMin - 4, b.xMax + 4),
  ).length;
  return nonProse >= 1;
}

export async function buildCharMap(
  pdfDoc: PdfDoc,
  opts: { skipTables?: boolean } = {},
): Promise<CharMap> {
  const pages: PageLayout[] = [];
  const perPageRaw: RawItem[][] = [];
  const perPageLines: Line[][] = [];
  const perPageSize: { w: number; h: number }[] = [];
  // Ruling-line table/listing bands per page (empty unless opts.skipTables).
  const perPageBands: Band[][] = [];

  // Pass 1 — pull raw items + line structure for every page.
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page: any = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const raw: RawItem[] = [];
    content.items.forEach((item: any, srcIdx: number) => {
      // pdfjs marked-content items have no transform; skip them.
      if (typeof item.str !== "string" || !item.transform) return;
      const t = item.transform as number[];
      const x = t[4];
      const y = t[5];
      const w = item.width ?? 0;
      const h = item.height ?? (Math.abs(t[3]) || 10);
      raw.push({
        str: item.str,
        x,
        y,
        w,
        h,
        sourceItemIndex: srcIdx,
        hasEOL: !!item.hasEOL,
      });
    });
    perPageRaw.push(raw);
    perPageSize.push({ w: vp.width, h: vp.height });
    // Column + line ordering for this page.
    const cols = detectColumns(raw, vp.width);
    const orderedLines: Line[] = [];
    for (const col of cols) orderedLines.push(...groupLines(col));
    perPageLines.push(orderedLines);

    // Ruling-line band detection (ONLY when skipTables). Runs on the SAME
    // column-split line stream Pass 2 uses, so a table in one column is skipped
    // while adjacent-column prose at the same baseline stays readable. Per-page
    // try/catch fails open to zero bands — a malformed operator list (or a
    // rotated page) must never block opening the document.
    let bands: Band[] = [];
    if (opts.skipTables) {
      try {
        if ((page.rotate || 0) % 360 === 0) {
          const opList = await page.getOperatorList();
          const rules = extractHRules(opList, vp.width);
          bands = clusterAndBand(rules, orderedLines, vp.height).filter((b) =>
            bandHasTable(b, orderedLines),
          );
        }
        // rotated page → leave bands = [] (fail open)
      } catch {
        bands = []; // fail open on ANY error
      }
    }
    perPageBands.push(bands);
  }

  const repeatedEdges = findRepeatedEdges(perPageLines);

  // Pass 2 — build the ordered narration text + per-item char ranges.
  let text = "";
  // Flat index for offset→page / range queries, sorted by charStart.
  const flat: PdfTextItem[] = [];
  let pendingDehyphen = false; // previous line ended with a soft hyphen
  // Track the last EMITTED (non-skipped) line so an ordinary single-line wrap
  // (join with a space — sentence continues) can be told apart from a real
  // paragraph / column / page break (join with "\n" — a hard sentence boundary
  // for Intl.Segmenter). Joining every wrapped line with "\n" was making the
  // sentence segmenter break per visual line → line-by-line narration.
  let prevLineY: number | null = null;
  let prevLinePage = 0;

  for (let p = 0; p < perPageLines.length; p++) {
    const lines = perPageLines[p];
    const size = perPageSize[p];
    // Paragraph-break thresholds for THIS page. medianH = typical glyph height;
    // medianGap = typical baseline-to-baseline leading (robust to loose/tight
    // line spacing). A downward gap above paraGap, an upward jump beyond colTol
    // (new column), or a page change is treated as a hard break.
    const heights = perPageRaw[p]
      .map((r) => r.h)
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    const medianH = heights.length ? heights[heights.length >> 1] : 10;
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const d = lines[i - 1].y - lines[i].y;
      if (d > 0 && d < medianH * 4) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[gaps.length >> 1] : medianH * 1.2;
    const paraGap = Math.max(medianH * 1.6, medianGap * 1.5);
    const colTol = medianH * 0.5;
    // Per-page item table indexed by sourceItemIndex (for click → offset).
    const items: PdfTextItem[] = perPageRaw[p].map((r) => ({
      str: r.str,
      charStart: -1,
      charEnd: -1,
      bbox: { page: p + 1, x: r.x, y: r.y, w: r.w, h: r.h },
      itemIndex: r.sourceItemIndex,
      sourceItemIndex: r.sourceItemIndex,
      readingOrderIndex: -1,
      line: -1,
    }));
    const bySrc = new Map<number, PdfTextItem>();
    for (const it of items) bySrc.set(it.sourceItemIndex, it);

    let readingOrder = 0;
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      const txt = lineText(ln);
      const isEdge = li === 0 || li === lines.length - 1;
      // Inside a ruling-line table/listing band? (center-majority test.) A caption
      // line (Table/Figure/… N) inside a band is rescued — read normally.
      const bands = perPageBands[p];
      const inBand = bands.length > 0 && bands.some((b) => lineInBand(ln, b));
      // A confirmed running-header/footer key (repeated as a page edge ≥threshold
      // times) is skipped wherever it lands — on some pages the page number
      // splits onto its own line, pushing the header text to a non-edge line.
      // BARE_NUMBER stays edge-only (a lone number mid-body is real content).
      const skipLine =
        repeatedEdges.has(normEdge(txt)) ||
        (isEdge && BARE_NUMBER.test(txt)) ||
        txt.length === 0 ||
        (inBand && !CAPTION.test(txt)); // ruled table/listing band (caption rescued)

      if (skipLine) {
        // Still assign reading order so click mapping can fall back, but the
        // items contribute no characters (charStart stays -1).
        for (const r of ln.items) {
          const it = bySrc.get(r.sourceItemIndex)!;
          it.readingOrderIndex = readingOrder++;
          it.line = li;
        }
        // A skipped header/footer breaks textual adjacency: drop any pending
        // soft-hyphen join so it can't glue onto the next emitted line.
        pendingDehyphen = false;
        continue;
      }

      if (pendingDehyphen && text.endsWith("-")) {
        text = text.slice(0, -1); // drop the soft hyphen, join words
        const lastFlat = flat[flat.length - 1];
        if (lastFlat) lastFlat.charEnd = text.length;
      } else if (text.length > 0) {
        // Ordinary wrapped line → space (sentence continues across the wrap);
        // real paragraph / column / page break → "\n" (hard sentence boundary).
        const page = p + 1;
        const isBreak =
          prevLineY === null ||
          prevLinePage !== page || // page change
          prevLineY - ln.y < -colTol || // moved UP = new column/block
          prevLineY - ln.y > paraGap; // large vertical gap = new paragraph
        text += isBreak ? "\n" : " ";
      }
      pendingDehyphen = false;

      for (let k = 0; k < ln.items.length; k++) {
        const r = ln.items[k];
        const it = bySrc.get(r.sourceItemIndex)!;
        it.readingOrderIndex = readingOrder++;
        it.line = li;
        const piece = r.str;
        // Skip pure-whitespace items but keep ordering.
        if (piece.trim().length === 0) {
          if (!text.endsWith(" ") && !text.endsWith("\n")) text += " ";
          continue;
        }
        it.charStart = text.length;
        text += piece;
        it.charEnd = text.length;
        flat.push(it);
        // Intra-line separator unless the piece already ends in whitespace.
        // pdfjs over-splits a single word into adjacent runs when the font
        // changes mid-word (small-caps: a full-size leading cap + a smaller-cap
        // remainder; ligatures; sub/superscripts). Those fragments sit
        // horizontally TOUCHING, so the old unconditional space turned
        // "Cursor" -> "C URSOR" and the narrator spelled the lone leading cap.
        // SUPPRESS the separator for a confidently touching horizontal fragment:
        // a gap from a small bounded negative overlap up to ~0.15em. Genuine word
        // spaces are either their own whitespace items (handled above) or a clearly
        // larger positional gap; a LARGE negative gap (RTL/rotated/overlapping runs
        // such as the arXiv side-banner, where the x-advance sign is unreliable)
        // stays below -overlapTol and falls through to the default space.
        const nextExists = k < ln.items.length - 1;
        if (nextExists && !/\s$/.test(piece)) {
          const next = ln.items[k + 1];
          const gap = next.x - (r.x + r.w);
          // Threshold ~0.15em (glyph height ~= font size); floor guards tiny
          // fonts. Stays below a real positional word space (~0.25em) and above
          // the ~0-0.5u intra-word over-split gaps.
          const scale = Math.min(r.h, next.h);
          const glueThreshold = Math.max(0.5, 0.15 * scale);
          // Admit a small NEGATIVE overlap as well: pdfjs reports the boundary
          // between a digit and a decimal point (and small-caps fragments) with a
          // ~0 or slightly-negative x-gap from font-metric rounding, so a strict
          // `gap >= 0` re-fractured decimals into "8 . 5" / "8. 5". The narrator
          // then read "eight" + a sentence pause + "five percent". A LARGE negative
          // gap is a rotated/overlapping/mis-grouped run (e.g. the arXiv side-banner
          // at ~ -229u), so keep the separating space there.
          const overlapTol = Math.max(0.5, 0.1 * scale);
          const touching =
            Number.isFinite(gap) && gap >= -overlapTol && gap <= glueThreshold;
          if (!touching) text += " ";
        }
      }

      // Soft-hyphen handoff to the next line.
      const trimmed = text.replace(/\s+$/, "");
      if (/[^\s]-$/.test(trimmed)) {
        // Only dehyphenate if the next line begins lowercase (checked lazily).
        const next = lines[li + 1];
        const nextTxt = next ? lineText(next) : "";
        if (nextTxt && /^[a-z]/.test(nextTxt)) {
          // normalise trailing whitespace so the hyphen is the last char
          if (text !== trimmed) {
            text = trimmed;
            const lastFlat = flat[flat.length - 1];
            if (lastFlat && lastFlat.charEnd > text.length)
              lastFlat.charEnd = text.length;
          }
          pendingDehyphen = true;
        }
      }

      // Remember this emitted line for the next iteration's break decision.
      prevLineY = ln.y;
      prevLinePage = p + 1;
    }

    pages.push({ page: p + 1, width: size.w, height: size.h, items });
  }

  // Per-page lookup from sourceItemIndex → item. `pages[p].items` is a *dense*
  // subset of the original `getTextContent().items` (marked-content entries are
  // dropped), so it is NOT positionally indexable by sourceItemIndex — clicks
  // arrive carrying a sourceItemIndex (the value stamped on the TextLayer div)
  // and must be resolved through this map, not by array position.
  const pageBySrc: Map<number, PdfTextItem>[] = pages.map((pl) => {
    const m = new Map<number, PdfTextItem>();
    for (const it of pl.items) m.set(it.sourceItemIndex, it);
    return m;
  });

  // Sort the flat index by charStart for binary search.
  flat.sort((a, b) => a.charStart - b.charStart);
  const starts = flat.map((i) => i.charStart);

  function lowerBound(target: number): number {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (starts[m] < target) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  const map: CharMap = {
    text,
    pages,

    rangeToBBoxes(start: number, end: number): BBox[] {
      if (end <= start) return [];
      // Collect overlapping items, grouped by (page, line) → merged rect.
      const byLine = new Map<string, { page: number; rect: BBox }>();
      // Start scan a little before the lower bound to catch items straddling.
      let i = Math.max(0, lowerBound(start) - 2);
      for (; i < flat.length; i++) {
        const it = flat[i];
        if (it.charStart >= end) break;
        if (it.charEnd <= start) continue;
        // Clip the item's horizontal extent to the part of it inside [start,end).
        // A single PDF text item can straddle a sentence boundary (one chunk
        // holds the end of one sentence and the start of the next); without
        // clipping BOTH sentences would highlight the whole shared line. char->x
        // is linear-interpolated within the item (uniform-width approximation;
        // assumes unrotated LTR text, which the highlight overlay already does).
        const b = it.bbox;
        const len = it.charEnd - it.charStart;
        let cx = b.x;
        let cw = b.w;
        if (len > 0) {
          const f0 = Math.max(0, (start - it.charStart) / len);
          const f1 = Math.min(1, (end - it.charStart) / len);
          cx = b.x + b.w * f0;
          cw = b.w * (f1 - f0);
        }
        if (cw <= 0) continue;
        const key = `${it.bbox.page}:${it.line}`;
        const existing = byLine.get(key);
        if (!existing) {
          byLine.set(key, {
            page: it.bbox.page,
            rect: { page: b.page, x: cx, y: b.y, w: cw, h: b.h },
          });
        } else {
          const r = existing.rect;
          const x0 = Math.min(r.x, cx);
          const y0 = Math.min(r.y, b.y);
          const x1 = Math.max(r.x + r.w, cx + cw);
          const y1 = Math.max(r.y + r.h, b.y + b.h);
          r.x = x0;
          r.y = y0;
          r.w = x1 - x0;
          r.h = y1 - y0;
        }
      }
      return [...byLine.values()].map((v) => v.rect);
    },

    offsetToPage(offset: number): number {
      if (flat.length === 0) return 1;
      let idx = lowerBound(offset);
      if (idx >= flat.length) idx = flat.length - 1;
      // Prefer an item whose range contains the offset.
      for (const cand of [idx, idx - 1, idx + 1]) {
        const it = flat[cand];
        if (it && it.charStart <= offset && offset < it.charEnd)
          return it.bbox.page;
      }
      const it = flat[Math.min(Math.max(idx, 0), flat.length - 1)];
      return it ? it.bbox.page : 1;
    },

    // `itemIndex` is the clicked span's `sourceItemIndex` (the value stamped on
    // the TextLayer div by PdfPage), resolved via the per-page source map.
    spanToOffset(page: number, itemIndex: number, charInItem: number): number {
      const pl = pages[page - 1];
      const bySrc = pageBySrc[page - 1];
      if (!pl || !bySrc) return 0;
      const it = bySrc.get(itemIndex);
      if (it && it.charStart >= 0) {
        const within = Math.max(
          0,
          Math.min(charInItem, it.charEnd - it.charStart),
        );
        return it.charStart + within;
      }
      // Skipped/whitespace item (e.g. a stripped header line): fall back to the
      // nearest mapped item on the page by reading order so a click still lands
      // somewhere sensible.
      const ro = it ? it.readingOrderIndex : itemIndex;
      let best: PdfTextItem | null = null;
      for (const cand of pl.items) {
        if (cand.charStart < 0) continue;
        if (
          !best ||
          Math.abs(cand.readingOrderIndex - ro) <
            Math.abs(best.readingOrderIndex - ro)
        ) {
          best = cand;
        }
      }
      return best ? best.charStart : 0;
    },
  };

  return map;
}
