# 贡献指南（Contributing）

[English](CONTRIBUTING.md) · **简体中文**

感谢你对 ShaderLab Pro 的关注！欢迎以任何形式参与：报告 Bug、提出功能建议、完善文档、提交代码。

本仓库遵循 **[AGPL-3.0](LICENSE)** 协议。提交代码即视为同意以该协议授权，且你保证拥有所贡献内容的必要权利。

---

## 开发环境

| 依赖 | 版本要求 |
|---|---|
| Node.js | ≥ 18.18（推荐 20 LTS），含 npm |
| Rust 工具链 | ≥ 1.77.2（stable） |
| 平台依赖 | 见 [README「环境要求」](README.md#环境要求)，Windows 需 WebView2 Runtime 与 MSVC 构建工具 |

## 本地运行

```bash
# 前端依赖
npm install

# 完整原生窗口热重载（Vite dev server 固定端口 1420）
npm run tauri dev

# 仅前端调试（浏览器打开 http://localhost:1420）
npm run dev
```

## 验证（提交前必须全部通过）

```bash
npm run typecheck          # TypeScript 类型检查
cargo check                # Rust 编译检查（在 src-tauri/ 下）
npm run verify:all         # M0-M7 里程碑断言 + Graph Workspace + 产品消息脱敏验证
npm run verify:production-bundle   # 生产构建产物验证
npm run smoke:desktop      # 桌面端端到端 smoke（Windows，自动拉起 tauri dev）
```

> `smoke:desktop` 会启动真实应用窗口并通过 CDP 驱动交互，耗时较长；其余验证命令均为轻量级、秒级完成。仅改动前后端代码时至少保证 `typecheck` + `verify:all` 通过。

## 代码风格与约定

- **前端**：TypeScript 严格模式（`tsc --noEmit` 全部通过）、SolidJS 细粒度响应式书写习惯、组件位于 `src/components/`；
- **后端**：Rust 遵循 `cargo fmt` 与 `cargo clippy` 常规约束，IPC 命令集中注册于 `src-tauri/src/lib.rs`；
- **i18n**：所有用户可见文案必须在 `src/i18n.ts` 登记中英双语，禁止硬编码到组件；
- **错误处理**：用户可达边界不得抛出裸字符串/`Error`，必须使用 `ProductError` 或 `ProductMessage` 体系（否则 `verify:product-messages` 会失败）；
- **提交信息**：简洁、面向"为什么"，中文或英文均可，参考仓库历史风格。

## 提交 PR 流程

1. Fork 本仓库并创建特性分支：`git checkout -b feat/my-change`；
2. 完成改动并运行上述验证命令；
3. 提交并推送，对照 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) 完善描述后发起 PR；
4. 维护者会尽快 review，可能需要你补充测试或调整实现。

## 新增功能 / 大改动

- 建议先在 Issues 中发起讨论（贴上方案或设计文档），避免方向性返工；
- 涉及用户界面的改动，尽量遵循现有设计 token（见 `src/styles.css` 顶部 CSS 变量）以保持视觉一致性。

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.zh-CN.md](CODE_OF_CONDUCT.zh-CN.md)。