// App — the top-level shell that wires every module into a working reader
// (PLAN §2 data flow, §7 Phase 4 Integrate).
//
//   Library ⇄ Reader            (routed off store.view)
//   open PDF → loadPdf → buildCharMap → segment → store
//   PlayerController(segments, engine, voiceId, rate)  (owned here as a ref)
//   controller events → store (currentIndex / state / progress / word)
//   default engine = Web Speech (instant); Kokoro lazy-loads on voice pick
//   with a loading indicator + auto-fallback to Web Speech on init failure.
//   per-doc progress + global settings persisted via plugin-store.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { loadPdf } from "@/lib/pdf/loader";
import { buildCharMap } from "@/lib/pdf/extract";
import { segment } from "@/lib/text/segment";
import { getEngine, getEngines, listAllVoices, KOKORO_AVAILABLE } from "@/lib/tts";
import type { Voice } from "@/lib/tts/engine";
import {
  PlayerControllerImpl,
  type PlayerController,
} from "@/lib/player/controller";
import { useReaderStore } from "@/lib/store/useReaderStore";
import {
  getDocProgress,
  listRecents,
  loadSettings,
  saveDocProgress,
  saveSettings,
  type RecentDoc,
} from "@/persist/progress";
import { Toaster } from "@/components/ui/sonner";
import Library from "@/components/Library";
import Reader from "@/components/Reader";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function stripExt(name: string): string {
  return name.replace(/\.pdf$/i, "").trim() || "Untitled paper";
}

