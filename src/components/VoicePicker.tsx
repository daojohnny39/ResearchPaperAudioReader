// VoicePicker — grouped voice select (Kokoro / System) + speed control
// (PLAN §1 transport, §6 design, §10.1 voices/grades). Controlled component:
// it emits voice + rate changes upward and never touches the engine directly —
// the engine lifecycle (lazy Kokoro init, fallback) is owned by App/Integrate.
// The "Loading Kokoro voice…" indicator lives here, inline in the picker (§6).

import { useMemo } from "react";
import { Gauge, LoaderCircle } from "lucide-react";
import type { Voice } from "@/lib/tts/engine";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export interface VoicePickerProps {
  /** All selectable voices (Kokoro group first, then system) — store.voices. */
  voices: Voice[];
  /** Currently selected voice id — store.voiceId. */
  voiceId: string;
  /** Emits the chosen voice; App switches the engine + drives Kokoro init. */
  onSelectVoice: (voice: Voice) => void;
  /** Playback rate 0.75–2.0 — store.rate. */
  rate: number;
  onRateChange: (rate: number) => void;
  /** Kokoro model-load lifecycle — store.kokoroLoading / store.kokoroProgress. */
  kokoroLoading?: boolean;
  kokoroProgress?: number;
  /** Fired when the dropdown opens — App background-pre-warms the Kokoro model. */
  onPrewarmKokoro?: () => void;
  className?: string;
}

const RATE_MIN = 0.75;
const RATE_MAX = 2;

export default function VoicePicker({
  voices,
  voiceId,
  onSelectVoice,
  rate,
  onRateChange,
  kokoroLoading = false,
  kokoroProgress = 0,
  onPrewarmKokoro,
  className,
}: VoicePickerProps) {
  const { kokoro, system } = useMemo(() => {
    return {
      kokoro: voices.filter((v) => v.engine === "kokoro"),
      system: voices.filter((v) => v.engine === "webspeech"),
    };
  }, [voices]);

  const byId = useMemo(() => {
    const m = new Map<string, Voice>();
    for (const v of voices) m.set(v.id, v);
    return m;
  }, [voices]);

  function handleValueChange(id: string) {
    const v = byId.get(id);
    if (v) onSelectVoice(v);
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      {/* Voice select (grouped, with Kokoro grades) */}
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={voiceId || undefined}
          onValueChange={handleValueChange}
          onOpenChange={(open) => {
            if (open) onPrewarmKokoro?.(); // start the one-time model download on first open
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-[176px]"
            aria-label="Narration voice"
          >
            <SelectValue placeholder="Select voice" />
          </SelectTrigger>
          <SelectContent>
            {kokoro.length > 0 && (
              <SelectGroup>
                <SelectLabel>Kokoro · neural</SelectLabel>
                {kokoro.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate">{v.label}</span>
                      {v.grade && (
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {v.grade}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {system.length > 0 && (
              <SelectGroup>
                <SelectLabel>System · offline</SelectLabel>
                {system.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="truncate">{v.label}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>

        {kokoroLoading && (
          <span
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            <span className="whitespace-nowrap">
              Downloading voice model (one-time)…
              <span className="tabular-nums">
                {" "}
                {Math.round(Math.max(0, Math.min(1, kokoroProgress)) * 100)}%
              </span>
            </span>
          </span>
        )}
      </div>

      {/* Speed control */}
      <div className="flex items-center gap-2">
        <Gauge
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden
        />
        <Slider
          className="w-24"
          min={RATE_MIN}
          max={RATE_MAX}
          step={0.05}
          value={[rate]}
          onValueChange={([v]) =>
            onRateChange(Math.round(v * 100) / 100)
          }
          aria-label="Playback speed"
          aria-valuetext={`${rate.toFixed(2)} times normal speed`}
        />
        <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
          {rate.toFixed(2)}×
        </span>
      </div>
    </div>
  );
}
