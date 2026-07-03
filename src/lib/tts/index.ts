// Engine registry (PLAN §3). WebSpeech is the always-available, offline-immediate
// default; Kokoro is high-quality neural TTS, lazily initialised only when a
// Kokoro voice is picked.

import { WebSpeechEngine } from "./webspeech";
import { SidecarKokoroEngine } from "./sidecar-kokoro";
import type { EngineId, TtsEngine, Voice } from "./engine";

export type { EngineId, TtsEngine, Voice, NativeHandle } from "./engine";
export type { Boundary, SpeakResult, SpeakOptions } from "./engine";

// ── Kokoro RE-ENABLED via a Node sidecar (round 4) ────────────────────────────
// Kokoro cannot run inside the WKWebView — onnxruntime-web's threaded WASM
// deadlocks `InferenceSession.create` in a WebView Web Worker (runtime-proven
// across 3 rounds; see .work/kokoro-investigation-notes.md). The fix is a Node
// SIDECAR (sidecar/kokoro-server.mjs) that runs the model with NATIVE
// onnxruntime-node (device:"cpu") and exposes a localhost HTTP API; the
// SidecarKokoroEngine drives it while keeping the same TtsEngine contract. The
// Rust `start_kokoro_sidecar` command spawns/owns the Node process. So Kokoro is
// available again (the earlier candidate-(e) WKWebView disable is removed).
export const KOKORO_AVAILABLE = true;

let webspeech: WebSpeechEngine | null = null;
let kokoro: SidecarKokoroEngine | null = null;

export interface Engines {
  webspeech: WebSpeechEngine;
  kokoro: SidecarKokoroEngine;
}

export function getEngines(): Engines {
  if (!webspeech) webspeech = new WebSpeechEngine();
  if (!kokoro) kokoro = new SidecarKokoroEngine();
  return { webspeech, kokoro };
}

export function getEngine(id: EngineId): TtsEngine {
  const e = getEngines();
  return id === "kokoro" ? e.kokoro : e.webspeech;
}

/**
 * All selectable voices, Kokoro group first (curated, no model load required)
 * then system voices. Kokoro init is deferred until one is actually selected.
 */
export async function listAllVoices(): Promise<Voice[]> {
  const { webspeech: ws, kokoro: kk } = getEngines();
  const wsVoices = await ws.listVoices().catch(() => [] as Voice[]);
  if (!KOKORO_AVAILABLE) return wsVoices;
  const kkVoices = await kk.listVoices().catch(() => [] as Voice[]);
  return [...kkVoices, ...wsVoices];
}
