# ShaderLab Pro 自动更新发布

## 信任链

`tauri.conf.json` 中的 `plugins.updater.pubkey` 是可公开提交的 minisign 公钥。与它配对的私钥只能存放在 GitHub Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

不要提交私钥、密码或包含它们的 `.env`。如果已经发布过包含当前公钥的客户端，必须保留对应私钥；丢失私钥后，旧客户端无法通过原自动更新链路信任新密钥。

Windows Authenticode 和 macOS Developer ID/公证用于操作系统信任，不替代 updater 的 minisign 签名。

## 发布步骤

1. 同步修改 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本。
2. 创建与版本完全一致的 tag，例如版本 `0.2.0` 对应 `v0.2.0`。
3. 推送 tag。Release workflow 会先运行版本门禁，再构建各平台安装包、更新归档、签名文件和 `latest.json`。
4. Workflow 创建 Draft Release。人工确认以下内容后点击 **Publish release**：
   - Windows x86_64、macOS x86_64、macOS aarch64、Linux x86_64 产物齐全；
   - `latest.json` 存在，对应平台 URL 可匿名下载且 signature 非空；
   - Windows 清单优先指向 NSIS updater 产物；
   - 使用旧版本客户端完成一次真实下载、验签、安装和重启。

`/releases/latest/download/latest.json` 不会返回 Draft 或 prerelease。未发布草稿时，客户端只会看到上一个正式 Release，或者收到 404。

公开 GitHub Release 才能让桌面客户端匿名读取当前 endpoint。若仓库改为私有，应将 `latest.json` 和更新产物迁移到可匿名访问的 HTTPS 存储；不要把 GitHub token 嵌入客户端。

Linux 自动替换主要面向 AppImage。DEB/RPM 作为安装包发布，不保证具备 AppImage 相同的原地更新行为。

## 本地 UI 模拟

开发构建会在 `window.__slp.updater` 安装三个无网络、无真实安装和无重启副作用的入口：

```js
await window.__slp.updater.prompt()
await window.__slp.updater.failed()
await window.__slp.updater.ready()
```

这些入口只验证 prompt/failed/ready UI、焦点和语言切换，不能替代真实签名和平台安装 smoke。生产构建会移除该开发模块。
