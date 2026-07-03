// One rendered PDF page: canvas + pdfjs TextLayer + highlight overlay, all
// sharing ONE viewport (PLAN §5.3, §5.4, §10.3).
//
// - Canvas is rendered at devicePixelRatio for crispness; its CSS size matches
//   the viewport so the text layer and highlight overlay line up exactly.
// - The text layer is built with `new TextLayer({...}).render()` (the modern
//   API — `renderTextLayer` is deprecated). After render each text <span> is
//   stamped with `data-page` + `data-source-item-index` so a click maps back to
//   the original `getTextContent().items` index the CharMap understands.
// - Click-to-read uses `caretRangeFromPoint` (→ caretPositionFromPoint → an
//   x-binary-search fallback) to find (sourceItemIndex, charInItem), then
//   `charMap.spanToOffset(...)` → `onSeekToOffset(offset)`.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { BBox, CharMap, PdfDoc } from "@/lib/pdf/types";
import HighlightLayer, { type ViewportLike } from "./HighlightLayer";

const { TextLayer } = pdfjs;

interface PdfPageProps {
  doc: PdfDoc;
  /** 1-based page number. */
  pageNumber: number;
  /** CSS scale (the same value used to size the virtualized row). */
  scale: number;
  charMap?: CharMap | null;
  /** Current-segment boxes (PDF user space); filtered to this page internally. */
  bboxes?: BBox[];
  onSeekToOffset?: (offset: number) => void;
  className?: string;
}

const STYLE_ID = "rpar-pdf-styles";

/** Inject the (idempotent) text-layer + highlight CSS once. Adapted from the
 *  canonical pdfjs `.textLayer` rules so spans position correctly, render
 *  transparent (glyphs live on the canvas) and stay selectable/clickable. */
