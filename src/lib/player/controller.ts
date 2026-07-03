// PlayerController (PLAN §4 contract + §5.5 gapless/prefetch + §10.5 robustness).
//
// Drives sentence-by-sentence narration. WebSpeech plays natively; Kokoro
// generates a WAV per segment (at speed 1.0; tempo via audio.playbackRate) and
// is prefetched ahead for gapless playback. A monotonically increasing
// cancellation token invalidates stale generations/handles on every seek, voice
// or rate change. Generated blob: URLs are kept in a bounded LRU and revoked on
// eviction.

import type { Segment } from "../text/segment";
import type { NativeHandle, TtsEngine } from "../tts/engine";
import { normalizeForSpeech } from "../text/pronounce";

export type PlayerState = "idle" | "loading" | "playing" | "paused" | "ended";

export interface PlayerEvents {
  segment: (index: number) => void;
  word: (charIndex: number, charLength: number) => void;
  state: (s: PlayerState) => void;
  progress: (fraction: number) => void;
}

export interface PlayerController {
  load(
    segments: Segment[],
    engine: TtsEngine,
    voiceId: string,
    rate: number,
    volume: number,
  ): Promise<void>;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  seekToSegment(index: number): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  setVoice(engine: TtsEngine, voiceId: string): Promise<void>;
  on<K extends keyof PlayerEvents>(e: K, cb: PlayerEvents[K]): () => void;
  readonly currentIndex: number;
  destroy(): void;
}

const PREFETCH_AHEAD = 2;
const CACHE_CAP = 16;

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

export class PlayerControllerImpl implements PlayerController {
  private segments: Segment[] = [];
  private engine: TtsEngine | null = null;
  private voiceId = "";
  private rate = 1;
  private volume = 1;
  private index = 0;
  private state: PlayerState = "idle";

  private token = 0;
  private nativeHandle: NativeHandle | null = null;
  private audio: HTMLAudioElement;
  /**
   * Index of the segment whose audio is currently loaded in the element, or -1
   * when nothing resumable is loaded. Reset by `cancel()` (a seek/voice change
   * nulls the media handlers, so the loaded blob can no longer be safely
   * resumed) — this guards `play()` from resuming the pre-seek segment's audio.
   */
  private loadedIndex = -1;

  /**
   * key (`voice|text`) → ordered blob: URLs for one segment's audio
   * (>=1 sub-chunk; PLAN §10.1), insertion-ordered for LRU.
   */
  private cache = new Map<string, string[]>();
  private inflight = new Map<string, Promise<string[]>>();
  /**
   * AbortController per in-flight Kokoro generation. A voice/document switch
   * (clearCache) aborts them so the worker stops mid-queue instead of running
   * stale synthesis to completion (PLAN §10.5). Plain seeks intentionally do NOT
   * abort: a seek into the prefetch window reuses the in-flight promise, so
   * killing it would discard work we are about to need.
   */
  private inflightAbort = new Map<string, AbortController>();
  /** URLs of the segment currently loaded into the audio element — never revoked while active. */
  private activeUrls = new Set<string>();

