# 更新日志（Changelog）

[English](CHANGELOG.md) · **简体中文**

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/) 约定。

## [0.1.0] - 2026-09-03

首个公开版本。

### 新增

- **类 Shadertoy 本地化运行时**：GLSL ES 3.00 / WebGL2，支持 `iTime`、`iResolution`、`iMouse` 与 `iChannel0-3` 纹理/音频通道；
- **Monaco 编辑器**：GLSL 语法高亮、智能提示、Snippets、编译诊断面板；
- **Pass 图谱（Graph Workspace）**：节点化编排渲染通道，自动生成 GLSL 并保持与代码双向同步；
- **项目画廊（Projects Library）**：作品库自动保存 640×360 缩略图，支持打开、删除、在文件夹中定位，无会话启动自动展示；
- **导出管线**：MP4 / GIF / WAV 导出，支持渐进式分辨率与渲染进程控制；
- **内置模板库**：几何 / 材质 / 粒子 / 后处理 / 场景 5 大类 GLSL 模板；
- **AI 代理（可选）**：内置 LLM 代理，支持 Shader 修改 → 编译 → 渲染验证闭环；
- **自动更新**：`tauri-plugin-updater` 签名增量更新（含 Windows / macOS / Linux 打包矩阵）；
- **桌面打包**：NSIS / MSI / App / DMG / AppImage / Deb / RPM 多平台安装包。

### 修复

- 深色主题下 iChannel 下拉选项对比度问题；
- 面板折叠后 3D 视口未自动撑满的问题。

### 工程

- 引入 M0-M7 里程碑断言、产品消息脱敏校验、desktop 端到端 smoke 等质量门禁。