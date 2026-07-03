// Library — the landing view (PLAN §1, §6): a big DropZone plus the recent
// papers list (title, % read, last opened). Clicking a recent resumes it at the
// saved position. Recents come from the store (populated from plugin-store by
// App on mount); open/resume are delegated upward so App owns the load pipeline.

import { useMemo } from "react";
import { AudioLines, Clock, FileText } from "lucide-react";
import type { RecentDoc } from "@/persist/progress";
import { useReaderStore } from "@/lib/store/useReaderStore";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import DropZone from "./DropZone";

export interface LibraryProps {
  /** Open a freshly chosen PDF (from drop or Browse). */
  onOpenFile: (bytes: Uint8Array, fileName: string, path: string | null) => void;
  /** Resume a recent document at its saved position. */
  onOpenRecent: (doc: RecentDoc) => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} yr ago`;
}

export default function Library({ onOpenFile, onOpenRecent }: LibraryProps) {
  const recents = useReaderStore((s) => s.recents);
  const sorted = useMemo(
    () => [...recents].sort((a, b) => b.updatedAt - a.updatedAt),
    [recents],
  );

  return (
    <div className="bg-background flex h-full w-full flex-col items-center overflow-auto">
      <div className="flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
        {/* Brand */}
        <header className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-xl">
            <AudioLines className="size-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Research Paper Audio Reader
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Listen to any paper read aloud, with the spoken sentence
              highlighted as you follow along.
            </p>
          </div>
        </header>

        {/* Drop target */}
        <DropZone onFile={onOpenFile} />

        {/* Recents */}
        <section className="flex min-h-0 flex-col gap-3">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Recent papers
          </h2>

          {sorted.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm">
              No papers yet — drop a PDF above to get started.
            </p>
          ) : (
            <ScrollArea className="max-h-80">
              <ul className="flex flex-col gap-2 pr-2">
                {sorted.map((doc: RecentDoc) => (
                  <li key={doc.hash}>
                    <button
                      type="button"
                      onClick={() => onOpenRecent(doc)}
                      className="bg-surface border-border hover:border-muted-foreground/40 hover:bg-surface-2 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-3"
                    >
                      <span className="bg-surface-2 text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <FileText className="size-4.5" aria-hidden />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="text-foreground truncate text-sm font-medium">
                            {doc.title || "Untitled paper"}
                          </span>
                          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                            <Clock className="size-3" aria-hidden />
                            {relativeTime(doc.updatedAt)}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Progress
                            value={doc.percent}
                            className="h-1 flex-1"
                            aria-label={`${doc.percent}% read`}
                          />
                          <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">
                            {doc.percent}%
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </section>
      </div>
    </div>
  );
}
