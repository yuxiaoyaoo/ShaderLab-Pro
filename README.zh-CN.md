# ShaderLab Pro

**Languages:** [English](README.md) · 简体中文

> 一款面向图形程序员、技术美术与 Shader 学习者的 **本地专业 GLSL Shader 创作与视频导出工作站**（Shadertoy 本地化的代码优先运行时）。

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#打包为安装程序)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-purple)](https://v2.tauri.app/)
[![SolidJS](https://img.shields.io/badge/SolidJS-1.9-blue)](https://www.solidjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)

本仓库基于 **Tauri 2.x**（Rust 后端 + WebView 前端）构建，前端使用 **SolidJS + Vite + TypeScript + Monaco Editor**。

***

## 功能特性

- **代码优先的 Shadertoy 本地化运行时**：GLSL ES 3.00 / WebGL2，支持 `iTime`、`iResolution`、`iChannel0-3` 等类 Shadertoy 输入与纹理通道；

- **Monaco 编辑器**：VS Code 同款代码编辑体验，内置 GLSL 语法高亮、智能提示、错误诊断；

- **可视化 Pass 图谱（Graph Workspace）**：以节点图方式编排渲染通道，自动生成 GLSL 并同步到代码；

- **项目画廊（Projects Library）**：作品自动保存缩略图，支持重新打开、删除、在文件管理器中定位；

- **视频/GIF 导出**：内置 MP4 / GIF / WAV 导出管线与渲染进程管理；

- **内置模板库**：几何、材质、粒子、后处理、场景分类的 GLSL 模板（部分受 [Iñigo Quílez](https://iquilezles.org/) 的 MIT 代码启发）；

- **AI 代理（可选）**：接入 LLM，可在应用内对话完成 Shader 修改、编译与渲染验证；

- **自动更新**：基于 `tauri-plugin-updater` 的签名增量更新（见下文）。

***

## 技术栈

| 层级         | 选型                                                                                               | 说明                            |
| ---------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| 桌面框架       | **Tauri 2.x** (`@tauri-apps/cli` ^2.11)                                                          | Rust 后端，体积小、内存低               |
| 前端框架       | **SolidJS** ^1.9.5                                                                               | 细粒度响应式，无 Virtual DOM 开销       |
| 构建工具       | **Vite** ^6.3.5                                                                                  | `vite-plugin-solid` 插件        |
| 语言         | **TypeScript** \~5.8.3                                                                           | 严格模式                          |
| 编辑器        | **Monaco Editor** ^0.52.2                                                                        | VS Code 同款代码编辑                |
| 后端语言       | **Rust** (`rust-version` ≥ 1.77.2)                                                               | crate 名 `app`，lib 名 `app_lib` |
| 关键 Rust 依赖 | `tauri` ^2.11, `tauri-plugin-updater`, `tauri-plugin-log`, `rfd`, `rig-core` / `rig-agent` ^0.42 | 文件对话框、AI 代理、更新器               |

***

## 环境要求

### 通用要求

- **Node.js** ≥ 18.18（推荐 20 LTS），含 npm（仓库使用 `package-lock.json`，用 `npm install`）

- **Rust 工具链** ≥ 1.77.2（stable 即可），通过 [rustup](https://rustup.rs/) 安装

### 按平台安装系统依赖

| 平台                        | 必须的额外依赖                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**               | • **WebView2 Runtime**（Win10 1809+/Win11 已内置；缺失时运行 `npx tauri windows webview-installer`）• **Microsoft C++ Build Tools** / Visual Studio「使用 C++ 的桌面开发」工作负载（提供 MSVC 链接器）• Rust 默认 `x86_64-pc-windows-msvc` target |
| **macOS**                 | • **Xcode Command Line Tools**：`xcode-select --install`• 如需通用二进制：`rustup target add aarch64-apple-darwin x86_64-apple-darwin`                                                                                    |
| **Linux (Ubuntu/Debian)** | `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev patchelf libssl-dev` 等（详见 [Tauri 官方 Linux 依赖](https://v2.tauri.app/start/prerequisites/)）                                                                   |

> 完整系统依赖清单以 [Tauri 2 官方「Prerequisites」](https://v2.tauri.app/start/prerequisites/) 为准。

***

## 安装依赖

```bash
# 1. 前端依赖（npm）
npm install

# 2. Rust 依赖会在首次构建时由 cargo 自动拉取（无需单独命令）
#    如需提前检查：
cd src-tauri && cargo check && cd ..
```

***

## 开发模式运行

### 方式 A：完整原生窗口热重载（推荐）

```bash
npm run tauri dev
```

该命令会：

1. 先执行 `beforeDevCommand`（`npm run dev`）启动 Vite 开发服务器（固定端口 **1420**，`strictPort`）；
2. 编译并启动 Rust 后端，弹出原生 WebView 窗口；
3. 前端代码改动即热更新，Rust 改动自动重新编译。

### 方式 B：仅前端（无原生窗口，适合纯 UI 调试）

```bash
npm run dev        # 仅启动 Vite，浏览器打开 http://localhost:1420
```

### 类型检查 / 前端构建

```bash
npm run typecheck  # tsc --noEmit 类型检查
npm run build      # vite build → 输出到 dist/
npm run preview    # 本地预览构建产物
```

> 调试模式下窗口数据目录指向本地 `webview-data/`（见 `src-tauri/src/lib.rs`），便于排查本地存储问题。

***

## 打包为安装程序

构建流程：先 `npm run build`（Vite → `dist/`），再由 Tauri 将前端打包进原生二进制并生成对应平台安装包。

### 按平台打包脚本（仓库已内置）

| 命令                      | 产物                                           | 输出位置                                                |
| ----------------------- | -------------------------------------------- | --------------------------------------------------- |
| `npm run build:win`     | Windows **NSIS 安装包 (.exe)** + **MSI (.msi)** | `src-tauri/target/release/bundle/nsis/`、`.../msi/`  |
| `npm run build:mac`     | macOS **.app** + **.dmg**                    | `src-tauri/target/release/bundle/macos/`、`.../dmg/` |
| `npm run build:linux`   | Linux **AppImage** + **.deb** + **.rpm**     | `src-tauri/target/release/bundle/`                  |
| `npm run build:desktop` | 全部启用的 bundle targets（见下）                     | 同上                                                  |

> 等价底层命令：`npx tauri build --bundles nsis,msi`（Windows）、`--bundles app,dmg`（macOS）等。

### Bundle 配置（来自 `src-tauri/tauri.conf.json`）

- `productName`: `ShaderLab Pro`，`version`: `0.1.0`，`identifier`: `com.shaderlabpro.desktop`

- `bundle.targets`: `["nsis", "msi", "app", "dmg", "appimage", "deb", "rpm"]`

- Windows NSIS 安装模式：`currentUser`（**当前用户安装，无需管理员权限**）

- 图标：位于 `src-tauri/icons/`（已包含 png / icns / ico / Store 尺寸）

### 产物结构示例（Windows）

```
src-tauri/target/release/bundle/
├── nsis/
│   └── ShaderLab Pro_0.1.0_x64-setup.exe   # NSIS 安装器
└── msi/
    └── ShaderLab Pro_0.1.0_x64_en-US.msi     # MSI 安装包
```

***

## 自动更新（Updater）

`tauri.conf.json` 已开启 `bundle.createUpdaterArtifacts: true` 并配置了 `plugins.updater`：

- 更新元数据端点：`https://github.com/yuxiaoyaoo/ShaderLab-Pro/releases/latest/download/latest.json`

- 更新器使用**非对称签名**，公钥已写入 `pubkey` 字段。

发布可更新版本前需：

```bash
# 1. 生成签名密钥对（首次）
npx tauri signer generate -w ~/.tauri/shaderlab.key

# 2. 将生成的公钥填入 tauri.conf.json 的 plugins.updater.pubkey
# 3. 将私钥通过环境变量 TAURI_SIGNING_PRIVATE_KEY 提供给构建过程
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/shaderlab.key)

# 4. 构建会同时生成 .sig 签名文件与 latest.json
npm run build:win
```

> 若暂不需要自动更新，可将 `createUpdaterArtifacts` 设为 `false`，或保留但暂不部署更新服务器。

***

## 常见问题（Troubleshooting）

| 现象                                | 可能原因                       | 解决                                                          |
| --------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `tauri dev` 启动后白屏 / WebView 报错    | Windows 缺 WebView2 Runtime | 运行 `npx tauri windows webview-installer` 或手动安装 WebView2     |
| Rust 编译报链接错误 `link.exe not found` | 未安装 MSVC 构建工具              | 安装 Visual Studio「使用 C++ 的桌面开发」工作负载                          |
| `npm run dev` 提示端口 1420 被占用       | 其他进程占用                     | 关闭占用进程，或修改 `vite.config.ts` 的 `server.port`                 |
| 更新器构建失败 `private key not found`   | 未设置签名环境变量                  | `export TAURI_SIGNING_PRIVATE_KEY=...` 后重试                  |
| macOS 公证/签名报错                     | 未配置 Apple 开发者证书            | 在 `tauri.conf.json` 配置 `bundle.macOS` 签名项，或用 ad-hoc 签名仅本地测试 |

***

## 目录结构

```
ShaderLab Pro/
├── index.html              # 前端入口 HTML
├── package.json            # 前端依赖与脚本（dev/build/tauri/build:win...）
├── vite.config.ts          # Vite + solid 插件配置（dev 端口 1420）
├── tsconfig.json           # TypeScript 配置
├── dist/                   # vite build 产物（被 Tauri 打包进二进制）
├── src/                    # 前端源码（SolidJS + Monaco + 渲染/导出/项目模块）
│   ├── index.tsx
│   ├── App.tsx
│   ├── components/  editor/  export/  project/  shadertoy/  updater/  agent/
│   └── styles.css
├── src-tauri/              # Rust 后端
│   ├── tauri.conf.json     # Tauri / 打包 / 更新器 配置
│   ├── Cargo.toml          # Rust 依赖
│   ├── build.rs
│   ├── src/
│   │   ├── lib.rs          # 应用入口、窗口与 IPC 命令
│   │   ├── agent/  config/  ipc/   # 后端模块
│   │   └── main.rs
│   ├── capabilities/       # Tauri 权限能力配置
│   ├── icons/              # 应用图标（多尺寸）
│   └── target/             # cargo 构建产物（gitignored）
└── webview-data/           # 调试期 WebView 数据目录（gitignored）
```

***

## 参考

- [Tauri 2 官方文档](https://v2.tauri.app/)

- [SolidJS 文档](https://www.solidjs.com/docs)

- [Vite 文档](https://vite.dev/)

***

## 报告问题 / 参与贡献

- 提出 Bug 或功能建议：[新建 Issue](https://github.com/yuxiaoyaoo/ShaderLab-Pro/issues/new/choose)

- 贡献指南见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)

- 安全漏洞报告见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)

- 版本记录见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

***

## 许可证（License）

本项目采用 **GNU AGPL v3.0** 开源（见 [LICENSE](LICENSE)）。

- 你可以自由使用、修改、再分发（含源码与二进制），但**对项目的修改与衍生作品必须以 AGPL-3.0 或其兼容协议开源**；

- 应用内置 GLSL 模板中受 [Iñigo Quílez](https://iquilezles.org/) 作品启发的部分，仍遵循其原始 MIT 许可，详见模板文件头部版权声明；

- **商业化说明**：项目作者保留全部版权与商业权利。社区使用者可免费使用 AGPL 开源版；若你的产品或服务需要将本项目（或修改版）以闭源 / 非 AGPL 方式集成或再分发，请联系作者获取商业授权（Dual License）。