  private listeners: { [K in keyof PlayerEvents]: Set<PlayerEvents[K]> } = {
    segment: new Set(),
    word: new Set(),
    state: new Set(),
    progress: new Set(),
  };

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.volume = this.volume;
  }

  get currentIndex(): number {
    return this.index;
  }

  private isNative(): boolean {
    return typeof this.engine?.playNative === "function";
  }

  // ---- events -----------------------------------------------------------
  on<K extends keyof PlayerEvents>(e: K, cb: PlayerEvents[K]): () => void {
    this.listeners[e].add(cb);
    return () => this.listeners[e].delete(cb);
  }
  private emitSegment(i: number) {
    this.listeners.segment.forEach((f) => f(i));
  }
  private emitWord(ci: number, cl: number) {
    this.listeners.word.forEach((f) => f(ci, cl));
  }
  private emitState(s: PlayerState) {
    this.state = s;
    this.listeners.state.forEach((f) => f(s));
  }
  private emitProgress(fraction: number) {
    this.listeners.progress.forEach((f) => f(fraction));
  }

  // ---- lifecycle --------------------------------------------------------
  async load(
    segments: Segment[],
    engine: TtsEngine,
    voiceId: string,
    rate: number,
    volume: number,
  ): Promise<void> {
    this.cancelActiveBump();
    this.clearCache();
    this.segments = segments;
    this.engine = engine;
    this.voiceId = voiceId;
    this.rate = rate;
    this.volume = clampVolume(volume);
    this.audio.volume = this.volume;
    this.index = 0;
    this.emitSegment(0);
    this.emitProgress(0);
    this.emitState("idle");
  }

  // ---- transport --------------------------------------------------------
  play(): void {
    if (!this.engine || this.segments.length === 0) return;
    if (this.state === "playing") return;

    if (this.state === "paused") {
      this.emitState("playing");
      if (this.isNative() && this.nativeHandle) {
        this.engine.resumeNative?.();
        return;
      }
      // Resume the loaded Kokoro audio only if it still belongs to the current
      // segment. After a seek-while-paused, `cancel()` has nulled the media
      // handlers and reset loadedIndex, so we fall through to playCurrent() and
      // (re)play the correct segment rather than resuming the stale blob.
      if (
        !this.isNative() &&
        this.audio.src &&
        this.loadedIndex === this.index
      ) {
        void this.audio.play().catch(() => this.onSegmentEnd());
        return;
      }
    }
    if (this.state === "ended") this.index = 0;
    this.emitState("playing");
    void this.playCurrent();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.emitState("paused");
    if (this.isNative()) this.engine?.pauseNative?.();
    else this.audio.pause();
  }

  toggle(): void {
    if (this.state === "playing") this.pause();
    else this.play();
  }

  next(): void {
    if (this.index < this.segments.length - 1) {
      this.index++;
      this.restartAtIndex();
    }
  }

  prev(): void {
    if (this.index > 0) {
      this.index--;
      this.restartAtIndex();
    }
  }

  seekToSegment(index: number): void {
    const i = Math.max(0, Math.min(index, this.segments.length - 1));
    this.index = i;
    this.restartAtIndex();
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (!this.isNative()) {
      this.audio.playbackRate = rate;
      return;
    }
    // WebSpeech bakes rate into the utterance — re-speak the current segment.
    if (this.state === "playing") {
      this.cancelActiveBump();
      void this.playCurrent();
    }
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    this.audio.volume = this.volume;
    // Kokoro uses the shared audio element, so the change is live. WebSpeech
    // bakes volume into an already-spoken utterance and exposes no live gain
    // control, so the new value applies to the next utterance only — do not
    // re-speak the current segment here.
  }

  async setVoice(engine: TtsEngine, voiceId: string): Promise<void> {
    const wasPlaying = this.state === "playing";
    this.cancelActiveBump();
    this.clearCache();
    this.engine = engine;
    this.voiceId = voiceId;
    try {
      await engine.init?.();
    } catch {
      /* caller surfaces init failures; speak() will retry/fail loudly */
    }
    if (wasPlaying) {
      this.emitState("playing");
      void this.playCurrent();
    }
  }

  destroy(): void {
    this.cancelActiveBump();
    this.clearCache();
    this.audio.src = "";
    (Object.keys(this.listeners) as (keyof PlayerEvents)[]).forEach((k) =>
      this.listeners[k].clear(),
    );
  }

  // ---- internals --------------------------------------------------------
  private restartAtIndex(): void {
    const wasPlaying = this.state === "playing";
    this.cancelActiveBump();
    this.emitSegment(this.index);
    this.emitProgress(this.segments.length ? this.index / this.segments.length : 0);
    if (wasPlaying) {
      this.emitState("playing");
      void this.playCurrent();
    } else {
      // Reflect the new position without auto-playing.
      if (this.state === "ended") this.emitState("paused");
    }
  }

  private cancel(): void {
    if (this.nativeHandle) {
      this.nativeHandle.cancel();
      this.nativeHandle = null;
    }
    this.audio.onended = null;
    this.audio.ontimeupdate = null;
    // The loaded blob is no longer resumable (its handlers are gone); force
    // play() to go through playCurrent() rather than resume the wrong segment.
    this.loadedIndex = -1;
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
  }

  private cancelActiveBump(): void {
    this.token++;
    this.cancel();
  }

  private async playCurrent(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const i = this.index;
    if (i < 0 || i >= this.segments.length) {
      this.emitState("ended");
      this.emitProgress(1);
      return;
    }
    const seg = this.segments[i];
    this.emitSegment(i);
    const token = ++this.token;
    this.cancel();

    if (this.isNative()) {
      const spoken = normalizeForSpeech(seg.text);
      this.nativeHandle = engine.playNative!(
        spoken,
        { voiceId: this.voiceId, rate: this.rate, volume: this.volume },
        {
          onBoundary: (b) => {
            if (token !== this.token) return;
            // Word boundaries index into the SPOKEN string; when normalization
            // rewrote it (e.g. "pp." -> "pages"), b.charIndex no longer maps onto
            // seg.charStart, so drop the best-effort word event. The sentence-level
            // highlight is unaffected.
            if (spoken !== seg.text) return;
            this.emitWord(seg.charStart + b.charIndex, b.charLength);
          },
          onEnd: () => {
            if (token !== this.token) return;
            this.onSegmentEnd();
          },
          onError: (e) => {
            if (token !== this.token) return;
            console.error("[player] webspeech error", e);
            this.onSegmentEnd();
          },
        },
      );
      this.emitState("playing");
      return;
    }

    // Kokoro path.
    this.emitState("loading");
    try {
      const urls = await this.getAudioUrls(seg);
      if (token !== this.token) return; // superseded by a newer action
      if (urls.length === 0) {
        this.onSegmentEnd(); // empty result — skip
        return;
      }
      this.activeUrls = new Set(urls);
      this.playChunks(urls, token, i);
      for (let k = 1; k <= PREFETCH_AHEAD; k++) this.prefetch(i + k);
    } catch (e) {
      if (token !== this.token) return;
      console.error("[player] kokoro playback failed", e);
      this.onSegmentEnd(); // skip the bad segment
    }
  }

  /**
   * Play one segment's sub-chunks back-to-back on the shared audio element
   * (PLAN §10.1: a long sentence is several WAV chunks but stays one segment /
   * one highlight). Advances to the next segment only after the last chunk ends.
   * Progress is reported continuously across the chunks.
   */
  private playChunks(urls: string[], token: number, i: number): void {
    const n = urls.length;
    // This segment's audio is now the resumable one loaded in the element.
    this.loadedIndex = i;
    const playAt = (k: number): void => {
      if (token !== this.token) return;
      if (k >= n) {
        this.onSegmentEnd();
        return;
      }
      this.audio.src = urls[k];
      this.audio.playbackRate = this.rate;
      this.audio.volume = this.volume;
      this.audio.onended = () => {
        if (token !== this.token) return;
        playAt(k + 1);
      };
      this.audio.ontimeupdate = () => {
        if (token !== this.token) return;
        const dur = this.audio.duration;
        const cf =
          Number.isFinite(dur) && dur > 0 ? this.audio.currentTime / dur : 0;
        const segFrac = (k + cf) / n;
        this.emitProgress((i + segFrac) / this.segments.length);
      };
      this.audio
        .play()
        .then(() => {
          if (token !== this.token) return;
          this.emitState("playing");
        })
        .catch((e) => {
          if (token !== this.token) return;
          console.error("[player] kokoro chunk playback failed", e);
          this.onSegmentEnd();
        });
    };
    playAt(0);
  }

  private onSegmentEnd(): void {
    if (this.index >= this.segments.length - 1) {
      this.index = Math.max(0, this.segments.length - 1);
      this.emitState("ended");
      this.emitProgress(1);
      return;
    }
    this.index++;
    this.emitProgress(this.index / this.segments.length);
    // "loading" is a transient sub-state of an active play intent (a Kokoro
    // segment mid-generation), so keep advancing through skipped/failed
    // segments rather than stalling.
    if (this.state === "playing" || this.state === "loading")
      void this.playCurrent();
  }

  private cacheKey(text: string): string {
    return `${this.voiceId}|${text}`;
  }

  private async getAudioUrls(seg: Segment): Promise<string[]> {
    const key = this.cacheKey(seg.text);
    const cached = this.cache.get(key);
    if (cached) {
      // refresh LRU recency
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const engine = this.engine!;
    const voiceId = this.voiceId;
    const ac = new AbortController();
    this.inflightAbort.set(key, ac);
    const p = engine
      .speak(normalizeForSpeech(seg.text), { voiceId, rate: this.rate, signal: ac.signal })
      .then((res) => {
        this.inflight.delete(key);
        this.inflightAbort.delete(key);
        const urls = res.audioUrls ?? (res.audioUrl ? [res.audioUrl] : []);
        if (urls.length) this.cacheSet(key, urls);
        return urls;
      })
      .catch((e) => {
        this.inflight.delete(key);
        this.inflightAbort.delete(key);
        throw e;
      });
    this.inflight.set(key, p);
    return p;
  }

  private prefetch(i: number): void {
    if (i < 0 || i >= this.segments.length) return;
    if (this.isNative()) return;
    const seg = this.segments[i];
    const key = this.cacheKey(seg.text);
    if (this.cache.has(key) || this.inflight.has(key)) return;
    void this.getAudioUrls(seg).catch(() => {
      /* prefetch failures are non-fatal; retried on demand */
    });
  }

  /** Revoke a blob: URL unless it's the one currently in the audio element or
   *  part of the actively-playing segment. */
  private revoke(url: string): void {
    if (!url || url === this.audio.src || this.activeUrls.has(url)) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }

  private cacheSet(key: string, urls: string[]): void {
    this.cache.set(key, urls);
    while (this.cache.size > CACHE_CAP) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const old = this.cache.get(oldest);
      this.cache.delete(oldest);
      old?.forEach((u) => this.revoke(u));
    }
  }

  /**
   * Tear down the whole audio cache (load / setVoice / destroy). Playback has
   * already been cancelled by the caller, so detach the audio element and revoke
   * every cached URL unconditionally — the active-URL guard does not apply here.
   */
  private clearCache(): void {
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
    this.audio.removeAttribute("src");
    this.loadedIndex = -1;
    this.activeUrls.clear();
    // Stop any Kokoro syntheses still running for the old voice/document.
    for (const ac of this.inflightAbort.values()) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    this.inflightAbort.clear();
    for (const urls of this.cache.values()) {
      for (const u of urls) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      }
    }
    this.cache.clear();
    this.inflight.clear();
  }
}
