// TTS engine contracts (PLAN §4). Two engines implement this: WebSpeech (native
// playback, always available, word boundaries when WebKit provides them) and
// Kokoro (generates a WAV blob the player plays via <audio>).

export type EngineId = "kokoro" | "webspeech";

export interface Voice {
  id: string;
  label: string;
  engine: EngineId;
  lang: string;
  /** Optional quality grade surfaced by the picker (Kokoro). */
  grade?: string;
  /** Female/male grouping hint for the picker. */
  gender?: string;
}

export interface Boundary {
  charIndex: number;
  charLength: number;
  audioTimeMs: number;
}

export interface SpeakResult {
  /** true => the engine plays itself (WebSpeech); no audioUrl. */
  native: boolean;
  /**
   * blob: URL for the first (or only) generated WAV (Kokoro). Equal to
   * `audioUrls[0]`; kept for the common single-chunk path.
   */
  audioUrl?: string;
  /**
   * Ordered blob: URLs for one segment's audio. A long sentence is split into
   * sub-chunks (Kokoro truncates long token runs — PLAN §10.1); the player
   * plays these back-to-back while the highlight stays on the one segment.
   * Always length >= 1 for a Kokoro result; the player should prefer this over
   * `audioUrl`. The caller owns these URLs and must revoke them.
   */
  audioUrls?: string[];
  /** Total audio duration across all sub-chunks (ms). */
  durationMs?: number;
  boundaries?: Boundary[];
}

export interface NativeHandle {
  cancel(): void;
}

/** Options for {@link TtsEngine.speak}. */
export interface SpeakOptions {
  voiceId: string;
  rate: number;
  /**
   * Cancellation for in-flight synthesis. The player bumps a fresh signal on
   * every seek / voice change so stale Kokoro generations abort and never reach
   * the audio element. Kokoro honours it between sub-chunks and rejects the
   * returned promise with an `AbortError`. (Rate is applied by the player via
   * `audio.playbackRate`, so it does not affect generation — PLAN §5.5.)
   */
  signal?: AbortSignal;
}

export interface TtsEngine {
  id: EngineId;
  ready: boolean;
  init(onProgress?: (fraction: number) => void): Promise<void>;
  listVoices(): Promise<Voice[]>;
  /** Kokoro: returns {native:false, audioUrl(s)}. WebSpeech: returns {native:true}. */
  speak(text: string, opts: SpeakOptions): Promise<SpeakResult>;
  /** WebSpeech only: drive a native utterance and report end/boundary/error. */
  playNative?(
    text: string,
    opts: { voiceId: string; rate: number; volume: number },
    cbs: {
      onBoundary?: (b: Boundary) => void;
      onEnd: () => void;
      onError: (e: unknown) => void;
    },
  ): NativeHandle;
  /** Optional pause/resume for native engines. */
  pauseNative?(): void;
  resumeNative?(): void;
  /** Release any held resources (worker, model). */
  dispose?(): void;
}
