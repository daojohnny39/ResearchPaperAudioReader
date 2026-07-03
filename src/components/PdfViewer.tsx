// Virtualized vertical PDF page list (PLAN §5.3, §10.3).
//
// - Fits pages to the scroller width (ResizeObserver) and derives a single CSS
//   `scale` shared by every page so the canvas, text layer and highlight all use
//   one viewport.
// - Row heights are deterministic (pageHeight * scale + gap), so the
//   virtualizer's offsets are exact and auto-scroll can target a precise pixel.
// - Exposes the current segment (for the highlight + auto-scroll target) and an
//   `onSeekToOffset` callback bubbled up from click-to-read.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useVirtualizer,
  defaultRangeExtractor,
  type Range,
} from "@tanstack/react-virtual";
import type { BBox, CharMap, PdfDoc } from "@/lib/pdf/types";
import type { Segment } from "@/lib/text/segment";
import PdfPage from "./PdfPage";
import { useReaderStore, ZOOM_STEP } from "@/lib/store/useReaderStore";

export interface PageSize {
  width: number;
  height: number;
}

interface PdfViewerProps {
  doc: PdfDoc;
  pageSizes: PageSize[];
  charMap?: CharMap | null;
  /** Segment currently being spoken — drives highlight + auto-scroll. */
  currentSegment?: Segment | null;
  /** Click-to-read: narration offset under the click. */
  onSeekToOffset?: (offset: number) => void;
  className?: string;
}

