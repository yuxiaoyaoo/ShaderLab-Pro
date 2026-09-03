# Security Policy

**Languages:** English · [简体中文](SECURITY.zh-CN.md)

## Reporting a Vulnerability

**Do not** disclose security vulnerabilities in public Issues / Discussions / PRs. Please use GitHub's **Private Vulnerability Reporting**:

1. Open [https://github.com/yuxiaoyaoo/ShaderLab-Pro/security/advisories](https://github.com/yuxiaoyaoo/ShaderLab-Pro/security/advisories);
2. Click **New draft security advisory** and fill in the affected versions, vulnerability type, and reproduction steps;
3. We will respond as soon as possible and coordinate the public disclosure date after a fix is ready (typically 14 days after the fixed release).

If the GitHub flow is unavailable, you may contact the maintainers via the email shown on the repository homepage.

## Security Scope & Commitments

- **Local-first model**: This is a local desktop app. Project files, the project library, and thumbnails stay in the local user data directory by default and are not exfiltrated;
- **Network access**: The app only connects to the network for: update checks (installable only after signature verification), the AI agent (only when you explicitly configure and enable it), and template sources (if any remote source exists);
- **Signed updates**: installers are updated with asymmetric signatures (`tauri-plugin-updater`); the private key is held only by maintainers. Never commit signing keys such as `.key` / `.pem` (they are already excluded in `.gitignore`).

## Supported Versions

| Version | Support |
|---|---|
| 0.1.x (incl. 0.2 dev) | Security fixes supported (currently in development) |
| Earlier versions | Not supported |

## Response Expectations

- First reply: within 3 business days of receiving the report;
- Fix target: severe vulnerabilities get priority hotfix releases; routine ones ship with the next version.