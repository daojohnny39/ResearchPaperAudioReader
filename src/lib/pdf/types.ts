// Core PDF data shapes (PLAN §4 frozen contracts + §10.2 source-span mapping).
//
// The CharMap is the bridge between the rendered PDF and the narration:
// every PdfTextItem keeps BOTH its `sourceItemIndex` (the order pdfjs returns
// items in `getTextContent()`, which is what the rendered TextLayer divs map
// to) and a `readingOrderIndex` (after column-aware sorting). Each output char
// in `CharMap.text` is contributed by exactly one source item via its
// [charStart, charEnd) range, so highlight + click-to-read survive cleanup.

/** A box in PDF user space (origin bottom-left), tagged with its 1-based page. */
export interface BBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfTextItem {
  str: string;
  /** Offset into `CharMap.text` where this item's chars begin; -1 if skipped. */
  charStart: number;
  /** Offset into `CharMap.text` one past this item's last char; -1 if skipped. */
  charEnd: number;
  bbox: BBox;
  /** Alias of `sourceItemIndex` kept for the frozen §4 contract. */
  itemIndex: number;
  /** Index in the page's original `getTextContent().items` array. */
  sourceItemIndex: number;
  /** Index after column-aware reading-order sort. */
  readingOrderIndex: number;
  /** Visual line number within the page (0-based, top→bottom per column). */
  line: number;
}

export interface PageLayout {
  /** 1-based page number. */
  page: number;
  /** Unscaled page width (PDF units, scale 1). */
  width: number;
  /** Unscaled page height (PDF units, scale 1). */
  height: number;
  /**
   * Text items in original source order — a *dense subset* of the page's
   * `getTextContent().items` (marked-content / transform-less entries dropped),
   * so this is NOT positionally indexable by `sourceItemIndex`. Resolve a
   * clicked span via `CharMap.spanToOffset(page, sourceItemIndex, …)`, which
   * looks the item up by its `sourceItemIndex`, not by array position.
   */
  items: PdfTextItem[];
}

export interface PdfDoc {
  numPages: number;
  /** The underlying pdfjs `PDFDocumentProxy`. */
  raw: unknown;
  getPage(n: number): Promise<unknown>;
}

export interface CharMap {
  /** Full ordered document text (reading order, cleanup applied). */
  text: string;
  pages: PageLayout[];
  /** Boxes (merged per line) covering chars in [start, end). */
  rangeToBBoxes(start: number, end: number): BBox[];
  /** 1-based page containing `offset` (nearest item if offset is a joiner). */
  offsetToPage(offset: number): number;
  /**
   * Map a clicked span → narration text offset. `itemIndex` is the span's
   * `sourceItemIndex` (the value PdfPage stamps on each TextLayer div as
   * `data-source-item-index`); `charInItem` is the caret offset within it.
   */
  spanToOffset(page: number, itemIndex: number, charInItem: number): number;
}
