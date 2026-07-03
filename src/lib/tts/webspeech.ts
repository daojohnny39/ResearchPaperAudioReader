// WebSpeechEngine — the always-available, zero-setup default (PLAN §2.6 fallback,
// §5.5). Plays natively via the Web Speech API and forwards word boundaries when
// WebKit emits them (best-effort; segment-level highlight never depends on it).

import type {
  Boundary,
  NativeHandle,
  SpeakResult,
  TtsEngine,
  Voice,
} from "./engine";

function getSynth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
}

/** Finite-clamp a 0..1 volume; preserves 0 (mute) and never uses `|| 1`. */
function clampVolume(v: number | undefined): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v as number));
}

/** Resolve the available system voices, waiting for the async 'voiceschanged'
 *  event the first time (Chrome/WebKit populate voices lazily). */
function loadSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = getSynth();
  if (!synth) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", finish, { once: true });
    // Safety timeout — some platforms never fire the event.
    setTimeout(finish, 1200);
  });
}

export class WebSpeechEngine implements TtsEngine {
  readonly id = "webspeech" as const;
  ready = false;
  private voicesById = new Map<string, SpeechSynthesisVoice>();

  async init(): Promise<void> {
    await this.listVoices();
    this.ready = true;
  }

  async listVoices(): Promise<Voice[]> {
    const sys = await loadSystemVoices();
    this.voicesById.clear();
    const voices: Voice[] = [];
    for (const v of sys) {
      const id = v.voiceURI || v.name;
      this.voicesById.set(id, v);
      voices.push({
        id,
        label: v.default ? `${v.name} (default)` : v.name,
        engine: "webspeech",
        lang: v.lang,
      });
    }
    // Prefer English voices first for research papers, keep the rest after.
    voices.sort((a, b) => {
      const ae = a.lang.toLowerCase().startsWith("en") ? 0 : 1;
      const be = b.lang.toLowerCase().startsWith("en") ? 0 : 1;
      return ae - be || a.label.localeCompare(b.label);
    });
    return voices;
  }

  async speak(): Promise<SpeakResult> {
    // Native engine: the player drives playback through playNative().
    return { native: true };
  }

  playNative(
    text: string,
    opts: { voiceId: string; rate: number; volume: number },
    cbs: {
      onBoundary?: (b: Boundary) => void;
      onEnd: () => void;
      onError: (e: unknown) => void;
    },
  ): NativeHandle {
    const synth = getSynth();
    if (!synth) {
      cbs.onError(new Error("speechSynthesis unavailable"));
      return { cancel() {} };
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = this.voicesById.get(opts.voiceId);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = Math.max(0.1, Math.min(opts.rate, 10));
    u.volume = clampVolume(opts.volume);
    let finished = false;
    u.onboundary = (ev: SpeechSynthesisEvent) => {
      if (ev.name === "word" || ev.name === undefined) {
        cbs.onBoundary?.({
          charIndex: ev.charIndex ?? 0,
          charLength: (ev as any).charLength ?? 0,
          audioTimeMs: ev.elapsedTime ?? 0,
        });
      }
    };
    u.onend = () => {
      if (finished) return;
      finished = true;
      cbs.onEnd();
    };
    u.onerror = (e) => {
      if (finished) return;
      finished = true;
      // 'interrupted'/'canceled' fire on a normal cancel(); treat as end.
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err === "interrupted" || err === "canceled") cbs.onEnd();
      else cbs.onError(e);
    };
    synth.speak(u);
    return {
      cancel() {
        finished = true;
        u.onend = null;
        u.onerror = null;
        synth.cancel();
      },
    };
  }

  pauseNative(): void {
    getSynth()?.pause();
  }

  resumeNative(): void {
    getSynth()?.resume();
  }
}
