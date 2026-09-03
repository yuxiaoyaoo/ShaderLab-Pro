# Contributing

Thank you for your interest in ShaderLab Pro! We welcome all forms of contribution: reporting bugs, suggesting features, improving docs, and submitting code.

This repository is licensed under **[AGPL-3.0](LICENSE)**. By submitting code you agree to license it under this license and confirm that you have the necessary rights to the content you contribute.

**Languages:** English · [简体中文](CONTRIBUTING.zh-CN.md)

---

## Development Environment

| Dependency | Version requirement |
|---|---|
| Node.js | ≥ 18.18 (20 LTS recommended), with npm |
| Rust toolchain | ≥ 1.77.2 (stable) |
| Platform deps | See [README "Environment Requirements"](README.md#environment-requirements); Windows needs WebView2 Runtime and MSVC build tools |

## Running Locally

```bash
# Frontend dependencies
npm install

# Full native window with hot reload (Vite dev server on fixed port 1420)
npm run tauri dev

# Frontend only (open http://localhost:1420 in a browser)
npm run dev
```

## Verification (all must pass before submitting)

```bash
npm run typecheck          # TypeScript type checking
cargo check                # Rust compile check (in src-tauri/)
npm run verify:all         # M0-M7 milestone assertions + Graph Workspace + product-message sanitization checks
npm run verify:production-bundle   # production build artifact checks
npm run smoke:desktop      # end-to-end desktop smoke (Windows; boots tauri dev automatically)
```

> `smoke:desktop` launches a real app window and drives it via CDP, so it takes a while; the other commands are lightweight and finish in seconds. For frontend/backend code changes, at minimum `typecheck` + `verify:all` must pass.

## Code Style & Conventions

- **Frontend**: TypeScript strict mode (all `tsc --noEmit` checks pass), idiomatic SolidJS fine-grained reactivity, components under `src/components/`;
- **Backend**: Rust adheres to normal `cargo fmt` and `cargo clippy` constraints; IPC commands are registered centrally in `src-tauri/src/lib.rs`;
- **i18n**: All user-visible strings must be registered bilingually in `src/i18n.ts` — no hard-coded strings in components;
- **Error handling**: User-reachable boundaries must not throw raw strings or `Error`; use the `ProductError` / `ProductMessage` system instead (otherwise `verify:product-messages` fails);
- **Commit messages**: concise, focused on the "why"; either Chinese or English, following the repository's commit history style.

## Pull Request Workflow

1. Fork this repository and create a feature branch: `git checkout -b feat/my-change`;
2. Make your changes and run the verification commands above;
3. Commit and push; open a PR following [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md);
4. Maintainers will review promptly; you may be asked to add tests or adjust the implementation.

## New Features / Large Changes

- Please open a discussion in Issues first (paste your proposal or design doc) to avoid direction rework;
- UI changes should follow the existing design tokens (see the CSS variables at the top of `src/styles.css`) to keep the visuals consistent.

## Code of Conduct

By participating in this project you agree to abide by the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).