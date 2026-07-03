# CLAUDE.md

Guidance for Claude Code working in this repo. For deep design rationale + the original
build spec, see **`PLAN.md`** (§4 = interface contracts, §6 = design spec, §10 = the
Codex-reviewed revisions that supersede earlier text). This file is the quick operational map.

## What this is

**Research Paper Audio Reader** — a **Tauri v2 desktop app** (macOS) that reads research-paper
PDFs aloud like an audiobook. Drop a PDF → it extracts text, renders the paper, and reads it with a
smooth local voice while **highlighting the spoken sentence on the rendered page**, auto-scrolling.
You can **choose where to start** (sidebar segment list) and **click any text in the PDF to read
from there**. Fully local — no cloud, no API keys.

## Commands

```bash
npm install              # also runs postinstall -> copy-pdfjs-assets.mjs (syncs pdfjs cmaps/fonts to public/)
npm run tauri dev        # run the app (compiles Rust, opens a window). THIS OPENS A GUI — don't run it from a non-interactive agent; it stays running.
npm run build            # tsc + vite build  (frontend gate — must stay green)
cd src-tauri && cargo check   # Rust gate — must stay green
npm run tauri build      # produce a distributable .app / .dmg (slow)
npm run sync:pdfjs       # re-copy pdfjs cmaps + standard_fonts into public/ (run if pdfjs-dist changes)
node scripts/validate-extract.mjs   # sanity-check PDF text extraction on fixtures/sample.pdf
```

Verification gate after any change: **`npm run build` AND `cargo check` both green.** GUI behavior
(drop a PDF, hear it read) is a manual step — test with `fixtures/sample.pdf` (Attention Is All You Need, 2-column arXiv).

## Environment requirements

- **Node 22**, **npm** (no pnpm). Full Xcode (macOS build).
- **Rust ≥ 1.85** (repo developed on 1.96). Several transitive deps require `edition2024` — Cargo < 1.85 fails to parse manifests. If `cargo check` errors with *"feature `edition2024` is required"*, upgrade Rust (`brew upgrade rust`), don't pin individual crates.
- **`pdfjs-dist` is pinned to `4.10.38`** — do not bump casually. v4 uses the `TextLayer` class (`new TextLayer().render()`); `renderTextLayer` is deprecated. v6 (what a bare `npm i` pulls) changes APIs.

## Architecture / data flow

```
PDF bytes ──loadPdf──► PdfDoc ──buildCharMap──► CharMap ──segment──► Segment[]
                                   │                                    │
                                   ▼                                    ▼
                           PdfViewer (render + highlight + click)   Sidebar / start picker
                                   │                                    │
                                   └──────────► PlayerController ◄───────┘
                                                   │  per segment: TtsEngine.speak / playNative
                                                   │  prefetch next, gapless advance
                                                   ▼
                                  events: segment / word / state / progress  ──► useReaderStore ──► UI
```

`App.tsx` is the integrator: owns the `PlayerControllerImpl` (in a ref), runs the open-PDF pipeline,
plumbs controller events into the store, manages voice/engine lifecycle (lazy Kokoro + auto-fallback),
and persists settings + per-doc progress.

## Directory map (who owns what)

```
src/
  App.tsx                      integration shell (Library ⇄ Reader, open-PDF pipeline, controller wiring)
  lib/
    pdf/   types.ts            BBox, PdfTextItem, PageLayout, PdfDoc, CharMap, Segment  (frozen interfaces)
           loader.ts           loadPdf(bytes) -> PdfDoc  (configures bundled worker + cMap/font URLs)
           extract.ts          buildCharMap(doc): column-aware order, source-span model, dehyphenation,
                               rangeToBBoxes / offsetToPage / spanToOffset, getPageSizes
    text/  segment.ts          segment(map, opts): Intl.Segmenter sentences; opts {skipRefs, stripCitations}
    tts/   engine.ts           TtsEngine / Voice / SpeakOptions / SpeakResult / Boundary types
           kokoro.ts           KokoroEngine (drives the worker, lazy init + progress, AbortSignal)
           kokoro.worker.ts    Kokoro runs HERE (off main thread): KokoroTTS.from_pretrained, generate, chunking
           webspeech.ts        WebSpeechEngine (native playback via playNative, best-effort word boundaries)
           index.ts            getEngines() / getEngine(id) / listAllVoices()  registry
    player/controller.ts       PlayerControllerImpl: queue, prefetch, seek, rate, voice swap, events,
                               cancellation tokens, blob-URL revoke, bounded LRU audio cache
    store/useReaderStore.ts    zustand store (view, doc, charMap, segments, currentIndex, settings, status…)
  persist/progress.ts          plugin-store: loadSettings/saveSettings, listRecents, getDocProgress/saveDocProgress
  components/                  DropZone, Library, Reader, PdfViewer, PdfPage, HighlightLayer,
                               Sidebar, PlayerBar, VoicePicker, ui/ (shadcn)
src-tauri/
  src/commands.rs              read_file_bytes, doc_hash (sha256), audio_cache_get/put, cache_get/put
  src/lib.rs                   plugin registration (store/dialog/fs) + invoke_handler
  capabilities/default.json    REQUIRED — grants store/dialog/fs perms; commands are denied without it
  tauri.conf.json              window, CSP + devCsp, dragDropEnabled:false
fixtures/sample.pdf            2-column test paper
scripts/                       copy-pdfjs-assets.mjs (postinstall), validate-extract.mjs
```

