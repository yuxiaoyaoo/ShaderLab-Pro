# Changelog

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html) conventions.

**Languages:** English · [简体中文](CHANGELOG.zh-CN.md)

## [0.1.0] - 2026-09-03

First public release.

### Added

- **Localized Shadertoy runtime**: GLSL ES 3.00 / WebGL2 with `iTime`, `iResolution`, `iMouse`, and `iChannel0-3` texture/audio channels;
- **Monaco Editor**: GLSL syntax highlighting, IntelliSense, snippets, and a compile diagnostics panel;
- **Pass Graph (Graph Workspace)**: node-based render pass orchestration with automatic GLSL generation kept in two-way sync with the code;
- **Project Gallery (Projects Library)**: 640×360 thumbnails captured automatically on save; open, delete, or reveal projects in the file manager; shown automatically on launch with no active session;
- **Export pipeline**: MP4 / GIF / WAV export with progressive resolution and render process control;
- **Built-in template library**: GLSL templates in 5 categories — geometry / materials / particles / post-processing / scenes;
- **AI agent (optional)**: built-in LLM agent supporting the modify → compile → render-verify loop;
- **Auto-update**: signed incremental updates via `tauri-plugin-updater` (with Windows / macOS / Linux build matrix);
- **Desktop packaging**: NSIS / MSI / App / DMG / AppImage / Deb / RPM multi-platform installers.

### Fixed

- Low-contrast iChannel dropdown options in dark theme;
- 3D viewport not filling the space after collapsing panels.

### Engineering

- Introduced M0-M7 milestone assertions, product-message sanitization checks, and a desktop end-to-end smoke test as quality gates.