# 设计：Shadertoy 兼容输入补全（键盘 / 代码模式纹理 / 音频输入 / JSON 导入）

日期：2026-08-31
状态：已与用户确认，进入实施

## 背景与目标

应用当前的 Shadertoy 兼容矩阵：

| 能力 | 现状 |
|---|---|
| Buffer 通道（BufA–D） | ✅ 完整（ping-pong / 时序 / Pass Graph UI / 导入导出） |
| 纹理 iChannel | 🟡 仅图模式可用（自动 slot 分配）；代码模式无分配 UI；无占位资产机制 |
| 键盘 iKeyboard | ❌ 无（JSON 导入时被跳过） |
| 音频输入 iChannel | ❌ 无（只有 mainSound 输出方向） |

目标：补齐键盘输入、代码模式纹理分配、音乐文件音频输入、Shadertoy JSON 导入兼容，
让依赖这些输入的 Shadertoy shader 可以原样运行。

## 1. 数据模型扩展（src/shadertoy/runtime.ts）

`RuntimeChannelCfg` 新增两个变体：

```ts
| { index: number; type: 'keyboard'; filter: 'nearest'; wrap: 'clamp' }
| { index: number; type: 'audio'; src: string; filter: 'linear' | 'nearest'; wrap: 'repeat' | 'clamp' }
```

项目层（src/project/types.ts）`PassChannelCfg.type` 激活 `'keyboard'`；新增 `'audio'`；
遗留 `'volume'` 作为 `'audio'` 的迁移别名（migrations.ts 中转换）。

## 2. 键盘 iKeyboard

- 语义完全对齐 Shadertoy：键盘通道是一张 256×2 R8 数据纹理；
  键码 = DOM `KeyboardEvent.keyCode`；
  row 0 = 本帧按下脉冲（keydown 事件触发，帧末清除；含长按 repeat）；
  row 1 = 当前按住状态。
- shader 读取方式（与 Shadertoy howto 一致）：
  `texelFetch(iChannel0, ivec2(65,0), 0).x > 0.0`（keyPressed）；
  `texelFetch(iChannel0, ivec2(65,1), 0).x > 0.0`（keyIsDown）。
- 运行时：内置 256×2 Uint8Array 状态机，每帧 `texSubImage2D` 上传 512 字节。
- 焦点策略（用户已确认）：鼠标悬停预览画布时采集，离开即停；
  不调用 preventDefault，编辑器快捷键不受影响；预览工具栏显示"键盘采集中"指示灯。
- 头部无需改动（sampler2D 声明已存在），复用 bindChannels 管线。

## 3. 代码模式通道分配 UI

- 扩展 App 侧栏 pass 菜单的 ch0–3 下拉，选项：[无] / Buffer A–D / 已导入纹理资产 / 键盘 / 音频资产。
- 选中纹理或音频后出现 popover 设置 filter（linear/nearest）与 wrap（repeat/clamp）。
- 数据流复用 `meta.passes[pass].channels` → setupBuilder → runtime（链路已存在，仅缺 UI 入口）。
- 下拉底部提供"导入纹理… / 导入音频…"快捷入口，走现有 importTextureAsset 管线。
- 解除导出侧 `code-texture-unsupported` 拦截；图模式不受影响。

## 4. 音频输入 iChannel（仅音乐文件，用户已确认）

- 资产层：资产系统支持 mp3/ogg/wav/m4a/flac（pickFile → readBinaryFile → base64），
  manifest 增加 `mediaType: 'audio'`，不做预解码。
- 播放层：`<audio>` 元素 + `MediaElementSource → AnalyserNode`，循环播放；
  预览工具栏显示播放/暂停/进度（仅当存在音频通道时）。
- 数据层：每帧读取 FFT（getByteFrequencyData）与波形（getByteTimeDomainData），
  写入 512×2 数据纹理挂到该 iChannel：row 0 = FFT，row 1 = 波形（与 Shadertoy 布局一致）。
- 未播放/暂停/解码失败时输出静音内容（波形全 128、FFT 全 0），shader 不崩。
- 音频走独立时钟，不与 iTime 强同步；视频导出第一版忽略音频输入通道并提示。

## 5. JSON 导入/导出兼容（src/shadertoy/json.ts）

| 导入 ctype | 行为 |
|---|---|
| keyboard | 创建键盘通道 |
| texture（Shadertoy 预置 URL） | 占位通道 `src: 'missing:<url>'` + 导入报告列出待补资产；UI 显示"缺失"状态，手动选择本地文件替换（不做自动网络下载） |
| music | 占位同上 |
| webcam | 维持跳过并提示 |

导出：keyboard 导出为 ctype:keyboard；存在缺失资产时保持导出拦截并指明缺失项。

## 6. 错误处理

- 音频解码失败 → 诊断 `runtime.audio-decode-failed`，通道降级静音纹理。
- 资产被删除 → 通道标缺失 + 静默数据，不崩溃。
- 重编译不打断音频播放；键盘数据纹理运行时内置生成，无外部失败路径。

## 7. 测试计划

1. ✅ `verify:m7`：键盘状态机纯函数（keydown/keyup/帧清除）+ 通道解析扩展单测。
2. ✅ `scripts/_repro-compile.mjs`：新增引用 iKeyboard/音频 texelFetch 的编译变体。
3. ✅ 桌面 smoke（scripts/smoke/desktop.mjs）：CDP `Input.dispatchKeyEvent` 模拟按键，
   断言键盘数据纹理变化。**已跑通（2026-08-31，exit 0）**：项目重置（File→新建项目，
   避免导航式 reload 破坏 CDP）→ KB 通道分配 → 编译生效 → 悬停门控 → keyDown/keyUp/
   held/leaveRelease 全链路断言通过。断言语义与运行时 iKeyboard 状态机一致：
   row0=本帧按下边沿（draw() 末清零，仅 keydown 后首帧上传可见）、row1=切换锁存
   （keyup/移出释放时清零）；边沿帧靠 texSubImage2D 钩子环形缓冲（60 帧）扫描捕获。
4. ⬜ 手动验收（§7.4 清单）：素材 `docs/acceptance/keyboard-demo.json`（Shadertoy 导出格式，
   ctype:keyboard → ch0；A 按住左半屏泛蓝、D 按住右半屏泛绿、A 按下瞬间全屏白闪一帧、
   顶部黄条 = A-Z 锁存键数）。步骤：File → 导入 Shadertoy JSON 选该文件 → 鼠标悬停
   预览画布 → 按 A/D 验证锁存与边沿 → 松开/移出画布验证释放；音频侧验收用任一
   `iChannel` 分配为音乐（Music）的音乐可视化 shader 实测。

## 8. 实施顺序

1. 键盘通道（运行时 + 悬停采集）——独立最小
2. 代码模式通道分配 UI（纹理/键盘复用）
3. 音频输入（资产 + 播放 + 数据纹理）
4. JSON 导入/导出兼容
