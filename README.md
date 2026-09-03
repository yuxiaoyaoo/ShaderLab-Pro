# ShaderLab Pro

> A local, professional **GLSL shader creation and video export workstation** for graphics programmers, technical artists, and shader learners (a code-first, localized Shadertoy runtime).

**Languages:** English · [简体中文](README.zh-CN.md)

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#packaging-installers)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-purple)](https://v2.tauri.app/)
[![SolidJS](https://img.shields.io/badge/SolidJS-1.9-blue)](https://www.solidjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)

Built on **Tauri 2.x** (Rust backend + WebView frontend), with the frontend powered by **SolidJS + Vite + TypeScript + Monaco Editor**.

---

## Features

- **Code-first Shadertoy runtime**: GLSL ES 3.00 / WebGL2 with Shadertoy-style inputs such as `iTime`, `iResolution`, and `iChannel0-3` texture channels;
- **Monaco Editor**: the same editing experience as VS Code, with built-in GLSL syntax highlighting, IntelliSense, and compile diagnostics;
- **Visual Pass Graph (Graph Workspace)**: compose render passes with a node graph; GLSL is generated automatically and stays in sync with the code;
- **Project Gallery (Projects Library)**: thumbnails are captured automatically on save; reopen, delete, or reveal projects in the file manager;
- **Video / GIF export**: built-in MP4 / GIF / WAV export pipeline with resolution stepping and render process control;
- **Built-in template library**: GLSL templates organized by geometry, materials, particles, post-processing, and scenes (partly inspired by [Iñigo Quílez](https://iquilezles.org/)'s MIT-licensed code);
- **AI agent (optional)**: plug in an LLM to modify, compile, and render-verify shaders through an in-app conversation;
- **Auto-update**: signed incremental updates powered by `tauri-plugin-updater` (see below).

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop framework | **Tauri 2.x** (`@tauri-apps/cli` ^2.11) | Rust backend, small and low-memory |
| Frontend framework | **SolidJS** ^1.9.5 | Fine-grained reactivity, no Virtual DOM |
| Build tool | **Vite** ^6.3.5 | via the `vite-plugin-solid` plugin |
| Language | **TypeScript** ~5.8.3 | strict mode |
| Editor | **Monaco Editor** ^0.52.2 | VS Code-class code editing |
| Backend language | **Rust** (`rust-version` ≥ 1.77.2) | crate `app`, lib `app_lib` |
| Key Rust deps | `tauri` ^2.11, `tauri-plugin-updater`, `tauri-plugin-log`, `rfd`, `rig-core` / `rig-agent` ^0.42 | dialogs, AI agent, updater |

---

## Environment Requirements

### General

- **Node.js** ≥ 18.18 (20 LTS recommended), with npm (the repository ships `package-lock.json`; use `npm install`)
- **Rust toolchain** ≥ 1.77.2 (stable) — install via [rustup](https://rustup.rs/)

### Platform-specific system dependencies

| Platform | Extra dependencies required |
|---|---|
| **Windows** | • **WebView2 Runtime** (built into Windows 10 1809+ / Windows 11; run `npx tauri windows webview-installer` if missing)<br>• **Microsoft C++ Build Tools** / Visual Studio "Desktop development with C++" workload (provides the MSVC linker)<br>• Rust default target `x86_64-pc-windows-msvc` |
| **macOS** | • **Xcode Command Line Tools**: `xcode-select --install`<br>• For universal binaries: `rustup target add aarch64-apple-darwin x86_64-apple-darwin` |
| **Linux (Ubuntu/Debian)** | `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev patchelf libssl-dev`, etc. (see the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)) |

> Refer to the official [Tauri 2 Prerequisites](https://v2.tauri.app/start/prerequisites/) for the complete list.

---

## Install Dependencies

```bash
# 1. Frontend dependencies (npm)
npm install

# 2. Rust dependencies are fetched automatically by cargo on first build
#    (nothing to do). To verify ahead of time:
cd src-tauri && cargo check && cd ..
```

---

## Run in Development Mode

### Option A: Full native window with hot reload (recommended)

```bash
npm run tauri dev
```

This command will:

1. Run `beforeDevCommand` (`npm run dev`) to start the Vite dev server (fixed port **1420**, `strictPort`);
2. Compile and start the Rust backend, opening a native WebView window;
3. Frontend changes hot-reload instantly; Rust changes trigger a rebuild automatically.

### Option B: Frontend only (no native window, pure UI debugging)

```bash
npm run dev        # Vite only; open http://localhost:1420 in the browser
```

### Type checking / frontend build

```bash
npm run typecheck  # tsc --noEmit type check
npm run build      # vite build → dist/
npm run preview    # preview the production build locally
```

> In debug mode the window data directory points to the local `webview-data/` folder (see `src-tauri/src/lib.rs`), which helps with local storage debugging.

---

## Packaging Installers

Build flow: run `npm run build` first (Vite → `dist/`), then Tauri bundles the frontend into the native binary and produces the platform installers.

### Per-platform scripts (built into the repo)

| Command | Output | Location |
|---|---|---|
| `npm run build:win` | Windows **NSIS installer (.exe)** + **MSI (.msi)** | `src-tauri/target/release/bundle/nsis/`, `.../msi/` |
| `npm run build:mac` | macOS **.app** + **.dmg** | `src-tauri/target/release/bundle/macos/`, `.../dmg/` |
| `npm run build:linux` | Linux **AppImage** + **.deb** + **.rpm** | `src-tauri/target/release/bundle/` |
| `npm run build:desktop` | all enabled bundle targets (see below) | same as above |

> Equivalent low-level commands: `npx tauri build --bundles nsis,msi` (Windows), `--bundles app,dmg` (macOS), etc.

### Bundle configuration (from `src-tauri/tauri.conf.json`)

- `productName`: `ShaderLab Pro`, `version`: `0.1.0`, `identifier`: `com.shaderlabpro.desktop`
- `bundle.targets`: `["nsis", "msi", "app", "dmg", "appimage", "deb", "rpm"]`
- Windows NSIS install mode: `currentUser` (**per-user install, no admin rights required**)
- Icons: `src-tauri/icons/` (png / icns / ico / Store sizes included)

### Example output layout (Windows)

```
src-tauri/target/release/bundle/
├── nsis/
│   └── ShaderLab Pro_0.1.0_x64-setup.exe   # NSIS installer
└── msi/
    └── ShaderLab Pro_0.1.0_x64_en-US.msi     # MSI package
```

---

## Auto Update (Updater)

`tauri.conf.json` enables `bundle.createUpdaterArtifacts: true` and configures `plugins.updater`:

- Update metadata endpoint: `https://github.com/yuxiaoyaoo/ShaderLab-Pro/releases/latest/download/latest.json`
- The updater uses **asymmetric signatures**; the public key is embedded in the `pubkey` field.

Before publishing an updatable release:

```bash
# 1. Generate the signing key pair (first time only)
npx tauri signer generate -w ~/.tauri/shaderlab.key

# 2. Put the public key into plugins.updater.pubkey in tauri.conf.json
# 3. Provide the private key to the build via the TAURI_SIGNING_PRIVATE_KEY env var
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/shaderlab.key)

# 4. The build also produces .sig signature files and latest.json
npm run build:win
```

> If you don't need auto-update yet, set `createUpdaterArtifacts` to `false`, or keep it enabled without deploying an update server.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| White screen / WebView error after `tauri dev` | Missing WebView2 Runtime on Windows | Run `npx tauri windows webview-installer` or install WebView2 manually |
| Rust link error `link.exe not found` | MSVC build tools not installed | Install Visual Studio "Desktop development with C++" workload |
| `npm run dev` reports port 1420 in use | Another process holds the port | Stop the process, or change `server.port` in `vite.config.ts` |
| Updater build fails `private key not found` | Signing env var not set | `export TAURI_SIGNING_PRIVATE_KEY=...` and retry |
| macOS notarization / signing error | Apple developer certificate not configured | Configure `bundle.macOS` signing in `tauri.conf.json`, or use ad-hoc signing for local testing |

---

## Directory Structure

```
ShaderLab Pro/
├── index.html              # Frontend entry HTML
├── package.json            # Frontend deps and scripts (dev/build/tauri/build:win...)
├── vite.config.ts          # Vite + solid plugin config (dev port 1420)
├── tsconfig.json           # TypeScript config
├── dist/                   # vite build output (bundled into the binary by Tauri)
├── src/                    # Frontend source (SolidJS + Monaco + render/export/project modules)
│   ├── index.tsx
│   ├── App.tsx
│   ├── components/  editor/  export/  project/  shadertoy/  updater/  agent/
│   └── styles.css
├── src-tauri/              # Rust backend
│   ├── tauri.conf.json     # Tauri / bundling / updater config
│   ├── Cargo.toml          # Rust dependencies
│   ├── build.rs
│   ├── src/
│   │   ├── lib.rs          # App entry, window and IPC commands
│   │   ├── agent/  config/  ipc/   # backend modules
│   │   └── main.rs
│   ├── capabilities/       # Tauri permission capabilities
│   ├── icons/              # App icons (multi-size)
│   └── target/             # cargo build artifacts (gitignored)
└── webview-data/           # dev-time WebView data directory (gitignored)
```

---

## References

- [Tauri 2 official docs](https://v2.tauri.app/)
- [SolidJS docs](https://www.solidjs.com/docs)
- [Vite docs](https://vite.dev/)

---

## Reporting Issues / Contributing

- Report bugs or suggest features: [Open an Issue](https://github.com/yuxiaoyaoo/ShaderLab-Pro/issues/new/choose)
- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)

---

## License

This project is open source under the **GNU AGPL v3.0** (see [LICENSE](LICENSE)).

- You are free to use, modify, and redistribute (source or binaries), as long as **any modification or derivative work is open sourced under AGPL-3.0 or a compatible license**;
- GLSL templates inside the app that are inspired by [Iñigo Quílez](https://iquilezles.org/)'s work remain under their original MIT license — see the copyright headers in the template files;
- **Commercial licensing**: the author retains full copyright and commercial rights. The community may use the AGPL open-source edition for free; if your product or service needs to integrate or redistribute this project (or a modified version) in a closed-source / non-AGPL way, please contact the author for a commercial license (dual licensing).