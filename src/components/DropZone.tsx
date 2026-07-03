// DropZone — the landing drop target (PLAN §1, §5.8, §10.4).
// dragDropEnabled is false in tauri.conf.json, so the WebView delivers native
// HTML5 drag/drop DOM events: we read the dropped file via file.arrayBuffer()
// (no path needed). The "Browse" button uses @tauri-apps/plugin-dialog → path →
// invoke('read_file_bytes') in Tauri, falling back to a hidden <input type=file>
// in a plain browser. Either way it emits the PDF bytes upward via onFile().

import { useCallback, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DropZoneProps {
  /** Emits the chosen PDF: raw bytes + display name + source path (null for drops). */
  onFile: (bytes: Uint8Array, fileName: string, path: string | null) => void;
  className?: string;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function isPdf(name: string, type?: string): boolean {
  return type === "application/pdf" || /\.pdf$/i.test(name);
}

export default function DropZone({ onFile, className }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readBlob = useCallback(
    async (file: File) => {
      if (!isPdf(file.name, file.type)) {
        toast.error("That file isn't a PDF.");
        return;
      }
      setBusy(true);
      try {
        const buf = await file.arrayBuffer();
        onFile(new Uint8Array(buf), file.name, null);
      } catch (e) {
        console.error("[DropZone] failed to read dropped file", e);
        toast.error("Couldn't read that file.");
      } finally {
        setBusy(false);
      }
    },
    [onFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void readBlob(file);
    },
    [readBlob],
  );

  const handleBrowse = useCallback(async () => {
    // Plain-browser fallback: trigger the hidden file input.
    if (!inTauri()) {
      inputRef.current?.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      setBusy(true);
      const bytes = await invoke<number[]>("read_file_bytes", { path });
      onFile(new Uint8Array(bytes), basename(path), path);
    } catch (e) {
      console.error("[DropZone] dialog/read failed", e);
      toast.error("Couldn't open that file.");
    } finally {
      setBusy(false);
    }
  }, [onFile]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the zone itself, not when crossing children.
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={handleDrop}
      aria-label="Drop a research paper PDF here, or use the Browse button"
      aria-busy={busy}
      className={cn(
        "group flex flex-col items-center justify-center gap-5 rounded-2xl border-2 border-dashed px-10 py-16 text-center transition-colors",
        dragging
          ? "border-primary bg-primary/5"
          : "border-border bg-surface/40 hover:border-muted-foreground/40",
        className,
      )}
    >
      <div
        className={cn(
          "flex size-16 items-center justify-center rounded-full transition-colors",
          dragging
            ? "bg-primary/15 text-primary"
            : "bg-surface-2 text-muted-foreground",
        )}
      >
        {busy ? (
          <Loader2 className="size-7 animate-spin" aria-hidden />
        ) : (
          <FileUp className="size-7" aria-hidden />
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-foreground text-lg font-medium">
          Drop a research paper PDF here
        </p>
        <p className="text-muted-foreground text-sm">
          or choose a file to start listening
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handleBrowse}
        disabled={busy}
        aria-label="Browse for a PDF"
      >
        Browse…
      </Button>

      {/* Browser fallback only; in Tauri the dialog plugin is used. */}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void readBlob(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