const GAP = 16; // px gutter below each page
const PAD = 24; // px horizontal padding inside the scroller
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const NO_BOXES: BBox[] = [];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function PdfViewer({
  doc,
  pageSizes,
  charMap,
  currentSegment,
  onSeekToOffset,
  className,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const pdfTheme = useReaderStore((s) => s.pdfTheme);
  const zoom = useReaderStore((s) => s.zoom);

  // Measure the scroller width to fit pages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(w);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const maxPageWidth = useMemo(() => {
    let m = 0;
    for (const s of pageSizes) m = Math.max(m, s.width);
    return m || 612; // US-letter fallback
  }, [pageSizes]);

  const fitScale = useMemo(() => {
    if (containerWidth <= 0) return 0;
    return (containerWidth - PAD * 2) / maxPageWidth;
  }, [containerWidth, maxPageWidth]);

  const scale = useMemo(() => {
    if (containerWidth <= 0) return 0; // not measured yet
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitScale * zoom));
  }, [containerWidth, fitScale, zoom]);

  const contentWidth = scale > 0 ? maxPageWidth * scale : 0;
  const layoutWidth = Math.max(containerWidth, contentWidth + PAD * 2);

  const rowHeight = useCallback(
    (i: number) => {
      const h = pageSizes[i]?.height ?? maxPageWidth * 1.294; // ~letter ratio
      return Math.floor(h * scale) + GAP;
    },
    [pageSizes, scale, maxPageWidth],
  );

  // Deterministic prefix offsets (match the virtualizer's measurements exactly).
  const offsets = useMemo(() => {
    const arr = new Array<number>(doc.numPages + 1);
    arr[0] = 0;
    for (let i = 0; i < doc.numPages; i++) arr[i + 1] = arr[i] + rowHeight(i);
    return arr;
  }, [doc.numPages, rowHeight]);

  // Force-mount prev + current + next page so they're painting before the
  // (short, smooth) auto-scroll lands on them.
  const currentPageIndex = (currentSegment?.page ?? 1) - 1;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const cur = currentPageIndex;
      const forced = [cur - 1, cur, cur + 1];
      return Array.from(new Set([...defaultRangeExtractor(range), ...forced]))
        .filter((i) => i >= 0 && i < doc.numPages)
        .sort((a, b) => a - b);
    },
    [currentPageIndex, doc.numPages],
  );

  const virtualizer = useVirtualizer({
    count: doc.numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeight(i),
    overscan: 2,
    rangeExtractor,
  });

  // Re-measure when scale changes (estimateSize closure changed).
  useEffect(() => {
    if (scale > 0) virtualizer.measure();
  }, [scale, virtualizer]);

  // Auto-scroll to keep the spoken sentence visible (PLAN §1, §5.3).
  useEffect(() => {
    const seg = currentSegment;
    const el = scrollRef.current;
    if (!seg || !el || scale <= 0) return;
    const pageIndex = seg.page - 1;
    if (pageIndex < 0 || pageIndex >= doc.numPages) return;

    const raf = requestAnimationFrame(() => {
      const pageTop = offsets[pageIndex] ?? 0;
      const box = seg.bboxes.find((b) => b.page === seg.page);
      const size = pageSizes[pageIndex];
      const withinTop = box && size ? (size.height - (box.y + box.h)) * scale : 0;
      const highlightTop = pageTop + withinTop;
      const viewTop = highlightTop - el.scrollTop;
      const vh = el.clientHeight;
      // Already comfortably on screen — don't re-anchor (avoids per-sentence snap).
      if (viewTop >= vh * 0.12 && viewTop <= vh * 0.78) return;
      const target = Math.max(0, highlightTop - vh * 0.3);
      const reduced = prefersReducedMotion();
      const behavior =
        reduced || Math.abs(target - el.scrollTop) > vh * 1.5 ? "auto" : "smooth";
      el.scrollTo({ top: target, behavior });
    });
    return () => cancelAnimationFrame(raf);
    // Only re-run when the active segment changes (or layout scale changes),
    // never on every render — so we don't fight the user's manual scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSegment?.index, fitScale]);

  // Preserve the viewport-center anchor across a zoom-driven scale change so
  // content doesn't jump. Row heights scale ~linearly with `scale`, so scaling
  // scrollTop by the same ratio keeps roughly the same point centered. rAF defers
  // the write until after the new total height has committed (else it clamps).
  const prevScaleRef = useRef(scale);
  useEffect(() => {
    const el = scrollRef.current;
    const prev = prevScaleRef.current;
    prevScaleRef.current = scale;
    if (!el || prev <= 0 || scale <= 0 || prev === scale) return;
    const ratio = scale / prev;
    const center = el.scrollTop + el.clientHeight / 2;
    const target = Math.max(0, center * ratio - el.clientHeight / 2);
    const raf = requestAnimationFrame(() => {
      el.scrollTop = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [scale]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const st = useReaderStore.getState();
      st.setZoom(st.zoom * Math.exp(-e.deltaY * 0.002));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const st = useReaderStore.getState();
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        st.setZoom(st.zoom + ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        st.setZoom(st.zoom - ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        st.setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Per-page stable highlight boxes: only the 1–2 pages holding the current
  // segment get a changed array reference; all others keep the stable empty ref
  // (NO_BOXES), so memoized PdfPage/HighlightLayer don't re-render every page.
  const boxesByPage = useMemo(() => {
    const m = new Map<number, BBox[]>();
    const bxs = currentSegment?.bboxes;
    if (bxs)
      for (const b of bxs) {
        const arr = m.get(b.page);
        if (arr) arr.push(b);
        else m.set(b.page, [b]);
      }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSegment?.index]);

  const items = scale > 0 ? virtualizer.getVirtualItems() : [];

  return (
    <div
      ref={scrollRef}
      className={`relative h-full w-full overflow-auto bg-background ${
        pdfTheme === "dark" ? "rpar-dark" : ""
      } ${className ?? ""}`.trim()}
    >
      <div
        style={{
          height: scale > 0 ? offsets[doc.numPages] : "100%",
          width: layoutWidth,
          position: "relative",
        }}
      >
        {items.map((vi) => {
          const i = vi.index;
          // Each page gets only its own boxes (stable empty ref for pages the
          // current segment doesn't touch), so memoized subtrees stay put. A
          // sentence spanning a page break still highlights on both pages.
          const boxes = boxesByPage.get(i + 1) ?? NO_BOXES;
          return (
            <div
              key={vi.key}
              data-page-index={i}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
                height: rowHeight(i),
                display: "flex",
                justifyContent: "center",
              }}
            >
              <div style={{ paddingBottom: GAP }}>
                <PdfPage
                  doc={doc}
                  pageNumber={i + 1}
                  scale={scale}
                  charMap={charMap}
                  bboxes={boxes}
                  onSeekToOffset={onSeekToOffset}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
