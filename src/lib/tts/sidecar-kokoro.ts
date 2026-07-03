// SidecarKokoroEngine — high-quality local neural TTS (PLAN §0, §5.6, §10.1),
// round-4 SIDECAR edition.
//
// WHY A SIDECAR: Kokoro cannot run inside the WKWebView — onnxruntime-web's
// threaded WASM deadlocks `InferenceSession.create` in a WebView Web Worker
// (proven across 3 rounds; see .work/kokoro-investigation-notes.md). Instead a
// Node process (sidecar/kokoro-server.mjs) runs the model with NATIVE
// onnxruntime-node (device:"cpu") and exposes a tiny localhost HTTP API. This
// engine drives that API while keeping the SAME TtsEngine contract the old
// worker engine had, so the player's blob-url creation, LRU cache, prefetch and
// cancellation all keep working unchanged.
//
//   init()  -> invoke('start_kokoro_sidecar') -> baseUrl; poll GET /health,
//              forwarding the one-time model-load % to onProgress; resolve ready.
//   speak() -> POST {baseUrl}/speak {text, voice, speed} -> WAV bytes ->
//              Blob({type:'audio/wav'}) -> object URL in SpeakResult.audioUrls.

import { invoke } from "@tauri-apps/api/core";
import type { SpeakOptions, SpeakResult, TtsEngine, Voice } from "./engine";

// Curated voice subset surfaced by the picker (real ids + grades, PLAN §10.1).
// These ids are exactly the af_/am_/bf_/bm_ keys the sidecar's kokoro-js exposes.
export const KOKORO_VOICES: Voice[] = [
  { id: "af_heart", label: "Heart", grade: "A", gender: "female", lang: "en-us", engine: "kokoro" },
  { id: "af_bella", label: "Bella", grade: "A-", gender: "female", lang: "en-us", engine: "kokoro" },
  { id: "af_nicole", label: "Nicole", grade: "B-", gender: "female", lang: "en-us", engine: "kokoro" },
  { id: "am_michael", label: "Michael", grade: "C+", gender: "male", lang: "en-us", engine: "kokoro" },
  { id: "am_fenrir", label: "Fenrir", grade: "C+", gender: "male", lang: "en-us", engine: "kokoro" },
  { id: "bf_emma", label: "Emma (GB)", grade: "B-", gender: "female", lang: "en-gb", engine: "kokoro" },
  { id: "bm_fable", label: "Fable (GB)", grade: "B", gender: "male", lang: "en-gb", engine: "kokoro" },
];

interface HealthResponse {
  ready: boolean;
  progress?: number;
  error?: string;
  voices?: string[];
}

function abortError(): DOMException {
  return new DOMException("Kokoro synthesis aborted", "AbortError");
}

const READY_TIMEOUT_MS = 120_000; // first run downloads the q8 model from HF
const POLL_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SidecarKokoroEngine implements TtsEngine {
  readonly id = "kokoro" as const;
  ready = false;

  private baseUrl: string | null = null;
  private initPromise: Promise<void> | null = null;
  private onProgress?: (fraction: number) => void;
  private lastProgress = 0; // enforce non-decreasing displayed progress

  async listVoices(): Promise<Voice[]> {
    return KOKORO_VOICES;
  }

  /**
   * Spawn (or reuse) the sidecar and wait for the model to load. Resolves when
   * /health reports ready; rejects if the sidecar fails or never gets ready.
   * `onProgress` receives a 0..1 model-load fraction (drives the picker's
   * one-time "Downloading voice model…" indicator).
   */
  init(onProgress?: (fraction: number) => void): Promise<void> {
    if (onProgress) this.onProgress = onProgress;
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise; // pre-warm + selectVoice SHARE this promise

    this.lastProgress = 0;
    this.initPromise = (async () => {
      // 1) Ask Rust to start (idempotent) the Node sidecar and tell us its URL.
      const baseUrl = await invoke<string>("start_kokoro_sidecar");
      this.baseUrl = baseUrl;

      // 2) Poll /health until the model is loaded (bounded).
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        let health: HealthResponse | null = null;
        try {
          const r = await fetch(`${baseUrl}/health`, { method: "GET" });
          if (r.ok) health = (await r.json()) as HealthResponse;
        } catch {
          // sidecar may not be accepting connections yet — keep polling
        }
        if (health) {
          if (typeof health.progress === "number") {
            const raw = Math.max(0, Math.min(1, health.progress));
            if (raw > this.lastProgress) this.lastProgress = raw;
            this.onProgress?.(this.lastProgress);
          }
          if (health.ready) {
            this.ready = true;
            this.lastProgress = 1;
            this.onProgress?.(1); // guarantee the bar hits 100% before resolve
            return;
          }
          if (health.error) {
            throw new Error(`Kokoro sidecar failed to load model: ${health.error}`);
          }
        }
        await sleep(POLL_MS);
      }
      throw new Error("Kokoro sidecar model load timed out");
    })().catch((e) => {
      this.initPromise = null; // allow a later retry
      throw e;
    });

    return this.initPromise;
  }

  /**
   * Generate audio for one segment via the sidecar. Returns a single WAV blob
   * URL (kokoro-js does its own internal chunking server-side and returns one
   * concatenated WAV); the highlight stays segment-level. `opts.signal` aborts
   * the in-flight fetch so a stale generation never reaches the player.
   * `rate` is intentionally ignored here — the player applies it via
   * `audio.playbackRate` (PLAN §5.5).
   */
  async speak(text: string, opts: SpeakOptions): Promise<SpeakResult> {
    const { voiceId, signal } = opts;
    if (signal?.aborted) throw abortError();
    if (!this.ready) await this.init();
    const baseUrl = this.baseUrl;
    if (!baseUrl) throw new Error("Kokoro sidecar not initialised");

    const r = await fetch(`${baseUrl}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voiceId, speed: 1.0 }),
      signal,
    });
    if (!r.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await r.json());
      } catch {
        /* ignore */
      }
      throw new Error(`Kokoro sidecar /speak HTTP ${r.status} ${detail}`);
    }
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    return { native: false, audioUrl: url, audioUrls: [url] };
  }

  dispose(): void {
    // The Node process is owned by Rust (killed on app exit). Nothing held here
    // beyond the base URL + flags; reset so a later init() re-checks /health.
    this.ready = false;
    this.initPromise = null;
  }
}
