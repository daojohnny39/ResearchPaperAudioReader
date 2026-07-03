// segment(map): split the ordered narration text into sentence segments using
// Intl.Segmenter (PLAN §5.7), keeping each segment's char range so the player
// can drive highlight + click. Optional, additive cleanup toggles (skipRefs,
// stripCitations, stripParentheticals) preserve the frozen `segment(map)` call
// form.
//
// SOURCE-SPAN MAPPING INVARIANT (PLAN §10.2):
//   Cleanup edits only the *derived* layer — the `text` we display/speak.
//   `charStart`/`charEnd` always stay tight bounds into the ORIGINAL
//   `CharMap.text`, so `map.rangeToBBoxes(charStart,charEnd)` and
//   `map.offsetToPage(charStart)` keep pointing back at the real source items.
//   That means stripping a `[12]` marker or a "(see Fig. 2)" aside shortens the
//   spoken string but never moves the highlight; the bbox for the segment still
//   covers its source span (including the visible citation/parenthetical on the
//   page, which is correct).

import type { BBox, CharMap } from "../pdf/types";

export interface Segment {
  index: number;
  text: string;
  /** Inclusive start offset into the ORIGINAL `CharMap.text`. */
  charStart: number;
  /** Exclusive end offset into the ORIGINAL `CharMap.text`. */
  charEnd: number;
  /** Primary page = page of `charStart` (segment may span pages via bboxes). */
  page: number;
  bboxes: BBox[];
}

export interface SegmentOptions {
  /**
   * Stop at a "References"/"Bibliography" heading and drop it + everything
   * after it (the reference list is the usual document tail). Default: false.
   */
  skipRefs?: boolean;
  /**
   * Remove `[12]` / `[1, 2]` / `[3-5]`-style numeric citation markers from the
   * spoken/displayed text (highlight bboxes are unaffected). Default: false.
   */
  stripCitations?: boolean;
  /**
   * Remove balanced parenthetical asides — "(see Fig. 2)", "(Smith et al.,
   * 2020)", "(i.e., foo)" — from the spoken/displayed text so the narrator reads
   * straight through the sentence with NO stop-then-restart around the aside.
   * Implemented by blanking balanced parens BEFORE sentence segmentation, so a
   * parenthetical that itself contains "." (e.g. "(cf. Fig. 2.)") can't fragment
   * one spoken sentence into two. Highlight bboxes are unaffected (the parens
   * stay visible on the page). Default: false.
   */
  stripParentheticals?: boolean;
}

// Standalone References/Bibliography heading at the start of a segment.
// The lookahead requires the heading word to be followed by end-of-segment, a
// citation bracket, or a digit (the reference list starting) — so prose like
// "References to prior work are common." (followed by a lowercase letter) does
// NOT match. Optional leading section number ("6 References") / roman numeral
// ("VI. References") is allowed. Tested against the citation-INTACT collapsed
// text so the `[` lookahead survives even when stripCitations is enabled.
const REF_HEADING =
  /^(?:\d{1,2}[.)]?\s+|[ivxlc]{1,6}[.)]\s+)?(?:references|bibliography|references and notes|literature cited|works cited)\b(?=\s*(?:$|[[\d]))/i;

// `[12]`, `[1, 2]`, `[1,2,3]`, `[3-5]`, `[12–15]` — numeric bracketed citations.
// Deliberately numeric-only: leaves `[i]`, `[Smith]`, `[*]` etc. untouched.
const CITATION_RE = /\[\s*\d+(?:\s*[,;–-]\s*\d+)*\s*\]/g;

/** Trim leading/trailing whitespace from a [start,end) range, returning the
 *  tightened bounds (or null if the slice is whitespace-only). */
function tighten(
  text: string,
  start: number,
  end: number,
): { s: number; e: number } | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) return null;
  return { s, e };
}

/** Remove numeric citation markers from an already-whitespace-collapsed string
 *  and tidy the punctuation/brackets they leave behind. */
