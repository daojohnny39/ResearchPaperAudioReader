# Research Paper Audio Reader — Build Plan

A **desktop app** (macOS, Tauri v2) that ingests a PDF research paper, extracts its text,
renders the paper, and reads it aloud like an audiobook with a smooth local voice — while
**highlighting the sentence being spoken on the rendered PDF**, auto-scrolling, letting the
user **pick where to start**, and **click any text in the PDF to start reading there**.

**Local / no API keys / no cost.** TTS = local **Kokoro** + system **Web Speech**.
**Offline nuance (per Codex review):** Web Speech works fully offline immediately. Kokoro downloads its
~80–330 MB ONNX model + voice tensors from Hugging Face **once on first use** (then cached by the
WebView's Cache API / IndexedDB and reused offline). App is fully usable on Web Speech before/without that.

---

## 0. Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Platform | **Tauri v2** desktop (Rust backend + webview frontend) | true local file access, offline TTS, native macOS app |
| Frontend | **Vite + React 18 + TypeScript** | canonical Tauri frontend, fast HMR |
| Styling | **Tailwind CSS + shadcn/ui** (Radix) | impeccable UI, accessible primitives |
| PDF | **pdfjs-dist pinned `4.10.38`** (`new TextLayer().render()`; `renderTextLayer` is deprecated) | positions for highlight + click-to-read; bare `npm i` now pulls v6 — pin to avoid API drift |
| Virtualization | **@tanstack/react-virtual** | don't hand-roll page virtualization |
| Segmentation | **Intl.Segmenter** (sentence granularity) | built-in, no dep, locale-aware |
| TTS primary | **Kokoro** via `kokoro-js` (`@huggingface/transformers` ort-web, **`device:'wasm'`**, run in a **Web Worker**) | high-quality, local, multiple voices, free; WASM (not WebGPU) for WKWebView; worker avoids main-thread jank |
| TTS fallback | **Web Speech API** (`speechSynthesis`) | zero-setup, always works, word-boundary events |
| State | **Zustand** | small, no boilerplate |
| Persistence | **`@tauri-apps/plugin-store`** (settings + per-doc progress) + appdata audio cache | resume position, cache generated audio |
| Icons | **lucide-react** | consistent SVG set (no emoji) |

Toolchain verified present: node 22.22, cargo 1.83, full Xcode, git 2.47. Tauri CLI installed during scaffold. Use **npm** (no pnpm).

---

## 1. UX flow

1. **Library view** — big drag-drop zone ("Drop a research paper PDF here") + recent papers list (thumbnail, title, % read, last opened). Click recent → resume at saved position.
2. Drop / pick a PDF → parse (render first page fast, extract text + build position map in background, show progress) → enter **Reader view**.
3. **Reader view** — split:
   - **Main**: rendered PDF pages (virtualized vertical scroll). Currently-spoken sentence highlighted; view auto-scrolls to keep it visible. Click any text → reading jumps to that sentence.
   - **Sidebar (slim, collapsible)**: document outline / sentence-segment list (click to jump = "choose where to start"), overall reading progress, voice + speed quick info.
   - **Bottom transport bar**: play/pause, prev/next sentence (skip), restart, scrub progress, speed (0.75–2.0×), **voice picker** (Kokoro voices + system voices grouped), engine status (model loading indicator for Kokoro).
4. Position auto-saved per document; reopening resumes.

---

## 2. Architecture & data flow

```
PDF bytes
  │  pdfjs getDocument
  ▼
PdfDoc ── render pages (canvas + textLayer) ──► PdfViewer
  │
  │  extract.ts: getTextContent(page) for all pages
  ▼
CharMap  (full ordered document text + per-item bbox + char offsets, column-aware)
  │  segment.ts: Intl.Segmenter over CharMap.text
  ▼
Segment[]  (sentence text, [charStart,charEnd), page, bboxes[])
  │
  ├──────────────► Sidebar (segment list / start picker)
  │
PlayerController(segments, engine, voice, rate)
  │   for current segment i:
  │     - engine.speak(seg.text)  → audio (Kokoro WAV blob) OR native playback (WebSpeech)
  │     - prefetch i+1, i+2 (Kokoro) for gapless
  │     - on play: highlight seg.bboxes in PdfViewer + autoscroll
  │     - on segment end: advance i+1
  │   events: 'segment'(i), 'state'(playing/paused/loading), 'progress'(0..1)
  ▼
PdfViewer.HighlightLayer  ◄── currentSegment bboxes (PDF coords → viewport px)
PdfViewer click on text span ──► offset → nearest segment ──► controller.seekToSegment(i)
```

---

## 3. File layout (contracts established in Scaffold phase as typed stubs)

```
ResearchPaperAudioReader/
├─ package.json            # all deps installed in scaffold
├─ vite.config.ts
├─ tailwind.config.ts  postcss.config.js  components.json (shadcn)
├─ index.html
├─ tsconfig*.json
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx                       # view router: Library | Reader  (shell in scaffold, wired in integrate)
│  ├─ index.css                     # tailwind + theme tokens (design spec §6)
│  ├─ lib/
│  │  ├─ pdf/
│  │  │  ├─ types.ts                # BBox, PdfTextItem, PageLayout, CharMap, PdfDoc
│  │  │  ├─ loader.ts               # loadPdf(bytes): Promise<PdfDoc>  (pdfjs worker setup)
│  │  │  └─ extract.ts              # buildCharMap(pdfDoc): Promise<CharMap>  (column-aware order, dehyphenation)
│  │  ├─ text/
│  │  │  └─ segment.ts              # segment(charMap): Segment[]   (Intl.Segmenter + cleanup)
│  │  ├─ tts/
│  │  │  ├─ engine.ts               # TtsEngine, Voice, SpeakResult, Boundary interfaces + registry types
│  │  │  ├─ webspeech.ts            # WebSpeechEngine (native playback + onboundary words)
│  │  │  ├─ kokoro.ts               # KokoroEngine (kokoro-js, lazy model load, WAV blob, prefetch-safe)
│  │  │  └─ index.ts                # getEngines(), listAllVoices()
│  │  ├─ player/
│  │  │  └─ controller.ts           # PlayerController (queue, prefetch, seek, rate, events)
│  │  └─ store/
│  │     └─ useReaderStore.ts       # zustand: view, doc, segments, currentIndex, settings, progress, status
│  ├─ persist/
│  │  └─ progress.ts                # load/save per-doc position (hash key) + global settings via plugin-store
│  └─ components/
│     ├─ Library.tsx                # landing: DropZone + recents
│     ├─ DropZone.tsx               # drag-drop + file dialog
│     ├─ Reader.tsx                 # split layout container
│     ├─ PdfViewer.tsx              # virtualized pages
│     ├─ PdfPage.tsx                # one page: canvas + text layer + click handler
│     ├─ HighlightLayer.tsx         # absolute-positioned highlight boxes for current segment
│     ├─ Sidebar.tsx                # outline / segment list / progress
│     ├─ PlayerBar.tsx              # transport controls
│     ├─ VoicePicker.tsx            # grouped voices (Kokoro / System) + speed
│     └─ ui/                        # shadcn components (button, slider, select, scroll-area, progress, tooltip, sonner...)
└─ src-tauri/
   ├─ Cargo.toml
   ├─ tauri.conf.json               # window, plugins(fs, store, dialog), drag-drop enabled, CSP allows wasm + blob + HF model fetch
   ├─ build.rs
   └─ src/
      ├─ main.rs
      ├─ lib.rs                     # builder, register plugins + commands
      └─ commands.rs                # read_file_bytes(path), audio cache get/put, doc hash
```

---

## 4. Core interfaces (frozen contracts — every module codes against these)

```ts
// lib/pdf/types.ts
export interface BBox { page: number; x: number; y: number; w: number; h: number } // PDF user-space units
export interface PdfTextItem { str: string; charStart: number; charEnd: number; bbox: BBox; itemIndex: number; line: number }
export interface PageLayout { page: number; width: number; height: number; items: PdfTextItem[] }
export interface PdfDoc { numPages: number; raw: unknown /* pdfjs PDFDocumentProxy */; getPage(n: number): Promise<unknown> }
export interface CharMap {
  text: string;                                   // full ordered document text
  pages: PageLayout[];
  rangeToBBoxes(start: number, end: number): BBox[];   // merged per line
  offsetToPage(offset: number): number;
  spanToOffset(page: number, itemIndex: number, charInItem: number): number; // click → char offset
}

// lib/text/segment.ts
export interface Segment {
  index: number; text: string;
  charStart: number; charEnd: number;
  page: number; bboxes: BBox[];
}
export function segment(map: CharMap): Segment[];

// lib/tts/engine.ts
export type EngineId = 'kokoro' | 'webspeech';
export interface Voice { id: string; label: string; engine: EngineId; lang: string; }
export interface Boundary { charIndex: number; charLength: number; audioTimeMs: number; } // word-level when available
export interface SpeakResult {
  native: boolean;            // true => engine plays itself (WebSpeech), no audioUrl
  audioUrl?: string;          // blob: URL for generated WAV (Kokoro)
  durationMs?: number;
  boundaries?: Boundary[];
}
export interface TtsEngine {
  id: EngineId;
  ready: boolean;
  init(): Promise<void>;
  listVoices(): Promise<Voice[]>;
  // Kokoro: returns audioUrl. WebSpeech: returns {native:true} and is driven via playNative.
  speak(text: string, opts: { voiceId: string; rate: number }): Promise<SpeakResult>;
  playNative?(text: string, opts: { voiceId: string; rate: number },
              cbs: { onBoundary?: (b: Boundary) => void; onEnd: () => void; onError: (e: unknown) => void }
             ): { cancel(): void };
}

// lib/player/controller.ts
export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';
export interface PlayerEvents {
  segment: (index: number) => void;
  word: (charIndex: number, charLength: number) => void; // optional word highlight
  state: (s: PlayerState) => void;
  progress: (fraction: number) => void;
}
export interface PlayerController {
  load(segments: Segment[], engine: TtsEngine, voiceId: string, rate: number): Promise<void>;
  play(): void; pause(): void; toggle(): void;
  next(): void; prev(): void; seekToSegment(index: number): void;
  setRate(rate: number): void;
  setVoice(engine: TtsEngine, voiceId: string): Promise<void>;
  on<K extends keyof PlayerEvents>(e: K, cb: PlayerEvents[K]): () => void;
  readonly currentIndex: number;
  destroy(): void;
}
```

Scaffold phase writes every file above with these types + throwing/`TODO` stub bodies so the repo **typechecks from commit 1**. Build phase fills bodies only.

---

## 5. The hard parts (explicit guidance)

### 5.1 Column-aware reading order (research papers are often 2-column)
- pdfjs `getTextContent()` items are in **stream order**, not visual order.
- Per page: cluster items by x-midpoint into columns (detect a large horizontal gap near page center; if found → 2 columns, else 1). Within each column sort by `-y` (top→bottom) then `x`. Concatenate column-1 then column-2.
- Group items into **lines** by similar baseline `y` (tolerance). Join words with spaces; track each item's `charStart/charEnd` into the global `text`.
- **Dehyphenation**: if a line ends with `-` and next line starts lowercase, join without hyphen.
- Skip running headers/footers heuristically: lines repeated (same text) at top/bottom across many pages, and bare page numbers.
- v1 = heuristic. Note future upgrade: GROBID/Marker for perfect order + reference/figure handling.

### 5.2 char ↔ bbox mapping
- While building `text`, each `PdfTextItem` records `charStart/charEnd` + `bbox` (PDF user space, origin bottom-left).
- `rangeToBBoxes(s,e)`: collect items whose `[charStart,charEnd)` overlaps `[s,e)`; merge same-line adjacent boxes into one rect per line.

### 5.3 Highlight overlay on the rendered page
- Each `PdfPage` keeps its pdfjs `viewport` (scale-aware). Convert a PDF-space BBox to CSS px with `viewport.convertToViewportRectangle([x, y, x+w, y+h])` then normalize min/max.
- `HighlightLayer` renders absolutely-positioned divs (rounded, accent-tinted, `mix-blend`/low-opacity) sized in CSS px over the canvas. Animate opacity on change (150–250ms), respect `prefers-reduced-motion`.

### 5.4 Click-to-read
- pdfjs **text layer** renders `<span>`s per text item over the canvas (selectable). Tag each span with `data-page` + `data-item-index`. On click: compute char-in-item from caret (use clicked span start as approximation), `spanToOffset` → find segment whose range contains the offset → `controller.seekToSegment(i)`; start playing.

### 5.5 Gapless playback + prefetch
- Kokoro: maintain a small queue. While segment *i* plays via an `<audio>`/WebAudio buffer, generate *i+1* (and *i+2*) WAV blobs in the background; cache by `hash(text+voice+rate)` to disk via Tauri command + in-memory LRU. On `ended` → advance, swap to prebuilt blob.
- WebSpeech: `playNative` drives `SpeechSynthesisUtterance`; queue next on `onend`; map `onboundary` (word) → `word` event for optional word-level highlight.
- `setRate` mid-stream: Kokoro re-render upcoming (rate baked into audio) or use playbackRate on the audio element (cheaper — prefer `audio.playbackRate`); WebSpeech set `utterance.rate`.

### 5.6 Kokoro in the WKWebView (risk + mitigation)
- `kokoro-js` uses onnxruntime-web (WASM; WebGPU if available). WKWebView on recent macOS runs WASM fine; WebGPU may be unavailable → falls back to WASM (slower but works). Model (~80–330 MB) fetched once from HF and cached (allow in CSP / cache to appdata).
- **Mitigation**: lazy-load Kokoro only when a Kokoro voice is selected; show a "Loading voice model…" state; **Web Speech is the always-available default** so the app is usable instantly. If Kokoro init fails, toast + auto-fallback to Web Speech.
- Future upgrade noted: native Rust `ort` (onnxruntime) Kokoro as a Tauri command, or a bundled sidecar, for speed + no first-run download.

### 5.7 Narration cleanup for papers (v1 heuristics)
- Collapse whitespace, dehyphenate, drop repeated headers/footers + bare page numbers, optionally **skip the References/Bibliography section** (toggle), keep inline citations as-is (or strip `[12]`-style markers via toggle). Equations/figures: read surrounding caption text; skip raw math glyph noise where detectable. Future: LLM cleanup pass (out of scope v1).

### 5.8 Tauri specifics
- **Drag-drop**: enable `dragDropEnabled` in `tauri.conf.json`; listen to drag-drop event → get file path(s) → `read_file_bytes` Rust command → `Uint8Array` → pdfjs. Also a "Browse" button via `@tauri-apps/plugin-dialog`.
- **CSP**: allow `wasm-unsafe-eval`, `blob:` (audio + worker), and HF model host for first-run download; `connect-src` for HF CDN.
- **pdfjs worker**: bundle worker via Vite (`pdfjs-dist/build/pdf.worker.min.mjs?url`) — no CDN.
- **Persistence**: `plugin-store` JSON: `{ settings:{voiceId,rate,engine,skipRefs}, docs:{ [hash]:{ title, lastSegment, totalSegments, updatedAt, path } } }`. Doc hash = sha of file bytes (Rust command) for stable resume.

---

## 6. Design spec (front-end) — calm dark reading

Derived from the design skill (Inter type, micro-interactions, full dark mode), refined for **long-reading comfort**: warm-neutral dark surfaces, single calm accent, amber highlight for the spoken sentence.

- **Theme**: dark default (light optional later). Semantic tokens via CSS vars + Tailwind.
- **Palette (dark)**:
  - `--background` `#0F1115` (warm near-black), `--surface` `#161A20`, `--surface-2` `#1E232B`
  - `--foreground` `#E6E8EC` (primary text ≥ 4.5:1), `--muted-foreground` `#9AA3AF` (secondary ≥ 3:1)
  - `--border` `#2A2F38`
  - `--primary` (calm teal) `#2DD4BF`, `--on-primary` `#04201D`
  - `--accent` / spoken-sentence highlight: warm amber `#F5B252` at ~22% bg fill + 1px amber border (high contrast on dark, easy on eyes), text stays full-contrast
  - `--ring` `#2DD4BF`; `--destructive` `#F87171`
- **Light palette** (tokens defined, parity contrast): bg `#FAFAF8`, surface `#FFFFFF`, fg `#1A1D23`, highlight amber tint on light.
- **Typography**: **Inter** for UI (300–700). Reading/segment list may use Inter too; optional serif (`Source Serif 4`) for long body feel — Inter is fine for v1. Type scale `12 / 14 / 16 / 18 / 24 / 32`, body 16, line-height 1.6. Tabular figures for timers/progress.
- **Spacing**: 4/8 px rhythm. Transport bar height 64px; sidebar 280px (collapsible to icon rail).
- **Components (shadcn)**: button, slider (scrub + speed), select/command (voice picker), scroll-area, progress, tooltip, sonner (toasts), separator, toggle, skeleton (parse/model loading), dialog.
- **Motion**: 150–250ms ease-out; highlight crossfade; spinner/skeleton for parse + model load; everything respects `prefers-reduced-motion`.
- **A11y**: focus rings visible, voice picker keyboard-navigable, transport buttons have aria-labels + tooltips, highlight not color-only (also auto-scroll + sidebar active row). Contrast verified ≥ 4.5:1.
- **Empty/loading states**: dropzone empty state, "Parsing paper…" skeleton over pages, "Loading Kokoro voice…" inline in voice picker.

---

## 7. Workflow execution plan (how the app gets built) — SPIKE-FIRST (per Codex review)

Codex flagged that the "frozen interfaces" only become real once the two hard integrations
(Kokoro-in-WKWebView, pdfjs TextLayer+highlight+click) are proven. So: **scaffold → prove both
hard integrations → only then parallelize the rest.** Non-ECO normal workflow (agents inherit
session model). Single git repo, disjoint file ownership per parallel agent; deps installed only
in Scaffold + Integrate. Test fixture: `fixtures/sample.pdf` (Attention Is All You Need, 2-column arXiv).

- **Phase 1 — Scaffold (1 agent):**
  - Scaffold Tauri v2 + React-TS-Vite **without** the non-empty-dir error: `cd /tmp && npm create tauri-app@latest rpar -- --template react-ts --manager npm -y`, then copy generated files into the project dir (which already holds `PLAN.md`, `fixtures/`), then `npm install`.
  - Install deps (pin pdfjs): `npm i pdfjs-dist@4.10.38 kokoro-js @huggingface/transformers zustand lucide-react @tanstack/react-virtual @tauri-apps/api @tauri-apps/plugin-store @tauri-apps/plugin-dialog @tauri-apps/plugin-fs`.
  - Tailwind + shadcn init; add ui: button slider select command scroll-area progress tooltip sonner separator toggle skeleton dialog.
  - Rust: add `tauri-plugin-store tauri-plugin-dialog tauri-plugin-fs` to `Cargo.toml`, register in `lib.rs`; **create `src-tauri/capabilities/default.json`** granting `store:default`, `dialog:default`, `fs:allow-read-file` (+ scope).
  - `tauri.conf.json`: window 1200×820 dark; `app.security.csp` + `devCsp` per §10.4; **`app.windows[].dragDropEnabled: false`** (let HTML5 DOM drop work); bundle pdfjs worker + cMaps + standard fonts via Vite (`?url` + copy to public, set `cMapUrl`/`standardFontDataUrl`).
  - Write **all** §3 files as typed stubs per §4 (throwing `TODO` bodies) + theme tokens in `index.css` (§6).
  - Gate: `npm run build` + `cd src-tauri && cargo check` green. Commit "scaffold".
- **Phase 2 — Spikes (2 agents, parallel — disjoint: `lib/tts/*` vs `lib/pdf/*`+viewer):**
  - **Spike A — TTS** (`lib/tts/*` + `public/tts.worker` + tiny harness): prove `KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',{dtype:'q8',device:'wasm'})` loads in the Tauri WebView, generate→playable audio, voice list, **sub-sentence chunking** for long input, Web Speech fallback, cancellation. Run Kokoro in a Web Worker. Finalize `TtsEngine` impl + real voice ids (§10.1).
  - **Spike B — PDF** (`lib/pdf/*` + `PdfPage`/`PdfViewer`/`HighlightLayer`): render `fixtures/sample.pdf`, build `CharMap` with **both `sourceItemIndex` + `readingOrderIndex`** and **source-span mapping** (§10.2), tag TextLayer spans, draw highlight overlay using the **same viewport** (rotation/cropbox/DPR-correct), implement **click→char via `caretRangeFromPoint`** → nearest segment. Verify visually-correct boxes on the 2-column fixture.
  - Each spike may refine the §4 interface for its module and must write the final shapes back into the shared `types.ts`/`engine.ts`. Gate: `npm run build` + `cargo check` green.
- **Phase 3 — Build remaining modules (parallel, disjoint files; depends on Phase 2 shapes):**
  - `lib/text/segment.ts` — §5.7 + Intl.Segmenter over CharMap source-span text
  - `lib/player/controller.ts` + `lib/store/useReaderStore.ts` + `persist/progress.ts` — §5.5 + cancellation tokens, blob-URL revoke, bounded LRU audio cache
  - `src-tauri/src/commands.rs` — read bytes, sha hash, audio cache get/put
  - `components/*` UI shell — Library, DropZone (HTML5 + dialog), Reader, Sidebar, PlayerBar, VoicePicker per §6
  - Rule: code against finalized interfaces; **no dep installs** (report missing); own files only.
- **Phase 4 — Integrate + verify (1 agent):**
  - Wire `App.tsx` (Library↔Reader) + store + controller + viewer + player; add any reported deps; fix typecheck/compile; `npm run build` + `cargo check`.
  - **Non-manual smoke**: launch `npm run tauri dev` (background ~60s) pointed at `fixtures/sample.pdf`; capture logs; assert window boots + first page renders (log marker) + no fatal console errors. Commit.
- **Phase 5 — Review + polish (parallel):**
  - Code-review agent: cancellation/prefetch races, blob revoke, cache bound, CharMap cleanup-vs-mapping edges, fallback paths → apply high-confidence fixes.
  - Design/a11y polish agent vs §6 checklist (contrast, focus, reduced-motion, spacing). Apply.
  - Final `npm run build` + `cargo check` green. Commit.

**Verification gates**: every phase ends green (`vite build` + `cargo check`). Phase 4 adds an automated boot/render smoke. Full `tauri build` bundle + manual "drop a PDF, hear it read" is offered after the workflow.

---

## 8. Risks & fallbacks

| Risk | Mitigation |
|---|---|
| Kokoro WASM slow / fails in WKWebView | Web Speech is default + always available; Kokoro lazy + auto-fallback on init error; prefetch hides latency |
| Multi-column reading order wrong | column heuristic; sidebar lets user jump; click-to-read recovers; GROBID future upgrade |
| First-run Kokoro model download (~100MB+) | progress UI; cache to appdata; app fully usable on Web Speech meanwhile |
| Click→exact char offset imprecise | snap to nearest segment start (good enough for "start here") |
| `tauri build` (full bundle) slow in CI/agent | workflow gates on `cargo check` + `vite build`, not full bundle |
| pdfjs worker / CSP issues in Tauri | bundle worker via Vite `?url`; explicit CSP for wasm/blob/HF |

---

## 9. Out of scope (v1)
LLM narration cleanup, cloud voices, EPUB/HTML import, annotations/notes, multi-window, Windows/Linux packaging (code stays portable), word-perfect math TTS.

---

## 10. Codex review — incorporated revisions (SUPERSEDES conflicting text above)

### 10.1 Verified `kokoro-js` API (from package source) + TTS rules
```ts
import { KokoroTTS, TextSplitterStream, env } from 'kokoro-js';
// run inside a Web Worker. WASM device for WKWebView.
const tts = await KokoroTTS.from_pretrained(
  'onnx-community/Kokoro-82M-v1.0-ONNX',
  { dtype: 'q8', device: 'wasm', progress_callback: p => postMessage({type:'progress', p}) }
);
const audio = await tts.generate(text, { voice: 'af_heart', speed: 1.0 }); // RawAudio @ 24kHz
const blob = audio.toBlob();        // -> blob: URL for <audio>, OR audio.toWav()
// streaming long text: for await (const {text, audio} of tts.stream(splitter, {voice})) {...}
```
- **Voices (real ids)** — en-us female: `af_heart`(A), `af_bella`(A-), `af_nicole`(B-), `af_aoede`,`af_kore`,`af_sarah`(C+), `af_nova`,`af_sky`,`af_alloy`; en-us male: `am_fenrir`,`am_michael`,`am_puck`(C+), `am_echo`,`am_onyx`; en-gb: `bf_emma`(B-),`bf_isabella`,`bm_george`,`bm_fable`(B). VoicePicker surfaces a curated subset (Heart, Bella, Nicole, Michael, Fenrir, Emma, Fable) + grade.
- **Long-input truncation**: Kokoro truncates long token sequences. Sentences over ~length budget are split into sub-chunks (use `TextSplitterStream` or split on clause punctuation); concatenate audio per **segment** so the **highlight stays sentence-level** (one segment = possibly several audio sub-chunks played back-to-back).
- **Word boundaries**: Kokoro gives none; Web Speech `onboundary` is unreliable in WebKit. **Design for segment-level highlight only.** `word` event in §4 is best-effort (Web Speech) and never required for correctness.
- **Offline**: model + `voices/*.bin` fetched from HF on first use, cached by WebView Cache API (`caches.open('kokoro-voices')`) + transformers cache. Document the one-time download; Web Speech covers offline-first.
- **`env.wasmPaths`**: set to a bundled ort-wasm path if HF/CDN wasm fetch is undesirable (optional hardening).

### 10.2 CharMap redesign — source-span mapping (not a single global offset)
- `PdfTextItem` carries **both** `sourceItemIndex` (original `getTextContent().items` order — what TextLayer divs map to) and `readingOrderIndex` (after column sort).
- Build text as an array of **spans** `{ text, page, sourceItemIndex, bbox, srcStart }`; the narration string is derived by concatenating spans **in reading order with cleanup applied**, while each output char keeps a back-pointer to its source span + source char. Cleanup (dehyphenation, header/footer strip, ref skip, citation strip) edits the *derived* layer; mapping survives because it points back to source spans.
- `rangeToBBoxes`, `offsetToPage`, `spanToOffset` operate over this span model. Highlight uses source-span bboxes for the chars in a segment's range.

### 10.3 pdfjs TextLayer + highlight + click
- Use `new TextLayer({ textContentSource, container, viewport }).render()` (not deprecated `renderTextLayer`). After render, iterate `textLayer.textDivs` and stamp `data-page` + `data-source-item-index`.
- Highlight overlay + canvas + text layer **share one `viewport`** (same `scale`, `rotation`). Convert PDF-space bbox via `viewport.convertToViewportRectangle(...)`, normalize min/max. Account for `devicePixelRatio` on the canvas; CSS sizes use viewport (CSS px) units.
- **Click→char**: `document.caretRangeFromPoint(x,y)` to get the caret within the span, or binary-search char by x within the clicked div's text metrics. Map (sourceItemIndex, charInItem) → narration offset via the span model → `segment` containing it → `seekToSegment`.

### 10.4 Tauri capabilities + CSP + drag-drop
- **`src-tauri/capabilities/default.json`** (required — commands are denied without it):
```json
{ "$schema":"../gen/schemas/desktop-schema.json","identifier":"default","windows":["main"],
  "permissions":["core:default","store:default","dialog:default",
    {"identifier":"fs:allow-read-file","allow":[{"path":"**"}]}] }
```
- **CSP** (`app.security.csp`): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost https://huggingface.co https://*.hf.co https://*.xethub.hf.co https://cdn-lfs.huggingface.co`. Separate **`devCsp`** loosened for Vite HMR (`ws:`, `http://localhost:*`).
- **`dragDropEnabled: false`** so the WebView delivers HTML5 DOM drag/drop to the DropZone; read dropped file bytes via `file.arrayBuffer()` (no path needed). "Browse" button uses `plugin-dialog` → path → `read_file_bytes` Rust command.

### 10.5 Robustness (build into player/controller + cache)
- **Cancellation tokens** on every async path (seek/play/setVoice/prefetch): a token bumped on seek aborts stale Kokoro generations and audio swaps.
- **Revoke blob URLs** when a segment leaves the prefetch window; **bounded LRU** for in-memory + disk audio cache (cap count/bytes).
- **Bundle for offline rendering**: pdfjs `pdf.worker.min.mjs` (Vite `?url`), `cmaps/`, `standard_fonts/` copied to `public/` and pointed at via `cMapUrl`/`standardFontDataUrl`.

### 10.6 Tests / fixtures
- `fixtures/sample.pdf` committed (2-column arXiv). Add unit checks for: column order, header/footer strip, hyphenation join, reference-section skip toggle, rotated-page bbox. Phase-4 smoke launches dev app on the fixture and asserts first-page render + no fatal errors via logs.