export default function App() {
  const view = useReaderStore((s) => s.view);

  // The imperative player lives outside React state; we mirror it into one
  // piece of state so the Reader subtree re-renders when it (re)appears.
  const [controller, setController] = useState<PlayerController | null>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  // Bumped on every voice pick. A backgrounded Kokoro download checks this before
  // hot-swapping, so a newer pick (other voice / back to System / new doc) wins.
  const selectionToken = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const settingsReady = useRef(false);

  // ---- controller event plumbing → store --------------------------------
  const attachController = useCallback((c: PlayerController) => {
    c.on("segment", (i) => useReaderStore.getState().setCurrentIndex(i));
    c.on("state", (s) => useReaderStore.getState().setPlayerState(s));
    c.on("progress", (f) => useReaderStore.getState().setProgress(f));
    c.on("word", (ci, cl) =>
      useReaderStore.getState().setWordRange({ start: ci, length: cl }),
    );
  }, []);

  // ---- one-time bootstrap: voices + settings + recents -------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const st = useReaderStore.getState();
      try {
        const voices = await listAllVoices();
        if (cancelled) return;
        st.setVoices(voices);

        const saved = await loadSettings();
        if (cancelled) return;
        if (saved) {
          if (typeof saved.rate === "number") st.setRate(saved.rate);
          if (typeof saved.volume === "number") st.setVolume(saved.volume);
          if (typeof saved.skipRefs === "boolean")
            st.setSkipRefs(saved.skipRefs);
          if (typeof saved.skipTables === "boolean")
            st.setSkipTables(saved.skipTables);
          if (typeof saved.stripCitations === "boolean")
            st.setStripCitations(saved.stripCitations);
          if (typeof saved.stripParentheticals === "boolean")
            st.setStripParentheticals(saved.stripParentheticals);
          if (typeof saved.zoom === "number") st.setZoom(saved.zoom);
          if (saved.pdfTheme === "light" || saved.pdfTheme === "dark")
            st.setPdfTheme(saved.pdfTheme);
        }

        // Boot on Web Speech (instant). Restore a saved *system* voice if it
        // still exists; otherwise pick a default English system voice. Kokoro
        // voices are never auto-loaded on boot — they load lazily on pick.
        const sys = voices.filter((v) => v.engine === "webspeech");
        let chosen: Voice | undefined;
        if (saved?.voiceId) chosen = sys.find((v) => v.id === saved.voiceId);
        if (!chosen)
          chosen =
            sys.find((v) => v.lang.toLowerCase().startsWith("en")) ?? sys[0];
        if (chosen) {
          st.setVoiceId(chosen.id);
          st.setEngineId("webspeech");
        }

        const recents = await listRecents();
        if (!cancelled) st.setRecents(recents);
      } catch (e) {
        console.error("[App] bootstrap failed", e);
      } finally {
        settingsReady.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- persist global settings on change ---------------------------------
  const voiceId = useReaderStore((s) => s.voiceId);
  const rate = useReaderStore((s) => s.rate);
  const volume = useReaderStore((s) => s.volume);
  const engineId = useReaderStore((s) => s.engineId);
  const skipRefs = useReaderStore((s) => s.skipRefs);
  const skipTables = useReaderStore((s) => s.skipTables);
  const stripCitations = useReaderStore((s) => s.stripCitations);
  const stripParentheticals = useReaderStore((s) => s.stripParentheticals);
  const pdfTheme = useReaderStore((s) => s.pdfTheme);
  const zoom = useReaderStore((s) => s.zoom);
  useEffect(() => {
    if (!settingsReady.current) return;
    void saveSettings({ voiceId, rate, volume, engineId, skipRefs, skipTables, stripCitations, stripParentheticals, pdfTheme, zoom });
  }, [voiceId, rate, volume, engineId, skipRefs, skipTables, stripCitations, stripParentheticals, pdfTheme, zoom]);

  // ---- per-doc progress (throttled) --------------------------------------
  const currentIndex = useReaderStore((s) => s.currentIndex);
  useEffect(() => {
    const st = useReaderStore.getState();
    const hash = st.docHash;
    if (!hash || st.segments.length === 0) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveDocProgress(hash, {
        title: st.docTitle,
        path: st.docPath ?? undefined,
        lastSegment: useReaderStore.getState().currentIndex,
        totalSegments: st.segments.length,
        updatedAt: Date.now(),
      });
    }, 1200);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [currentIndex]);

  // ---- tear the controller down on unmount -------------------------------
  useEffect(
    () => () => {
      controllerRef.current?.destroy();
    },
    [],
  );

  // ---- the open-PDF pipeline (PLAN §2) -----------------------------------
  const openPdf = useCallback(
    async (bytes: Uint8Array, fileName: string, path: string | null) => {
      const st = useReaderStore.getState();
      st.startParsing(stripExt(fileName));
      st.setView("reader");
      try {
        const doc = await loadPdf(bytes);
        st.setParseMessage("Extracting text…");
        const charMap = await buildCharMap(doc, { skipTables: useReaderStore.getState().skipTables });
        st.setParseMessage("Building sentences…");
        const segs = segment(charMap, {
          skipRefs: useReaderStore.getState().skipRefs,
          stripCitations: useReaderStore.getState().stripCitations,
          stripParentheticals: useReaderStore.getState().stripParentheticals,
        });
        const pageSizes = charMap.pages.map((p) => ({
          width: p.width,
          height: p.height,
        }));

        // Stable resume key = SHA-256 of the file bytes (Rust command). Prefer
        // a path (keeps big PDFs off the IPC bridge); fall back to raw bytes for
        // drag-dropped files that never touched the filesystem.
        let hash: string | null = null;
        try {
          if (inTauri())
            hash = await invoke<string>(
              "doc_hash",
              path ? { path } : { bytes: Array.from(bytes) },
            );
        } catch (e) {
          console.warn("[App] doc_hash failed", e);
        }

        const title = stripExt(fileName);
        st.setDoc({ doc, charMap, segments: segs, pageSizes, title, hash, path });

        // (Re)build the player for this document.
        controllerRef.current?.destroy();
        const c = new PlayerControllerImpl();
        attachController(c);
        controllerRef.current = c;
        setController(c);

        const cur = useReaderStore.getState();
        const engine = getEngine(cur.engineId);
        try {
          await engine.init?.();
        } catch (e) {
          console.warn("[App] engine init failed", e);
        }
        await c.load(segs, engine, cur.voiceId, cur.rate, cur.volume);

        // Resume at the saved position (if any) + stamp this doc into recents.
        let resumeAt = 0;
        if (hash) {
          const rec = await getDocProgress(hash);
          if (
            rec &&
            rec.lastSegment > 0 &&
            rec.lastSegment < segs.length
          ) {
            resumeAt = rec.lastSegment;
            c.seekToSegment(resumeAt);
          }
          void saveDocProgress(hash, {
            title,
            path: path ?? undefined,
            lastSegment: resumeAt,
            totalSegments: segs.length,
            updatedAt: Date.now(),
          });
        }
      } catch (e) {
        console.error("[App] failed to open PDF", e);
        toast.error("Couldn't open that PDF.");
        const s2 = useReaderStore.getState();
        s2.setError("Failed to parse the PDF.");
        s2.setView("library");
      }
    },
    [attachController],
  );

  const openRecent = useCallback(
    async (doc: RecentDoc) => {
      if (doc.path && inTauri()) {
        try {
          const bytes = await invoke<number[]>("read_file_bytes", {
            path: doc.path,
          });
          await openPdf(new Uint8Array(bytes), doc.title, doc.path);
        } catch (e) {
          console.error("[App] reopen recent failed", e);
          toast.error("Couldn't reopen that file — it may have moved.");
        }
      } else {
        toast.error(
          "Drop the PDF again to reopen it — drag-and-drop files aren't stored.",
        );
      }
    },
    [openPdf],
  );

  // ---- voice / engine lifecycle (lazy Kokoro + auto-fallback) ------------
  const fallbackToSystemVoice = useCallback(async () => {
    const st = useReaderStore.getState();
    const ws = getEngines().webspeech;
    try {
      await ws.init();
    } catch {
      /* still try to set the voice below */
    }
    const sys = st.voices.filter((v) => v.engine === "webspeech");
    const fb =
      sys.find((v) => v.lang.toLowerCase().startsWith("en")) ?? sys[0];
    if (!fb) return;
    try {
      await controllerRef.current?.setVoice(ws, fb.id);
    } catch (e) {
      console.error("[App] fallback setVoice failed", e);
    }
    st.setVoiceId(fb.id);
    st.setEngineId("webspeech");
  }, []);

  // Pre-warm Kokoro the moment the voice dropdown opens, so the sidecar boot + ~80 MB
  // one-time model download overlaps with reading instead of blocking the first pick.
  // Safe to call repeatedly: SidecarKokoroEngine.init() shares one initPromise + one
  // sidecar, and the engine's monotonic clamp keeps the bar moving forward. We
  // intentionally do NOT reset kokoroProgress here — init's first progress event sets it
  // (setKokoroProgress takes a number, not an updater).
  const prewarmKokoro = useCallback(() => {
    if (!KOKORO_AVAILABLE) return; // defensive: only no-ops if Kokoro is ever toggled off
    const kokoro = getEngines().kokoro;
    if (kokoro.ready) return; // already loaded — nothing to do
    const st = useReaderStore.getState();
    st.setKokoroLoading(true);
    kokoro
      .init((f) => useReaderStore.getState().setKokoroProgress(f))
      .then(() => useReaderStore.getState().setKokoroLoading(false))
      .catch((e) => {
        // No toast on pre-warm: the user hasn't committed to Kokoro yet. selectVoice's
        // own path surfaces the error + falls back if they actually pick a Kokoro voice.
        console.warn("[App] Kokoro pre-warm failed", e);
        useReaderStore.getState().setKokoroLoading(false);
      });
  }, []);

  const selectVoice = useCallback(
    async (voice: Voice) => {
      const st = useReaderStore.getState();
      const engines = getEngines();
      const myToken = ++selectionToken.current; // invalidate any pending Kokoro swap
      const c0 = controllerRef.current; // guard against a rebuilt/closed controller

      // Kokoro is served by the Node sidecar (KOKORO_AVAILABLE=true). Defensive: if
      // Kokoro is ever toggled off, transparently stay on a working system voice.
      if (voice.engine === "kokoro" && !KOKORO_AVAILABLE) {
        await fallbackToSystemVoice();
        return;
      }

      if (voice.engine === "kokoro") {
        const kokoro = engines.kokoro;

        // Reflect intent in the UI right away (dropdown shows the chosen voice instantly).
        st.setVoiceId(voice.id);
        st.setEngineId("kokoro");

        // Already warm → swap immediately (still token-guarded).
        if (kokoro.ready) {
          try {
            if (myToken === selectionToken.current)
              await c0?.setVoice(kokoro, voice.id);
          } catch (e) {
            console.error("[App] setVoice(kokoro) failed", e);
            toast.error("Kokoro playback failed — switching to a system voice.");
            if (myToken === selectionToken.current)
              await fallbackToSystemVoice();
          }
          return;
        }

        // Cold model: DO NOT block. Web Speech keeps playing during the download; hot-swap
        // to Kokoro the instant init resolves. (No setKokoroProgress(0) — see note above.)
        st.setKokoroLoading(true);
        kokoro
          .init((f) => useReaderStore.getState().setKokoroProgress(f))
          .then(async () => {
            useReaderStore.getState().setKokoroLoading(false);
            // Stale-guards: newer pick, rebuilt/closed controller, or the store no longer
            // shows this exact Kokoro voice → no-op (the download still cached the model).
            if (myToken !== selectionToken.current) return;
            if (controllerRef.current !== c0) return;
            const now = useReaderStore.getState();
            if (now.engineId !== "kokoro" || now.voiceId !== voice.id) return;
            try {
              // setVoice() bumps the controller token, cancels the live Web-Speech utterance,
              // clears the cache, and — iff it was playing — resumes the CURRENT segment on
              // Kokoro: a seamless mid-playback swap on the same sentence.
              await c0?.setVoice(kokoro, voice.id);
            } catch (e) {
              console.error("[App] setVoice(kokoro) after load failed", e);
              toast.error("Kokoro playback failed — switching to a system voice.");
              if (myToken === selectionToken.current)
                await fallbackToSystemVoice();
            }
          })
          .catch(async (e) => {
            console.error("[App] Kokoro init failed", e);
            useReaderStore.getState().setKokoroLoading(false);
            if (myToken !== selectionToken.current) return;
            toast.error(
              "Couldn't load the Kokoro voice — switching to a system voice.",
            );
            await fallbackToSystemVoice();
          });
        return; // non-blocking — return to the caller immediately
      }

      // System (Web Speech) voice. Bumping selectionToken above already invalidates any
      // in-flight Kokoro swap, so picking System mid-download cleanly wins.
      const ws = engines.webspeech;
      try {
        await ws.init();
      } catch {
        /* listVoices already ran during bootstrap */
      }
      try {
        if (myToken === selectionToken.current)
          await c0?.setVoice(ws, voice.id);
      } catch (e) {
        console.error("[App] setVoice(webspeech) failed", e);
      }
      if (myToken === selectionToken.current) {
        st.setVoiceId(voice.id);
        st.setEngineId("webspeech");
      }
    },
    [fallbackToSystemVoice],
  );

  // ---- back to library ---------------------------------------------------
  const closeReader = useCallback(() => {
    const st = useReaderStore.getState();
    if (st.docHash && st.segments.length > 0) {
      void saveDocProgress(st.docHash, {
        title: st.docTitle,
        path: st.docPath ?? undefined,
        lastSegment: st.currentIndex,
        totalSegments: st.segments.length,
        updatedAt: Date.now(),
      });
    }
    controllerRef.current?.destroy();
    controllerRef.current = null;
    setController(null);
    st.closeDoc();
    void (async () => {
      const recents = await listRecents();
      useReaderStore.getState().setRecents(recents);
    })();
  }, []);

  return (
    <>
      {view === "reader" ? (
        <Reader
          controller={controller}
          onSelectVoice={selectVoice}
          onPrewarmKokoro={prewarmKokoro}
          onClose={closeReader}
        />
      ) : (
        <Library onOpenFile={openPdf} onOpenRecent={openRecent} />
      )}
      <Toaster position="bottom-right" closeButton />
    </>
  );
}