function stripCitationMarkers(s: string): string {
  return s
    .replace(CITATION_RE, "")
    // A parenthetical that held only a citation now reads as a bare introducer,
    // e.g. "(see [12])" → "(see)" or "(e.g., [3])" → "(e.g.,)". Drop those.
    .replace(
      /\(\s*(?:see(?:\s+also)?|e\.?\s*g\.?|i\.?\s*e\.?|cf\.?|ref\.?)[\s.,;]*\)/gi,
      "",
    )
    .replace(/\(\s*\)/g, "") // empty () left by a citation-only parenthetical
    .replace(/\[\s*\]/g, "")
    .replace(/\s+([.,;:!?)\]])/g, "$1") // space stranded before punctuation
    .replace(/([([])\s+/g, "$1") // space stranded after an opening bracket
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Replace every BALANCED `(...)` span that looks like a genuine inline aside (the
 *  parens AND their contents, nested spans included) with equal-length runs of
 *  spaces. Length is preserved so every CharMap offset stays valid — the spoken
 *  text shrinks once whitespace is collapsed, but `charStart`/`charEnd` keep
 *  pointing at the real source items. UNMATCHED parens are left intact, so a stray
 *  "(" can never blank the rest of the document. Run BEFORE sentence segmentation:
 *  an aside that contains sentence punctuation (e.g. "(cf. Fig. 2.)") then can't
 *  split one spoken sentence into two fragments, which is what kept the narrator
 *  from skipping smoothly to the end of the sentence.
 *
 *  GUARD: a balanced span is only blanked when it is short (<= MAX_ASIDE_LEN) and
 *  contains no newline. A long or newline-crossing span is almost always a
 *  mis-paired opener whose true closer was dropped upstream — e.g. a figure-caption
 *  legend "(❶…❺)" whose markers + closer live inside the figure graphic that
 *  extract.ts skips. Without the guard, that lone "(" pairs with a ")" thousands of
 *  chars downstream and blanks every sentence boundary between them, collapsing a
 *  whole column into one giant "sentence" (a half-page highlight + skipped
 *  narration). Leaving such spans intact is the safe fail-open: at worst the
 *  narrator reads a rare long aside. Nested note: an inner short aside can still be
 *  blanked even when its enclosing (rejected) outer span is left intact — the guard
 *  decides per span, reading the ORIGINAL `text` so the decision is stable. */
// Max length (chars) of a balanced (...) treated as a blank-able inline aside. The
// Figure-2 runaway span is ~2500 chars (offset distance 2499); a genuine aside like
// "(see Fig. 2)" / "(cf. Fig. 2.)" is short. Refusing to blank a longer span just
// means it gets read aloud (safe); blanking a runaway erases a column of sentences.
const MAX_ASIDE_LEN = 200;

function blankBalancedParens(text: string): string {
  const chars = text.split("");
  const open: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "(") {
      open.push(i);
    } else if (c === ")" && open.length > 0) {
      const start = open.pop() as number;
      // Only blank a span that looks like a genuine inline aside (short, no
      // newline); a long / newline-crossing span is a mis-paired opener whose true
      // closer was dropped upstream — leave it (and its contents) intact.
      const span = text.slice(start, i + 1);
      if (span.length > MAX_ASIDE_LEN || span.includes("\n")) continue;
      for (let j = start; j <= i; j++) chars[j] = " ";
    }
  }
  return chars.join("");
}

export function segment(map: CharMap, opts: SegmentOptions = {}): Segment[] {
  const { text } = map;
  const out: Segment[] = [];
  if (!text) return out;

  // When stripping parentheticals, segment over a paren-blanked COPY of the text
  // (same length, so all offsets stay valid). Blanking before segmentation means
  // a "." inside an aside can't create a false sentence boundary, so the spoken
  // sentence stays whole and the narrator reads straight through the removed
  // aside. With the toggle off, this is exactly the original text.
  const speech = opts.stripParentheticals ? blankBalancedParens(text) : text;

  const Seg: any = (Intl as any).Segmenter;
  let ranges: { start: number; end: number }[];
  if (Seg) {
    const seg = new Seg(undefined, { granularity: "sentence" });
    ranges = [];
    for (const part of seg.segment(speech) as Iterable<{
      segment: string;
      index: number;
    }>) {
      ranges.push({
        start: part.index,
        end: part.index + part.segment.length,
      });
    }
  } else {
    // Fallback: naive sentence split on terminal punctuation.
    ranges = [];
    const re = /[^.!?]*[.!?]+(?=\s|$)|[^.!?]+$/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(speech))) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  let index = 0;
  for (const r of ranges) {
    // Tighten over `speech`: a leading/trailing blanked aside is whitespace here,
    // so it's trimmed off the range, and a wholly-parenthetical "sentence"
    // collapses to nothing and is dropped.
    const t = tighten(speech, r.start, r.end);
    if (!t) continue;

    // Whitespace-collapsed spoken form, taken from `speech` so blanked parens
    // vanish. Citations (`[...]`, untouched by paren-blanking) survive here so
    // the refs-heading test below still sees the bracket lookahead.
    const collapsed = speech.slice(t.s, t.e).replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;

    if (opts.skipRefs && REF_HEADING.test(collapsed)) {
      break; // drop the references section and everything after it
    }

    // Derived/spoken text. charStart/charEnd stay in ORIGINAL coordinates.
    let display = collapsed;
    if (opts.stripCitations) display = stripCitationMarkers(display);
    if (display.length === 0) continue; // e.g. a segment that was only "[12]."

    const page = map.offsetToPage(t.s);
    const bboxes = map.rangeToBBoxes(t.s, t.e);
    out.push({
      index: index++,
      text: display,
      charStart: t.s,
      charEnd: t.e,
      page,
      bboxes,
    });
  }

  return out;
}
