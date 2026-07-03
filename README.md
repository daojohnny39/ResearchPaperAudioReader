# ResearchPaperAudioReader

A desktop app that reads research-paper PDFs aloud like an audiobook. Drop in a PDF and it extracts the text, renders the paper, and reads it with a smooth local voice while highlighting the spoken sentence on the page and auto-scrolling. Pick a starting point from the sidebar, or click any text in the PDF to read from there. Fully local — no cloud, no API keys.

Built with [Tauri v2](https://v2.tauri.app/), React, and TypeScript.

## Features

- Sentence-level highlighting synced to speech, with auto-scroll
- Column-aware text extraction (handles 2-column papers, dehyphenation, reference skipping)
- Click anywhere in the PDF to start reading from that sentence
- Two voice engines:
  - **System voices** (Web Speech) — works offline immediately
  - **Kokoro** neural TTS — higher quality, runs locally; downloads the model from Hugging Face once on first use
- Adjustable speed, voice picker, per-document resume, recents library

## Prerequisites

- **Node.js 22+** and npm
- **Rust 1.85+** (some dependencies require `edition2024`)
- Platform build tools for Tauri v2 — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)

## Run it

```bash
npm install            # also syncs pdf.js + onnxruntime assets into public/
cd sidecar && npm install && cd ..   # deps for the Kokoro TTS sidecar
npm run tauri dev
```

Then drop a PDF into the window (a sample paper is included at `fixtures/sample.pdf`).

## Build a distributable

```bash
npm run tauri build
```

## Development

```bash
npm run build                        # typecheck + bundle the frontend
cd src-tauri && cargo check          # check the Rust side
node scripts/validate-extract.mjs    # sanity-check PDF text extraction against fixtures/sample.pdf
```
