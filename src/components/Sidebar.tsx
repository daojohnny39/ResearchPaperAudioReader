// Sidebar — collapsible outline / segment list = "choose where to start"
// (PLAN §1, §6: 280px panel, collapses to an icon rail). Clicking a segment
// seeks the player there. Shows overall reading progress and voice/speed quick
// info. The active row is highlighted and auto-scrolled into view (not
// color-only — a11y per §6).

import { useEffect, useMemo, useRef } from "react";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import type { Segment } from "@/lib/text/segment";
import { useReaderStore } from "@/lib/store/useReaderStore";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  /** Seek the player to a segment (click-to-start). */
  onSelectSegment: (index: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  className?: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function Sidebar({
  onSelectSegment,
  collapsed,
  onToggleCollapse,
  className,
}: SidebarProps) {
  const segments = useReaderStore((s) => s.segments);
  const status = useReaderStore((s) => s.status);
  const currentIndex = useReaderStore((s) => s.currentIndex);
  const progress = useReaderStore((s) => s.progress);
  const voiceId = useReaderStore((s) => s.voiceId);
  const voices = useReaderStore((s) => s.voices);
  const rate = useReaderStore((s) => s.rate);

  const activeRef = useRef<HTMLButtonElement>(null);

  const voiceLabel = useMemo(
    () => voices.find((v) => v.id === voiceId)?.label ?? "Default voice",
    [voices, voiceId],
  );

  const total = segments.length;
  const percent = Math.round(progress * 100);

  // Keep the active row visible as narration advances.
  useEffect(() => {
    if (collapsed) return;
    activeRef.current?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [currentIndex, collapsed]);

  if (collapsed) {
    return (
      <aside
        className={cn(
          "bg-surface border-border flex h-full w-12 shrink-0 flex-col items-center gap-3 border-r py-3",
          className,
        )}
        aria-label="Outline (collapsed)"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onToggleCollapse}
              aria-label="Expand outline"
            >
              <PanelLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Expand outline</TooltipContent>
        </Tooltip>
        <div
          className="text-muted-foreground text-[10px] tabular-nums"
          aria-hidden
        >
          {percent}%
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "bg-surface border-border flex h-full w-[280px] shrink-0 flex-col border-r",
        className,
      )}
      aria-label="Outline"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium">Outline</h2>
          {total > 0 && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {total}
            </span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onToggleCollapse}
              aria-label="Collapse outline"
            >
              <PanelLeftClose />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Collapse outline</TooltipContent>
        </Tooltip>
      </div>

      {/* Overall progress */}
      <div className="px-4 pb-3">
        <div className="text-muted-foreground mb-1.5 flex items-center justify-between text-xs tabular-nums">
          <span>
            {total ? currentIndex + 1 : 0} of {total}
          </span>
          <span>{percent}%</span>
        </div>
        <Progress value={percent} aria-label="Overall reading progress" />
      </div>

      <Separator />

      {/* Segment list */}
      <ScrollArea className="min-h-0 flex-1">
        {total === 0 ? (
          <div
            className="text-muted-foreground px-4 py-6 text-center text-sm"
            role="status"
            aria-live="polite"
          >
            {status === "parsing"
              ? "Preparing outline…"
              : "No sentences in this document."}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5 p-2">
            {segments.map((seg: Segment) => {
              const active = seg.index === currentIndex;
              return (
                <li key={seg.index}>
                  <button
                    ref={active ? activeRef : undefined}
                    type="button"
                    onClick={() => onSelectSegment(seg.index)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      // A left accent bar marks the active row by shape + position
                      // (not colour alone) — works alongside aria-current and the
                      // auto-scroll cue for a11y (PLAN §6).
                      "focus-visible:ring-ring/50 relative flex w-full gap-2 rounded-md py-1.5 pr-2 pl-3 text-left text-sm outline-none transition-colors focus-visible:ring-3",
                      active
                        ? "bg-accent text-accent-foreground ring-primary/40 ring-1 before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary before:content-['']"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "w-6 shrink-0 pt-px text-right text-xs tabular-nums",
                        active
                          ? "text-primary font-medium"
                          : "text-muted-foreground/60",
                      )}
                    >
                      {seg.index + 1}
                    </span>
                    <span className="line-clamp-2 leading-snug">{seg.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>

      <Separator />

      {/* Voice / speed quick info */}
      <div className="text-muted-foreground flex items-center justify-between px-4 py-3 text-xs">
        <span className="truncate" title={voiceLabel}>
          {voiceLabel}
        </span>
        <span className="shrink-0 tabular-nums">{rate.toFixed(2)}×</span>
      </div>
    </aside>
  );
}
