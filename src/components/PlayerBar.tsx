// PlayerBar — bottom transport bar (PLAN §1, §6: 64px, calm dark).
// play/pause · prev/next sentence · restart · scrub slider · speed + voice
// (via VoicePicker) · engine/model-loading status. Reads reflected playback
// state from the store; drives the imperative PlayerController for transport.
// The store's currentIndex / playerState / progress are kept in sync by App's
// controller-event listeners (Integrate phase), so this bar only *reads* them.

import { useRef } from "react";
import {
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { PlayerController } from "@/lib/player/controller";
import type { Voice } from "@/lib/tts/engine";
import {
  VOLUME_MAX,
  VOLUME_MIN,
  VOLUME_STEP,
  useReaderStore,
} from "@/lib/store/useReaderStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import VoicePicker from "./VoicePicker";

export interface PlayerBarProps {
  /** The imperative player instance (owned by App). Null until Integrate wires it. */
  controller: PlayerController | null;
  /** Voice switch handler — App owns engine lifecycle (lazy Kokoro init/fallback). */
  onSelectVoice: (voice: Voice) => void;
  /** Background pre-warm of the Kokoro model (App-owned). */
  onPrewarmKokoro?: () => void;
  className?: string;
}

function TransportButton({
  label,
  onClick,
  disabled,
  children,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={primary ? "default" : "ghost"}
          size={primary ? "icon-lg" : "icon"}
          className={primary ? "rounded-full" : undefined}
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default function PlayerBar({
  controller,
  onSelectVoice,
  onPrewarmKokoro,
  className,
}: PlayerBarProps) {
  const segments = useReaderStore((s) => s.segments);
  const currentIndex = useReaderStore((s) => s.currentIndex);
  const playerState = useReaderStore((s) => s.playerState);
  const progress = useReaderStore((s) => s.progress);
  const rate = useReaderStore((s) => s.rate);
  const setRate = useReaderStore((s) => s.setRate);
  const volume = useReaderStore((s) => s.volume);
  const setVolume = useReaderStore((s) => s.setVolume);
  const voiceId = useReaderStore((s) => s.voiceId);
  const voices = useReaderStore((s) => s.voices);
  const kokoroLoading = useReaderStore((s) => s.kokoroLoading);
  const kokoroProgress = useReaderStore((s) => s.kokoroProgress);

  const total = segments.length;
  const hasDoc = total > 0 && !!controller;
  const isPlaying = playerState === "playing";
  const isLoading = playerState === "loading";
  const lastIndex = Math.max(0, total - 1);
  const percent = Math.round(progress * 100);

  // Remember the last non-zero level so the mute toggle can restore it.
  const lastAudibleVolume = useRef(volume > 0 ? volume : 1);

  function handleRate(r: number) {
    setRate(r);
    controller?.setRate(r);
  }

  function handleVolume(v: number) {
    const next = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(v * 100) / 100));
    if (next > 0) lastAudibleVolume.current = next;
    setVolume(next);
    controller?.setVolume(next);
  }

  function toggleMute() {
    if (volume > 0) handleVolume(0);
    else handleVolume(lastAudibleVolume.current || 1);
  }

  return (
    <footer
      aria-label="Playback controls"
      className={`bg-surface border-border flex h-16 w-full shrink-0 items-center gap-4 border-t px-4 ${className ?? ""}`.trim()}
    >
      {/* Transport cluster */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Transport"
      >
        <TransportButton
          label="Restart from beginning"
          onClick={() => controller?.seekToSegment(0)}
          disabled={!hasDoc}
        >
          <RotateCcw />
        </TransportButton>
        <TransportButton
          label="Previous sentence"
          onClick={() => controller?.prev()}
          disabled={!hasDoc || currentIndex <= 0}
        >
          <SkipBack />
        </TransportButton>
        <TransportButton
          label={isPlaying ? "Pause" : "Play"}
          onClick={() => controller?.toggle()}
          disabled={!hasDoc}
          primary
        >
          {isLoading ? (
            <LoaderCircle className="animate-spin" aria-hidden />
          ) : isPlaying ? (
            <Pause />
          ) : (
            <Play />
          )}
        </TransportButton>
        <TransportButton
          label="Next sentence"
          onClick={() => controller?.next()}
          disabled={!hasDoc || currentIndex >= lastIndex}
        >
          <SkipForward />
        </TransportButton>
      </div>

      <Separator orientation="vertical" className="h-8" />

      {/* Scrub + position */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Slider
          className="min-w-24 flex-1"
          min={0}
          max={lastIndex}
          step={1}
          value={[Math.min(currentIndex, lastIndex)]}
          onValueChange={([i]) => controller?.seekToSegment(i)}
          disabled={!hasDoc}
          aria-label="Scrub through sentences"
          aria-valuetext={`Sentence ${currentIndex + 1} of ${total}`}
        />
        <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs tabular-nums">
          <span aria-hidden>
            {total ? currentIndex + 1 : 0} / {total}
          </span>
          <span className="text-foreground/70 w-9 text-right">{percent}%</span>
        </div>
      </div>

      <Separator orientation="vertical" className="h-8" />

      {/* Volume */}
      <div className="flex items-center gap-2" role="group" aria-label="Volume">
        <TransportButton
          label={volume > 0 ? "Mute" : "Unmute"}
          onClick={toggleMute}
          disabled={!controller}
        >
          {volume > 0 ? <Volume2 /> : <VolumeX />}
        </TransportButton>
        <Slider
          className="w-20"
          min={VOLUME_MIN}
          max={VOLUME_MAX}
          step={VOLUME_STEP}
          value={[volume]}
          onValueChange={([v]) => handleVolume(v)}
          disabled={!controller}
          aria-label="Volume"
          aria-valuetext={`${Math.round(volume * 100)} percent`}
        />
        <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">
          {Math.round(volume * 100)}%
        </span>
      </div>

      <Separator orientation="vertical" className="h-8" />

      {/* Voice + speed */}
      <VoicePicker
        voices={voices}
        voiceId={voiceId}
        onSelectVoice={onSelectVoice}
        rate={rate}
        onRateChange={handleRate}
        kokoroLoading={kokoroLoading}
        kokoroProgress={kokoroProgress}
        onPrewarmKokoro={onPrewarmKokoro}
      />
    </footer>
  );
}
