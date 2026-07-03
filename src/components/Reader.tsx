// Reader — the split reading layout (PLAN §1, §2, §6).
//   ┌───────────────── header (title + back) ─────────────────┐
//   │ Sidebar (outline)  │            PdfViewer               │
//   └──────────────────── PlayerBar (transport) ──────────────┘
// Reads the active document + playback state from the store and drives the
// imperative PlayerController for transport, click-to-read and segment jumps.
// Final cross-module wiring (controller instance, engine/voice lifecycle) is
// completed in the Integrate phase; this component takes them as props.

import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, LoaderCircle, Moon, Sun, ZoomIn, ZoomOut } from "lucide-react";
import type { PlayerController } from "@/lib/player/controller";
import type { Segment } from "@/lib/text/segment";
import type { Voice } from "@/lib/tts/engine";
import { useReaderStore, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "@/lib/store/useReaderStore";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import PdfViewer from "./PdfViewer";
import Sidebar from "./Sidebar";
import PlayerBar from "./PlayerBar";

export interface ReaderProps {
  /** The imperative player instance (owned by App). */
  controller: PlayerController | null;
  /** Voice switch handler — App owns engine lifecycle (lazy Kokoro init/fallback). */
  onSelectVoice: (voice: Voice) => void;
  /** Background pre-warm of the Kokoro model (App-owned). */
  onPrewarmKokoro?: () => void;
  /** Return to the Library view. Defaults to the store's closeDoc(). */
  onClose?: () => void;
}

/** Nearest segment whose char range contains `offset` (falls back to the last
 *  segment starting at/before it, then 0) — used for click-to-read. */
function segmentIndexForOffset(segments: Segment[], offset: number): number {
  if (segments.length === 0) return 0;
  let candidate = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (offset >= s.charStart && offset < s.charEnd) return i;
    if (s.charStart <= offset) candidate = i;
    else break;
  }
  return candidate;
}

export default function Reader({
  controller,
  onSelectVoice,
  onPrewarmKokoro,
  onClose,
}: ReaderProps) {
  const doc = useReaderStore((s) => s.doc);
  const charMap = useReaderStore((s) => s.charMap);
  const segments = useReaderStore((s) => s.segments);
  const pageSizes = useReaderStore((s) => s.pageSizes);
  const currentIndex = useReaderStore((s) => s.currentIndex);
  const docTitle = useReaderStore((s) => s.docTitle);
  const status = useReaderStore((s) => s.status);
  const parseMessage = useReaderStore((s) => s.parseMessage);
  const closeDoc = useReaderStore((s) => s.closeDoc);
  const pdfTheme = useReaderStore((s) => s.pdfTheme);
  const setPdfTheme = useReaderStore((s) => s.setPdfTheme);
  const zoom = useReaderStore((s) => s.zoom);
  const setZoom = useReaderStore((s) => s.setZoom);
  const isDark = pdfTheme === "dark";

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const currentSegment = useMemo(
    () => segments[currentIndex] ?? null,
    [segments, currentIndex],
  );

  const handleClose = useCallback(() => {
    if (onClose) onClose();
    else closeDoc();
  }, [onClose, closeDoc]);

  // Click-to-read: PDF span click → narration offset → nearest segment → seek
  // and begin playing there (PLAN §5.4).
  const handleSeekToOffset = useCallback(
    (offset: number) => {
      if (!controller || segments.length === 0) return;
      const idx = segmentIndexForOffset(segments, offset);
      controller.seekToSegment(idx);
      controller.play();
    },
    [controller, segments],
  );

  // Sidebar "choose where to start": seek only, preserving the current play
  // state (PLAN §1).
  const handleSelectSegment = useCallback(
    (index: number) => {
      controller?.seekToSegment(index);
    },
    [controller],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="bg-background flex h-full w-full flex-col">
        {/* Header */}
        <header className="bg-surface border-border flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleClose}
                aria-label="Back to library"
              >
                <ArrowLeft />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Back to library</TooltipContent>
          </Tooltip>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={docTitle}>
            {docTitle || "Untitled paper"}
          </h1>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setZoom(zoom - ZOOM_STEP)}
                  disabled={zoom <= ZOOM_MIN}
                  aria-label="Zoom out"
                >
                  <ZoomOut />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Zoom out</TooltipContent>
            </Tooltip>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="text-muted-foreground hover:text-foreground w-12 rounded text-center text-xs tabular-nums focus-visible:ring-2 focus-visible:outline-none"
              aria-label="Reset zoom to fit width"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setZoom(zoom + ZOOM_STEP)}
                  disabled={zoom >= ZOOM_MAX}
                  aria-label="Zoom in"
                >
                  <ZoomIn />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Zoom in</TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={isDark ? "bg-muted text-foreground" : undefined}
                onClick={() => setPdfTheme(isDark ? "light" : "dark")}
                aria-label={isDark ? "Switch page to light mode" : "Switch page to dark mode"}
                aria-pressed={isDark}
              >
                {isDark ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{isDark ? "Light page" : "Dark page"}</TooltipContent>
          </Tooltip>
        </header>

        {/* Body: sidebar + pages */}
        <div className="flex min-h-0 flex-1">
          <Sidebar
            onSelectSegment={handleSelectSegment}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          />

          <main className="relative min-w-0 flex-1">
            {doc ? (
              <PdfViewer
                doc={doc}
                pageSizes={pageSizes}
                charMap={charMap}
                currentSegment={currentSegment}
                onSeekToOffset={handleSeekToOffset}
              />
            ) : (
              <div
                className="flex h-full flex-col items-center gap-5 overflow-hidden p-10"
                role="status"
                aria-live="polite"
              >
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  <span>
                    {status === "error"
                      ? "Couldn't open this paper."
                      : parseMessage || "Parsing paper…"}
                  </span>
                </div>
                {/* Page-shaped skeleton standing in for the paper while it
                    parses — reads as a document, not a blank box. */}
                <div className="bg-surface border-border w-full max-w-2xl space-y-3 rounded-lg border p-8 shadow-sm">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-4 w-2/5" />
                  <div className="h-3" aria-hidden />
                  {[96, 92, 98, 88, 94, 90, 70, 96, 86, 58].map((w, i) => (
                    <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>

        {/* Transport */}
        <PlayerBar
          controller={controller}
          onSelectVoice={onSelectVoice}
          onPrewarmKokoro={onPrewarmKokoro}
        />
      </div>
    </TooltipProvider>
  );
}
