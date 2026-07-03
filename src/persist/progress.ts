// Per-document progress + global settings via @tauri-apps/plugin-store
// (PLAN §5.8). Doc key = SHA-256 of the file bytes (computed by the Rust
// `hash_file` command). All calls degrade gracefully (no-op) when the Tauri
// runtime is absent so the frontend still builds/runs in a plain browser.

import type { EngineId } from "../lib/tts/engine";

export interface Settings {
  voiceId: string;
  rate: number;
  volume: number;
  engineId: EngineId;
  skipRefs: boolean;
  skipTables: boolean;
  stripCitations: boolean;
  stripParentheticals: boolean;
  zoom: number;
  pdfTheme: "light" | "dark";
}

export interface DocRecord {
  title: string;
  path?: string;
  lastSegment: number;
  totalSegments: number;
  updatedAt: number;
}

export interface RecentDoc extends DocRecord {
  hash: string;
  percent: number;
}

const STORE_FILE = "rpar.json";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type StoreLike = {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let storePromise: Promise<StoreLike | null> | null = null;

async function getStore(): Promise<StoreLike | null> {
  if (!inTauri()) return null;
  if (!storePromise) {
    storePromise = import("@tauri-apps/plugin-store")
      .then((m) => m.load(STORE_FILE, { autoSave: true, defaults: {} }) as unknown as StoreLike)
      .catch((e) => {
        console.warn("[persist] store unavailable", e);
        return null;
      });
  }
  return storePromise;
}

export async function loadSettings(): Promise<Partial<Settings> | null> {
  const store = await getStore();
  if (!store) return null;
  try {
    return (await store.get<Partial<Settings>>("settings")) ?? null;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getStore();
  if (!store) return;
  try {
    await store.set("settings", settings);
    await store.save();
  } catch (e) {
    console.warn("[persist] saveSettings failed", e);
  }
}

async function readDocs(
  store: StoreLike,
): Promise<Record<string, DocRecord>> {
  try {
    return (await store.get<Record<string, DocRecord>>("docs")) ?? {};
  } catch {
    return {};
  }
}

export async function getDocProgress(hash: string): Promise<DocRecord | null> {
  const store = await getStore();
  if (!store) return null;
  const docs = await readDocs(store);
  return docs[hash] ?? null;
}

export async function saveDocProgress(
  hash: string,
  rec: DocRecord,
): Promise<void> {
  const store = await getStore();
  if (!store) return;
  try {
    const docs = await readDocs(store);
    docs[hash] = rec;
    await store.set("docs", docs);
    await store.save();
  } catch (e) {
    console.warn("[persist] saveDocProgress failed", e);
  }
}

export async function listRecents(): Promise<RecentDoc[]> {
  const store = await getStore();
  if (!store) return [];
  const docs = await readDocs(store);
  return Object.entries(docs)
    .map(([hash, d]) => ({
      ...d,
      hash,
      percent: d.totalSegments
        ? Math.min(100, Math.round((d.lastSegment / d.totalSegments) * 100))
        : 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