function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.rpar-page { position: relative; }
.rpar-textLayer {
  position: absolute; inset: 0; overflow: clip; opacity: 1; line-height: 1;
  text-align: initial; -webkit-text-size-adjust: none; text-size-adjust: none;
  forced-color-adjust: none; transform-origin: 0 0; z-index: 1;
  caret-color: transparent;
}
.rpar-textLayer :is(span, br) {
  color: transparent; position: absolute; white-space: pre; cursor: text;
  transform-origin: 0% 0%; margin: 0;
}
.rpar-textLayer span.markedContent { top: 0; height: 0; }
.rpar-textLayer ::selection { background: rgba(45, 212, 191, 0.35); }
.rpar-hl-layer { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.rpar-hl {
  position: absolute;
  background: var(--highlight-fill, rgba(245, 178, 82, 0.22));
  box-shadow: 0 0 0 1px var(--highlight-border, #f5b252);
  border-radius: 3px;
  animation: rpar-hl-in 180ms ease-out;
  will-change: opacity;
}
@keyframes rpar-hl-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .rpar-hl { animation: none; } }
.rpar-page canvas { transition: filter 160ms ease-out; }
.rpar-dark .rpar-page canvas { filter: invert(0.93) hue-rotate(180deg); }
.rpar-dark .rpar-page { box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.07); border-radius: 2px; }
@media (prefers-reduced-motion: reduce) { .rpar-page canvas { transition: none; } }
`;
  document.head.appendChild(el);
}

/** Fallback when caret APIs are unavailable: binary-search the char boundary in
 *  a span's text node whose right edge first passes the click x. */
function charOffsetByX(span: HTMLElement, clientX: number): number {
  const node = span.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return 0;
  const len = node.textContent?.length ?? 0;
  if (len === 0) return 0;
  const range = document.createRange();
  let lo = 0;
  let hi = len;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(node, 0);
    range.setEnd(node, Math.min(mid, len));
    if (range.getBoundingClientRect().right < clientX) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  charMap,
  bboxes,
  onSeekToOffset,
  className,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<ViewportLike | null>(null);

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    if (!scale || scale <= 0) return;
    let cancelled = false;
    let renderTask: { promise: Promise<unknown>; cancel?: () => void } | null = null;
    let textLayer: { render(): Promise<unknown>; cancel?: () => void; textDivs: HTMLElement[] } | null =
      null;

    (async () => {
      const page: any = await doc.getPage(pageNumber);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      setViewport(vp);

      // --- canvas (DPR-correct) ---
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.floor(vp.width);
      const cssH = Math.floor(vp.height);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const renderParams: any = { canvasContext: ctx, viewport: vp };
      if (dpr !== 1) renderParams.transform = [dpr, 0, 0, dpr, 0, 0];
      renderTask = page.render(renderParams);
      try {
        await renderTask!.promise;
      } catch (err: any) {
        if (err?.name === "RenderingCancelledException") return;
        throw err;
      }
      if (cancelled) return;

      // --- text layer (shares the SAME viewport) ---
      const container = textRef.current;
      if (!container) return;
      container.replaceChildren();
      // pdfjs sizes the container + glyph metrics off this CSS var (= scale).
      container.style.setProperty("--scale-factor", String(scale));
      const content: any = await page.getTextContent();
      if (cancelled) return;
      textLayer = new (TextLayer as any)({
        textContentSource: content,
        container,
        viewport: vp,
      });
      await textLayer!.render();
      if (cancelled) {
        textLayer!.cancel?.();
        return;
      }

      // Stamp each span with its ORIGINAL getTextContent().items index. pdfjs
      // emits exactly one div per item whose `str` is defined (marked-content
      // entries have no `str` and produce no div) — the same filter extract.ts
      // used to assign `sourceItemIndex`, so the indices line up.
      const divs = textLayer!.textDivs;
      let di = 0;
      const items: any[] = content.items;
      for (let s = 0; s < items.length; s++) {
        if (items[s]?.str === undefined) continue;
        const div = divs[di++];
        if (div) {
          div.dataset.page = String(pageNumber);
          div.dataset.sourceItemIndex = String(s);
        }
      }
    })().catch((e) => {
      if (!cancelled) console.error(`[PdfPage] page ${pageNumber} render failed`, e);
    });

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel?.();
      } catch {
        /* already settled */
      }
      try {
        textLayer?.cancel?.();
      } catch {
        /* already settled */
      }
    };
  }, [doc, pageNumber, scale]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!charMap || !onSeekToOffset) return;
      const x = e.clientX;
      const y = e.clientY;
      const d: any = document;
      let span: HTMLElement | null = null;
      let charInItem = 0;

      if (typeof d.caretRangeFromPoint === "function") {
        const range = d.caretRangeFromPoint(x, y);
        if (range) {
          const n = range.startContainer as Node;
          span = (n.nodeType === Node.TEXT_NODE ? n.parentElement : n) as HTMLElement;
          charInItem = range.startOffset;
        }
      } else if (typeof d.caretPositionFromPoint === "function") {
        const pos = d.caretPositionFromPoint(x, y);
        if (pos) {
          const n = pos.offsetNode as Node;
          span = (n.nodeType === Node.TEXT_NODE ? n.parentElement : n) as HTMLElement;
          charInItem = pos.offset;
        }
      }

      // Climb to the stamped text span if the caret landed on a child node.
      while (
        span &&
        span !== textRef.current &&
        span.dataset?.sourceItemIndex === undefined
      ) {
        span = span.parentElement;
      }

      // Fallback: hit-test the point, then x-binary-search within that span.
      if (!span || span.dataset?.sourceItemIndex === undefined) {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        span = (el?.closest?.("[data-source-item-index]") as HTMLElement | null) ?? null;
        if (span) charInItem = charOffsetByX(span, x);
      }
      if (!span || span.dataset?.sourceItemIndex === undefined) return;

      const page = Number(span.dataset.page);
      const sourceItemIndex = Number(span.dataset.sourceItemIndex);
      const offset = charMap.spanToOffset(page, sourceItemIndex, charInItem);
      onSeekToOffset(offset);
    },
    [charMap, onSeekToOffset],
  );

  const pageBoxes = (bboxes ?? []).filter((b) => b.page === pageNumber);

  return (
    <div className={`rpar-page ${className ?? ""}`.trim()}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div ref={textRef} className="rpar-textLayer" onClick={handleClick} />
      {viewport && <HighlightLayer bboxes={pageBoxes} viewport={viewport} />}
    </div>
  );
}

export default memo(PdfPage);
