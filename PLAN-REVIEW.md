# Plan Review Changelog

- Replaced stale/garbled plan text with ASCII-only Markdown so commands and paths are copyable.
- Corrected the Rust claim: this crate is edition 2021, while Rust 1.85+ is still required for transitive edition 2024 dependencies.
- Added the missing requirement to copy `sidecar/package-lock.json` and use `npm ci` in both root and sidecar for reproducible Windows installs.
- Tightened the sidecar native dependency section to the actual locked graph: `kokoro-js@1.2.1`, nested `@huggingface/transformers@3.8.1`, `onnxruntime-node@1.21.0`, `sharp@0.34.5`, and win32-x64 optional packages.
- Fixed the nvm-windows guidance: `%APPDATA%\nvm\node.exe` is not a normal executable path; probe `%NVM_SYMLINK%`, Program Files, and version directories instead.
- Added fnm and Volta Windows candidate details plus `RPAR_NODE` and `node.exe` fallback behavior for packaged GUI launches.
- Preserved the required `CREATE_NO_WINDOW` patch and clarified it must be applied to the mutable sidecar `Command` before `.spawn()`.
- Clarified that `tauri.conf.json`, `capabilities/default.json`, `Cargo.toml`, `vite.config.ts`, frontend TS, and sidecar JS do not need Windows edits.
- Corrected public asset handling: copy only real `public/*.svg` assets and regenerate `public/cmaps`, `public/standard_fonts`, and `public/ort` via root postinstall.
- Added the exact seeded Kokoro cache file list and verification command for `model_quantized.onnx`.
- Changed the copy guidance to avoid a root `robocopy /MIR` that would delete destination-only plan files.
- Added the robocopy success-code note so exit codes `0` through `7` are not misread as hard failures.
- Added explicit verification that Windows sidecar install contains `win32\x64` ONNX Runtime binaries and `@img/sharp-win32-x64`.
- Updated host prerequisite claims from actual checks: Node/npm/WebView2/MSVC/Windows SDK are present, Rust/rustup/cargo are absent, and Git's `link.exe` is not an MSVC verification.
- Added Tauri Windows bundling detail specific to this config: `"targets": "all"` builds NSIS and MSI, and MSI may require the VBSCRIPT optional feature.
- Added Windows migration risks for antivirus slowdowns, long paths, CRLF churn, MSI prerequisites, and model-cache path drift.
