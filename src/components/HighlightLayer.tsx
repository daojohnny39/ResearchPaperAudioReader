// Spoken-sentence highlight overlay (PLAN §5.3, §6, §10.3).
//
// Renders absolutely-positioned amber rects over the rendered page for the
// current segment's boxes. Boxes arrive in PDF user space and are converted to
// CSS px through the EXACT SAME pdfjs viewport the canvas + text layer were
// rendered with (PLAN §10.3), so the highlight is always pixel-aligned with the
// glyphs — rotation / cropbox / DPR are all handled by that shared viewport.
//
// Reduced-motion is honoured via the injected CSS (`@media (prefers-reduced-
// motion: reduce)` disables the entrance crossfade — see PdfPage's style block).

import { memo } from "react";
import type { BBox } from "@/lib/pdf/types";

/** Structural view of the bits of a pdfjs PageViewport we use. */
export interface ViewportLike {
  width: number;
  height: number;
  convertToViewportRectangle(rect: number[]): number[];
}

interface HighlightLayerProps {
  /** Current-segment boxes for THIS page, in PDF user space. */
  bboxes: BBox[];
  /** The same pdfjs PageViewport used for the canvas + text layer. */
  viewport: ViewportLike;
}

function HighlightLayer({ bboxes, viewport }: HighlightLayerProps) {
  if (!bboxes || bboxes.length === 0) return null;

  const rects = bboxes.map((b) => {
    // convertToViewportRectangle flips PDF (bottom-left origin) → viewport
    // (top-left) space and applies scale + rotation. Result corners can come
    // back in either order, so normalise to min/max.
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([
      b.x,
      b.y,
      b.x + b.w,
      b.y + b.h,
    ]);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    // A 2px breathing margin so the tint hugs the line without clipping glyphs.
    return {
      left: left - 2,
      top: top - 1,
      width: width + 4,
      height: height + 2,
    };
  });

  return (
    <div className="rpar-hl-layer" aria-hidden="true">
      {rects.map((r, i) => (
        <div
          key={i}
          className="rpar-hl"
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
          }}
        />
      ))}
    </div>
  );
}

export default memo(HighlightLayer);
