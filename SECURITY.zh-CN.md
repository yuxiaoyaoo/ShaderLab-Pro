# 安全策略（Security）

[English](SECURITY.md) · **简体中文**

## 报告漏洞

**不要**在公开的 Issue / Discussion / PR 中披露安全漏洞。请通过 GitHub 的 **Private Vulnerability Reporting** 提交：

1. 打开 [https://github.com/yuxiaoyaoo/ShaderLab-Pro/security/advisories](https://github.com/yuxiaoyaoo/ShaderLab-Pro/security/advisories)；
2. 点击 **New draft security advisory**，填写受影响版本、漏洞类型与复现步骤；
3. 我们会尽快响应并在修复后共同确认公开披露时间（常规为修复发布后 14 天）。

如果 GitHub 流程不可用，可联系维护者电子邮箱（将在本仓库主页显示）。

## 安全范围与承诺

- **本地模型**：本项目为本地桌面应用，项目文件、作品库、缩略图默认存放在本机用户数据目录，不主动外传；
- **网络访问**：应用仅在以下场景联网——自动更新检查（产物签名验证后方可安装）、AI 代理（由你在设置中显式配置并启用）、模板库（如有远程源）；
- **签名更新**：安装包更新使用非对称签名（`tauri-plugin-updater`），私钥仅由维护者持有，请勿以任何形式提交 `.key` / `.pem` 等签名私钥文件（已在 `.gitignore` 中排除）。

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 0.1.x（含 0.2 开发版） | 安全修复支持（当前开发中） |
| 更早版本 | 不接受 |

## 响应预期

- 首次回复：收到报告后 3 个工作日内；
- 修复目标：影响严重的漏洞优先安排热修复版本，常规漏洞随下一版本发布。