## Conventions & gotchas (read before touching these areas)

- **CharMap is a source-span model, not a flat string with naive offsets.** Each `PdfTextItem` keeps
  both `sourceItemIndex` (original `getTextContent().items` order — what TextLayer divs map to) and the
  reading-order position. Cleanup (dehyphenation, header/footer strip, ref skip, citation strip) edits a
  *derived* layer that points back to source spans. Don't replace this with plain string offsets — it
  breaks highlight + click mapping. `pages[p].items` is a marked-content-stripped **subset**; resolve a
  `sourceItemIndex` via the per-page map, not by array position.
- **One shared `viewport` per page.** Canvas, TextLayer, and HighlightLayer must all use the exact same
  `page.getViewport({scale})` (handles rotation/cropbox). Highlight rects come from
  `viewport.convertToViewportRectangle(...)`, normalized min/max. Canvas is DPR-scaled.
- **TextLayer span stamping**: after `.render()`, each `<span>` gets `data-page` + `data-source-item-index`.
  pdfjs emits one div per item whose `str` is defined — the same filter `extract.ts` uses, so indices align.
- **Click-to-read** uses `caretRangeFromPoint` → `caretPositionFromPoint` → x-binary-search fallback →
  `charMap.spanToOffset(...)` → nearest segment → seek.
- **Kokoro runs in a Web Worker, `device:'wasm'`** (NOT WebGPU — WKWebView). Model id
  `onnx-community/Kokoro-82M-v1.0-ONNX`, `dtype:'q8'`. Model + voices download from Hugging Face **once**
  (cached by the WebView Cache API), so first Kokoro use needs network; Web Speech is the offline-immediate
  default. **kokoro-js `generate()` returns a `RawAudio` with `.audio` (Float32Array) + `.toBlob()` — NOT
  `.data`** (it bundles its own nested transformers version).
- **Long sentences are sub-chunked** (Kokoro truncates long input). A segment may map to several audio
  sub-chunks played back-to-back, but **highlighting stays sentence-level**. No reliable word boundaries —
  the `word` event is best-effort (Web Speech only); never required for correctness.
- **Player robustness**: every async path (seek/play/setVoice/prefetch) carries a cancellation token to
  abort stale generations; blob URLs are revoked when a segment leaves the prefetch window; audio cache is
  a bounded LRU (memory + disk via Rust). Keep these when editing the controller.
- **Tauri drag-drop**: `dragDropEnabled:false` on purpose so the WebView delivers HTML5 DOM drag/drop —
  dropped files are read via `file.arrayBuffer()` (no path). The Browse button uses `plugin-dialog` → path
  → `invoke('read_file_bytes')`. Don't flip `dragDropEnabled` to true without rewriting DropZone.
- **CSP**: `connect-src` must keep the Hugging Face hosts (model download) and `worker-src`/`media-src`
  must keep `blob:`. There's a separate looser `devCsp` for Vite HMR.
- **Persistence keys** are the SHA-256 of the PDF bytes (`doc_hash`) for stable resume across moves.
  Drag-dropped files (no path) can't be reopened from recents — only dialog-opened files store a path.
- **Adding deps that pull edition2024 crates** → ensure Rust ≥ 1.85 first (see Environment).

## Design

Calm dark-mode reading UI (PLAN §6): warm-neutral dark surfaces, Inter (`@fontsource-variable/inter`),
single teal accent, **amber tint for the spoken-sentence highlight**, 4/8px spacing, 64px transport bar,
collapsible 280px sidebar. shadcn/ui + lucide icons (no emoji). Respect `prefers-reduced-motion`,
visible focus rings, aria-labels on icon buttons, contrast ≥ 4.5:1.

## Out of scope (v1)

LLM narration cleanup, cloud voices, EPUB/HTML import, annotations, multi-window, Windows/Linux packaging
(code stays portable), word-perfect math TTS.
