// Central UI state (PLAN §3). Zustand reflects the player/engine state for the
// React tree; the imperative PlayerController itself lives in App (a ref). The
// store never holds non-serialisable engine/controller objects.

import { create } from "zustand";
import type { PdfDoc, CharMap } from "../pdf/types";
import type { Segment } from "../text/segment";
import type { EngineId, Voice } from "../tts/engine";
import type { PlayerState } from "../player/controller";
import type { RecentDoc } from "../../persist/progress";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.1;

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const VOLUME_STEP = 0.05;

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(v * 100) / 100));
}

export type View = "library" | "reader";
export type DocStatus = "idle" | "parsing" | "ready" | "error";
export type PdfTheme = "light" | "dark";

export interface PageSize {
  width: number;
  height: number;
}

interface ReaderState {
  // navigation
  view: View;
  status: DocStatus;
  parseMessage: string;
  errorMessage: string;

  // active document
  doc: PdfDoc | null;
  charMap: CharMap | null;
  segments: Segment[];
  pageSizes: PageSize[];
  docTitle: string;
  docHash: string | null;
  docPath: string | null;

  // playback (reflected from the controller)
  currentIndex: number;
  playerState: PlayerState;
  progress: number;
  wordRange: { start: number; length: number } | null;

  // settings
  voiceId: string;
  rate: number;
  volume: number;
  engineId: EngineId;
  skipRefs: boolean;
  skipTables: boolean;
  stripCitations: boolean;
  stripParentheticals: boolean;
  pdfTheme: PdfTheme;
  zoom: number;

  // voices + kokoro lifecycle
  voices: Voice[];
  kokoroLoading: boolean;
  kokoroProgress: number;

  // library
  recents: RecentDoc[];

  // actions
  setView: (v: View) => void;
  startParsing: (title: string) => void;
  setParseMessage: (m: string) => void;
  setError: (m: string) => void;
  setDoc: (payload: {
    doc: PdfDoc;
    charMap: CharMap;
    segments: Segment[];
    pageSizes: PageSize[];
    title: string;
    hash: string | null;
    path: string | null;
  }) => void;
  closeDoc: () => void;

  setCurrentIndex: (i: number) => void;
  setPlayerState: (s: PlayerState) => void;
  setProgress: (f: number) => void;
  setWordRange: (r: { start: number; length: number } | null) => void;

  setVoiceId: (id: string) => void;
  setRate: (r: number) => void;
  setVolume: (v: number) => void;
  setEngineId: (e: EngineId) => void;
  setSkipRefs: (v: boolean) => void;
  setSkipTables: (v: boolean) => void;
  setStripCitations: (v: boolean) => void;
  setStripParentheticals: (v: boolean) => void;
  setPdfTheme: (t: PdfTheme) => void;
  setZoom: (z: number) => void;

  setVoices: (v: Voice[]) => void;
  setKokoroLoading: (v: boolean) => void;
  setKokoroProgress: (f: number) => void;

  setRecents: (r: RecentDoc[]) => void;
}

export const useReaderStore = create<ReaderState>((set) => ({
  view: "library",
  status: "idle",
  parseMessage: "",
  errorMessage: "",

  doc: null,
  charMap: null,
  segments: [],
  pageSizes: [],
  docTitle: "",
  docHash: null,
  docPath: null,

  currentIndex: 0,
  playerState: "idle",
  progress: 0,
  wordRange: null,

  voiceId: "",
  rate: 1,
  volume: 1,
  engineId: "webspeech",
  skipRefs: false,
  skipTables: true,
  stripCitations: true,
  stripParentheticals: true,
  pdfTheme: "light",
  zoom: 1,

  voices: [],
  kokoroLoading: false,
  kokoroProgress: 0,

  recents: [],

  setView: (view) => set({ view }),
  startParsing: (title) =>
    set({ status: "parsing", parseMessage: "Parsing paper…", docTitle: title, errorMessage: "" }),
  setParseMessage: (parseMessage) => set({ parseMessage }),
  setError: (errorMessage) => set({ status: "error", errorMessage }),
  setDoc: ({ doc, charMap, segments, pageSizes, title, hash, path }) =>
    set({
      doc,
      charMap,
      segments,
      pageSizes,
      docTitle: title,
      docHash: hash,
      docPath: path,
      status: "ready",
      view: "reader",
      currentIndex: 0,
      progress: 0,
      playerState: "idle",
      wordRange: null,
    }),
  closeDoc: () =>
    set({
      view: "library",
      status: "idle",
      doc: null,
      charMap: null,
      segments: [],
      pageSizes: [],
      docTitle: "",
      docHash: null,
      docPath: null,
      currentIndex: 0,
      progress: 0,
      playerState: "idle",
      wordRange: null,
    }),

  setCurrentIndex: (currentIndex) => set({ currentIndex }),
  setPlayerState: (playerState) => set({ playerState }),
  setProgress: (progress) => set({ progress }),
  setWordRange: (wordRange) => set({ wordRange }),

  setVoiceId: (voiceId) => set({ voiceId }),
  setRate: (rate) => set({ rate }),
  setVolume: (volume) => set({ volume: clampVolume(volume) }),
  setEngineId: (engineId) => set({ engineId }),
  setSkipRefs: (skipRefs) => set({ skipRefs }),
  setSkipTables: (skipTables) => set({ skipTables }),
  setStripCitations: (stripCitations) => set({ stripCitations }),
  setStripParentheticals: (stripParentheticals) => set({ stripParentheticals }),
  setPdfTheme: (pdfTheme) => set({ pdfTheme }),
  setZoom: (z) =>
    set({
      zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100)),
    }),

  setVoices: (voices) => set({ voices }),
  setKokoroLoading: (kokoroLoading) => set({ kokoroLoading }),
  setKokoroProgress: (kokoroProgress) => set({ kokoroProgress }),

  setRecents: (recents) => set({ recents }),
}));
