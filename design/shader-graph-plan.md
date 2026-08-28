# ShaderLab Pro Shader Graph 实施计划

> 状态：Proposal  
> 日期：2026-08-28  
> 目标：在保留现有 GLSL 编辑能力、Shadertoy 多 Pass Runtime 和全部导出能力的前提下，引入类似 Blender Shader Editor 的可视化节点创作方式。

## 1. 结论

**可行，且现有架构适合渐进式接入。**

当前 Runtime 的输入已经是按 Pass 组织的 GLSL 源码，因此 Shader Graph 不需要重写 WebGL 渲染器。节点系统只需完成：

```text
GraphDocument
  -> 图校验与类型推导
  -> Typed IR
  -> 确定性 GLSL + 节点源码映射
  -> 现有 RuntimeSetup
  -> ShadertoyRuntime.compile()
```

但不建议第一版直接追求完整 Blender 能力。完整版本涉及表达式图、项目级 Pass 图、纹理资产、Feedback、Node Group、Custom Code、诊断映射和项目迁移，属于大型功能。推荐先交付 **Image Pass Shader Graph MVP**，再扩展 Buffer、纹理和 SDF/Raymarch 工作流。

## 2. 核心产品决策

### 2.1 Graph 是源数据，GLSL 是生成物

对于 Graph Pass：

- `GraphDocument` 是唯一可编辑源。
- GLSL 由编译器确定性生成。
- “Generated Code”可以查看、复制和导出，但默认只读。
- 用户若要修改生成 GLSL，必须执行明确的“转为代码模式 / Detach to Code”。该操作是单向的。
- 不实现任意 GLSL 到节点图的自动反编译。

原因：任意 GLSL 包含循环、宏、动态索引、函数副作用和复杂控制流，无法稳定无损还原成可编辑节点图。双向同步会导致 Graph 和代码互相覆盖，成为长期数据一致性风险。

### 2.2 Runtime 不认识节点

`src/shadertoy/runtime.ts` 继续只接收 GLSL、Uniform 和 Pass Channel 配置，不引入任何 Graph 类型依赖。Graph 编译失败时，不应破坏 Runtime 中最后一次成功编译的预览。

### 2.3 分离两种图

必须区分：

1. **Pass 内 Shader Graph**：描述 UV、数学、颜色、SDF 等表达式，最终连接到 Fragment Output。MVP 实现这一层。
2. **项目级 Pass Graph**：描述 Image、Buffer A-D、纹理资源、跨帧 Feedback 和执行关系。后续实现。

普通表达式连接与跨 Pass/跨帧连接不能共用一套隐式语义。

### 2.4 Code Pass 与 Graph Pass 可以共存

同一个项目中允许：

- Image 使用 Graph；Buffer A 使用 Code。
- Image 使用 Code；Buffer A/B 使用 Graph。
- Common、Sound 在早期版本继续使用 Code。

每个 Pass 独立保存 `authoring.kind: "code" | "graph"`。

## 3. 当前工程的接入点

### 3.1 现有链路

- `src/App.tsx`：持有 `sources`、项目 `meta`、Uniform、诊断和 `runtimeSetup`。
- `src/components/EditorPane.tsx`：Monaco 多 Pass 代码编辑器。
- `src/shadertoy/runtime.ts`：包装并编译 Common + Image/Buffer/Sound GLSL，执行 WebGL2 Pass。
- `src/project/types.ts`：项目 1.0 schema 和各 Pass 文件路径。
- `src/project/projectIO.ts`：项目保存、加载、自动保存和恢复。
- `src/shadertoy/json.ts`：Shadertoy 导入导出。
- 图片、GIF、MP4、WebM 导出只依赖 Runtime，因此不需要理解 Graph。

### 3.2 建议新增边界

```text
src/graph/
  model.ts
  schema.ts
  registry.ts
  nodes/
    core.ts
    vector.ts
    color.ts
    sdf2d.ts
  compiler/
    types.ts
    validate.ts
    ir.ts
    emitGlsl.ts
    sourceMap.ts
    index.ts

src/components/graph/
  ShaderEditorWorkspace.tsx
  GraphEditorPane.tsx
  GraphCanvas.tsx
  GraphNode.tsx
  GraphSocket.tsx
  GraphEdgeLayer.tsx
  GraphPalette.tsx
  GraphInspector.tsx
  GeneratedCodePane.tsx

src/state/
  projectStore.ts
  editorStore.ts

src/diagnostics/
  model.ts
  graphDiagnostics.ts

src/project/
  migrations.ts
  graphIO.ts

src/shadertoy/
  setupBuilder.ts
```

职责原则：

- Graph UI 不直接拼接 GLSL。
- Node Definition 不直接操作 DOM。
- Runtime 不依赖 Graph model。
- 项目 I/O 不进行类型推导或代码生成。
- 模板、AI、Shadertoy 和媒体导出统一从 `effectiveSources` 获取实际 GLSL。

## 4. Graph 数据模型

建议 Graph 文件使用独立版本，不与项目版本绑定：

```ts
interface GraphDocument {
  format: 'shaderlab-graph';
  version: 1;
  pass: 'image' | 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD';
  nodes: GraphNode[];
  edges: GraphEdge[];
  parameters: GraphParameter[];
  ui: {
    viewport: { x: number; y: number; zoom: number };
  };
}

interface GraphNode {
  id: string;                 // 稳定 UUID
  type: string;               // 例如 math.add
  typeVersion: number;
  position: { x: number; y: number };
  values: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from: { nodeId: string; socketId: string };
  to: { nodeId: string; socketId: string };
}

interface GraphParameter {
  id: string;                 // 重命名后仍可保留参数值
  name: string;
  valueType: GraphValueType;
  defaultValue: unknown;
  ui?: { widget: 'slider' | 'color' | 'number'; min?: number; max?: number; step?: number };
}
```

### 4.1 类型系统

MVP 类型：

```text
bool
int
float
vec2
vec3
vec4
color3   // 语义类型，GLSL 输出为 vec3
color4   // 语义类型，GLSL 输出为 vec4
```

后续类型：

```text
sampler2D
texture2D
sdf2D
sdf3D / material
```

规则：

- 一个输入 Socket 最多连接一条边。
- 一个输出 Socket 可以连接多个输入。
- 禁止有向环；Feedback 必须由后续项目级 Pass Graph 显式表示。
- 只允许少量、明确的自动转换，例如 `float -> vecN` 的 scalar splat。
- `vec3 -> float`、`color -> scalar` 等必须通过显式节点完成。
- 类型错误发生在 Graph 编译阶段，不进入 WebGL 编译阶段。

### 4.2 Node Registry

节点定义应注册为纯数据与纯编译行为：

```ts
interface NodeDefinition {
  type: string;
  version: number;
  title: string;
  category: string;
  inputs: SocketDefinition[];
  outputs: SocketDefinition[];
  defaultValues: Record<string, unknown>;
  inferTypes(context: TypeContext): TypeResult;
  emit(context: EmitContext): IrValue[];
}
```

持久化文件只保存稳定的 `type` 和 `typeVersion`，不保存组件名称、CSS 或第三方画布库的数据结构。

## 5. Graph 编译器

### 5.1 编译阶段

1. **Schema 校验**
   - 文件格式、版本、稳定 ID、节点类型和 Socket 是否存在。
2. **结构校验**
   - 必须且只能存在一个 Fragment Output。
   - 检测悬空边、重复输入边、非法自连和循环。
3. **类型推导**
   - 从 Output 反向收集所需节点。
   - 校验 Socket 类型，插入仅允许的显式转换 IR。
4. **拓扑排序**
   - 只编译可到达 Output 的节点。
5. **Typed IR**
   - 将 UI 节点转换成与 UI 无关的表达式和值定义。
6. **优化**
   - 常量折叠。
   - 未使用节点消除。
   - 可选的公共子表达式消除。
7. **GLSL 生成**
   - 稳定排序 Uniform、Helper 和临时变量。
   - 输出用户层声明与 `mainImage`，不输出 `#version` 和最终 `main()`。
8. **源码映射**
   - 记录生成 GLSL 行号到 `nodeId/socketId`。
9. **Runtime 编译**
   - 将生成代码放入 `effectiveSources`，复用现有 `ShadertoyRuntime.compile()`。

### 5.2 编译结果

```ts
interface GraphCompileResult {
  ok: boolean;
  source: string;
  sourceMap: GraphSourceMap;
  uniforms: GeneratedUniform[];
  diagnostics: GraphDiagnostic[];
  semanticHash: string;
}
```

同一语义 Graph 必须始终生成字节一致的 GLSL。节点位置、viewport 和选中状态不能影响 `semanticHash` 或生成代码。

### 5.3 变量与名称安全

- 生成临时变量统一使用保留前缀，例如 `_sg_n12_out0`。
- Parameter 名称需经过 GLSL 标识符合法化和碰撞消解。
- 禁止占用 `main`、`mainImage`、`outColor`、`iResolution`、`iTime`、`iChannel0..3` 等内建名称。
- Helper 函数按内容去重并使用命名空间前缀。

### 5.4 错误映射

统一诊断来源：

```ts
origin:
  | { kind: 'code'; pass: PassId; line: number; column: number }
  | { kind: 'graph'; pass: PassId; nodeId: string; socketId?: string }

stage:
  | 'graph-schema'
  | 'graph-validate'
  | 'graph-typecheck'
  | 'glsl-compile'
  | 'runtime'
```

生成 GLSL 的每个片段均记录所属节点。WebGL 编译错误先通过现有行号映射去掉 Runtime Header/Common 偏移，再通过 Graph Source Map 定位节点并高亮。

Graph 无效时：

- 保持最后一次成功预览。
- 节点和 Socket 显示错误状态。
- 顶部显示“预览来自上一次有效编译”。
- 禁止导出，避免用户导出旧版本画面而不知情。

## 6. 项目格式与兼容策略

建议项目格式升级到 `2.0`：

```json
{
  "version": "2.0",
  "passes": {
    "image": {
      "enabled": true,
      "file": "passes/image.glsl",
      "authoring": {
        "kind": "graph",
        "graphFile": "graphs/image.shadergraph.json",
        "graphFormatVersion": 1,
        "generatedHash": "..."
      }
    }
  }
}
```

目录结构：

```text
project/
  shaderlab.json
  passes/
    image.glsl                  # Code 源或 Graph 生成兼容产物
    common.glsl
    buffer_a.glsl
    sound.glsl
  graphs/
    image.shadergraph.json      # Graph 真源
  assets/                       # 后续纹理资源
  exports/
  .shaderlab/autosave/
```

兼容规则：

1. 旧 `1.0` 项目加载为全部 `kind: "code"`，源码保持不变。
2. Graph Pass 每次保存时同时写入 Graph JSON 和生成 GLSL。
3. Graph 文件缺失、损坏或版本过高时，不能静默创建空图：
   - 以生成 GLSL 只读恢复；
   - 显示明确项目诊断；
   - 允许用户显式“转为 Code”。
4. 未知更高主版本以只读模式打开或拒绝写回。
5. 新增正式迁移管线：`parse -> validate -> migrate -> normalize`。
6. Autosave V2 必须包含 meta、Code sources、Graph documents、Uniform values 和 Pass 配置。
7. 保存最终应采用临时文件 + 原子替换，避免 Graph 与生成 GLSL只写成功一半。

## 7. UI/UX 计划

### 7.1 编辑区结构

在现有编辑器区域新增 `ShaderEditorWorkspace`：

```text
Pass Tabs: Image | Common | Buffer A | ... | Sound
Authoring: [Graph] [Generated Code]

Graph 模式：
  Graph Canvas | Node Inspector

Generated Code 模式：
  只读 Monaco | Copy | Export | Detach to Code
```

对于 Code Pass：

```text
Authoring: [Code]
操作：Create Graph（创建新的默认图，确认后替换当前 Pass）
```

不提供“一键把任意当前 GLSL 转成 Graph”。

### 7.2 画布交互

MVP 必须支持：

- 平移、滚轮缩放、适配全部节点。
- 单选、多选、框选。
- 拖动节点。
- 从 Socket 拖线；不兼容类型立即反馈。
- 右键或快捷键打开可搜索节点面板。
- 删除、复制、粘贴、Duplicate。
- Undo/Redo。
- 对齐网格、基础吸附。
- 节点折叠。
- Inspector 编辑默认值和 Parameter 元数据。
- 错误节点高亮，点击诊断定位节点。

暂不实现：小地图、节点注释框、Reroute、Node Group、自动布局。这些放入后续增强。

### 7.3 实现技术

优先使用 SolidJS + HTML/SVG + Pointer Events 实现轻量画布：

- 节点使用 HTML，便于表单和文本布局。
- 连线使用单独 SVG Layer。
- viewport 使用统一 transform。
- 大图阶段再增加视口裁剪和节点虚拟化。

不建议为 React Flow 引入 React 双栈。即使未来采用第三方 Solid 兼容图组件，其内部结构也不能成为项目持久化格式。

### 7.4 编译触发策略

- 节点连接、参数值、类型等语义变化：200–400ms debounce 后编译。
- 节点移动、选择、viewport 等布局变化：标记需要保存，但不触发 GLSL/WebGL 编译。
- 拖动数值时可按动画帧更新 Uniform；只有改变 Graph 结构或常量表达式才重新生成 GLSL。

## 8. MVP 节点范围

### 8.1 必需节点

**Output**

- Fragment Output（Color `vec4`）

**Input**

- Fragment Coord
- UV
- Aspect-correct UV
- Resolution
- Time
- Time Delta
- Frame
- Mouse

**Value / Parameter**

- Bool、Int、Float
- Vec2、Vec3、Vec4
- Color
- Exposed Parameter

**Vector**

- Combine / Split
- Swizzle
- Dot
- Length
- Distance
- Normalize
- Reflect

**Math**

- Add、Subtract、Multiply、Divide
- Min、Max、Clamp、Saturate
- Mix、Step、Smoothstep
- Abs、Sign、Floor、Ceil、Fract
- Sin、Cos、Tan
- Pow、Exp、Log、Sqrt
- Mod

**Color**

- RGB/HSV Convert
- Brightness/Contrast
- Color Mix

### 8.2 让 MVP 真正“可做效果”的小型视觉节点包

在核心稳定后加入：

- Translate 2D
- Rotate 2D
- Scale 2D
- Repeat 2D
- Circle SDF
- Box SDF
- Union / Intersection / Subtract
- Smooth Union
- Fill / Outline / Glow Mask

这些节点仍可先输出普通 `float`，无需第一版就引入复杂 SDF 专用类型。

### 8.3 MVP 明确不做

- 任意 GLSL Code Node。
- 循环、递归和任意控制流。
- GLSL 到 Graph 反编译。
- Texture/Keyboard/Volume 输入。
- Graph 内 Feedback。
- Buffer/Sound Graph。
- Node Group 和自定义函数。
- 完整 3D Raymarch 材质系统。

## 9. 与现有功能的集成规则

### 9.1 Uniform

- Graph Parameter 使用稳定 ID，显示名称可重命名。
- 编译器输出当前 Runtime 已支持的 `float/int/bool/vec2/vec3/vec4` Uniform。
- 所有启用 Pass 对同名 Uniform 进行全局同类型校验。
- 现有 Uniform Inspector 继续工作，但数据源改为 Code 声明与 Graph 编译结果的统一契约。

### 9.2 模板

- 现有模板全部保持 Code 模式。
- 新增 Graph Template schema 后，可提供渐变、噪声、SDF 图形等示例。
- Graph 模板仍携带生成 GLSL fallback。

### 9.3 AI

MVP：

- AI 继续只生成 GLSL。
- 当前 Pass 是 Graph 时，应用 AI 代码必须提示“这会将该 Pass 转为 Code”。
- 禁止静默覆盖 Graph 生成源码。

后续：

- AI 返回受 schema 约束的 Graph 操作列表，例如 `addNode/connect/setValue/removeNode`。
- 在 Graph 克隆上预览，经过 schema、类型和编译校验后原子提交。
- 不允许模型直接覆盖整份 Graph JSON。

### 9.4 Shadertoy

- 导入项目始终为 Code 模式，不自动图化。
- 导出使用 `effectiveSources` 中的生成 GLSL。
- Graph JSON 使用独立“导出 Graph”功能。

### 9.5 图片和视频导出

导出器不需要修改 Graph 逻辑，只需：

- 导出前确认 Graph 当前 revision 已成功生成并由 Runtime 编译。
- Graph 有错误或预览处于 stale 状态时阻止导出。
- 所有格式继续使用同一份 `effectiveSources`。

## 10. 前置技术债务

在 Graph 功能正式接入前，建议先处理：

1. 为 `PASS_FILES` 补充 `sound: 'passes/sound.glsl'`。
2. Autosave 恢复按 payload 的 `savedAt` 选择最新版本，而不是按文件编号倒序。
3. `runtimeSetup` 对禁用 Buffer 传 `undefined`，避免残留源码仍被编译执行。
4. 将 `runtimeSetup` 构造从 `App.tsx` 抽到 `setupBuilder.ts`。
5. 将项目版本解析改为正式 migration pipeline。
6. 合并重复的 Shadertoy/代码导出入口，确保都读取 `effectiveSources`。
7. 为诊断增加 origin/stage，避免 Graph 接入后继续假设所有错误都属于 Monaco 行号。

## 11. 分阶段实施计划

### M0：基础收敛与兼容层

**目标**：在不引入节点 UI 的前提下，建立 Graph 可以安全接入的边界。

任务：

- 修复上述前置技术债务。
- 新增 `ProjectStore`、`EditorStore` 的最小骨架，逐步减轻 `App.tsx`。
- 新增 `effectiveSources` 和 `setupBuilder`。
- 建立项目 `1.0 -> 2.0` 迁移框架，但默认仍生成 Code Pass。
- 建立统一诊断模型。

验收：

- 所有旧项目打开、保存、预览和导出结果不变。
- 禁用 Buffer 不再参与 Runtime 编译。
- Autosave 确实恢复时间最新的快照。
- 所有现有导出入口读取同一份 effective source。

预计：3–5 个开发日。

### M1：无 UI Graph 编译核心

**目标**：给定 Graph JSON，可以稳定生成可运行 GLSL。

任务：

- Graph model/schema/version migration。
- Node Registry 和第一批核心节点。
- 结构校验、循环检测和类型推导。
- Typed IR、拓扑排序和确定性 GLSL emitter。
- Graph Source Map 和统一诊断转换。
- 语义 hash 与最后成功编译 revision。

验收：

- 相同 Graph 始终生成完全相同的 GLSL。
- 非法连接、类型错误、缺 Output 和循环均返回节点级诊断。
- 至少覆盖 30 个核心节点。
- 生成结果可直接通过现有 Runtime 编译并显示。
- 200 节点图的 Graph 编译目标耗时低于 50ms（常规桌面环境）。

预计：8–12 个开发日。

### M2：Image Graph 编辑器 MVP

**目标**：用户能够完全通过节点制作一个 Image Shader。

任务：

- `ShaderEditorWorkspace` 与 Graph/Generated Code 视图。
- 节点画布、Socket、SVG 连线和搜索面板。
- 选择、框选、拖动、连接、删除、复制粘贴。
- Undo/Redo command stack。
- Inspector 和 Parameter 编辑。
- 语义变化 debounce 编译；布局变化不重编译。
- 节点错误高亮和诊断跳转。
- “Detach to Code”单向转换。
- 加入小型 2D SDF 节点包和示例 Graph。

验收：

- 不写 GLSL 可以制作动态渐变、UV 变形和基础 SDF 动画。
- 连接不兼容 Socket 时有明确反馈。
- Undo/Redo 覆盖节点、边和参数操作。
- Graph 错误不会清空最后有效预览。
- Generated Code 只读且可复制。

预计：10–15 个开发日。

### M3：项目持久化与崩溃恢复

**目标**：Graph 成为可靠的项目数据，而不只是 UI 临时状态。

任务：

- 保存/加载 `graphs/*.shadergraph.json`。
- 保存 generated GLSL 和 semantic hash。
- Autosave V2 保存完整项目和 Graph。
- Graph 缺失、损坏、版本过高的 fallback UI。
- Graph 文件和生成 GLSL 的一致性检查。
- 原子或准原子多文件保存。
- Graph 项目模板。

验收：

- 关闭重开后节点、连线、参数、位置和 viewport 完整恢复。
- 强制终止应用后可恢复最后 Graph 自动保存。
- 1.0 Code 项目零损迁移。
- Graph 文件损坏时仍可使用 generated GLSL 恢复，不会静默丢图。

预计：5–8 个开发日。

### M4：现有功能集成与 MVP 发布

**目标**：Graph 项目与现有产品能力一致。

任务：

- Uniform Inspector 合并 Code 与 Graph Parameters。
- PNG/GIF/MP4/WebM 导出 revision 校验。
- Shadertoy 导出使用 generated GLSL。
- AI 在 Graph Pass 上的安全边界和 Detach 确认。
- Graph 模板、复制代码和独立 Graph 导出。
- 键盘操作、焦点管理和基础无障碍支持。
- 大图性能、错误恢复和 GPU 编译压力测试。

验收：

- Graph 项目可正常预览、保存、自动恢复和导出全部视觉格式。
- 当前 Graph 无效时不能误导性导出旧预览。
- 旧 Code 工作流无功能回退。
- 主要操作有键盘路径，节点图在 500 节点内保持可交互。

预计：5–8 个开发日。

### M5：多 Pass Graph

**目标**：Image 和 Buffer A-D 都可以使用 Graph，并可视化项目 Pass 关系。

任务：

- 每 Pass 独立 Graph 文档。
- 项目级 Pass Graph。
- iChannel 0–3 自动/手动分配。
- 显式 Previous Frame / Feedback 边。
- Pass 循环与通道冲突诊断。
- 明确定义 current-frame 和 previous-frame 读取语义，并相应调整 Runtime 调度。

注意：当前 Runtime 中 Buffer B 读取 Buffer A 时实际读到上一帧纹理。项目级图上线前必须先明确并记录该语义，不能让 UI 暗示为本帧顺序执行。

### M6：纹理、Node Group 与 3D SDF

按以下顺序扩展：

1. 纹理 Asset Manifest、导入复制、Texture2D 节点、filter/wrap、颜色空间。
2. `iChannelResolution` 等纹理元数据。
3. 有类型、纯函数、无递归的 Node Group。
4. 有明确输入输出声明的 Custom GLSL Function Node。
5. 3D SDF primitive、transform、CSG、material、normal、raymarch output。
6. 最后再考虑 Sound Graph。

## 12. 测试与验收策略

### 12.1 编译器测试

- Graph schema/migration fixture。
- 节点类型推导单元测试。
- 循环、悬空边、缺失节点等失败测试。
- Graph -> GLSL golden tests。
- 生成代码稳定性/hash 测试。
- GLSL 行号到 node/socket 映射测试。

### 12.2 项目兼容测试

- 1.0 Code 项目打开/保存前后语义一致。
- 2.0 混合 Code/Graph 项目。
- Graph 文件缺失、损坏和高版本。
- Autosave V2、崩溃恢复和轮转。

### 12.3 UI 测试

- 画布 pan/zoom/selection/connection。
- Undo/Redo。
- 复制粘贴 ID 重建。
- 键盘焦点和删除操作。
- Graph 错误定位。

### 12.4 Runtime/导出测试

- Graph 生成 GLSL 与直接 Code 模式结果像素一致。
- Uniform 实时更新。
- PNG 与视频导出使用当前成功 revision。
- 多分辨率下 `iResolution` 正确。
- 后续多 Pass 阶段增加 Feedback 历史一致性测试。

## 13. 主要风险与控制方式

| 风险 | 后果 | 控制方式 |
|---|---|---|
| Graph 与生成 GLSL 双向编辑 | 数据源冲突、修改丢失 | Graph 单一真源；Generated Code 只读；显式 Detach |
| 第一版范围过大 | 长期无法形成可用版本 | MVP 仅 Image 无环表达式图，Buffer/纹理/Sound 延后 |
| 类型规则模糊 | 节点连接看似成功但生成错误代码 | 强类型 Socket，极少自动转换，错误在 Graph 阶段阻断 |
| Graph 无效却导出旧预览 | 用户得到错误结果 | revision/hash 校验，stale 状态禁止导出 |
| 项目多文件部分保存 | Graph 与 GLSL 不一致 | generatedHash、一致性检查、临时文件/原子替换 |
| 节点位置也触发编译 | 拖动画布卡顿 | 语义状态与 UI 布局状态分离 |
| 大图 DOM 性能下降 | 交互卡顿 | 统一 viewport、批量边层、后续视口裁剪/虚拟化 |
| 多 Pass Feedback 语义不清 | 预览与用户理解不一致 | 项目级图使用显式 Previous Frame，先定义 Runtime 时序 |
| 任意 Code Node 破坏类型系统 | 无法分析、映射或优化 | 延后；要求声明签名并作为 opaque IR |
| 旧项目迁移损坏 | 用户项目不可恢复 | 保留原 GLSL、fixture 测试、未知版本只读、保存前备份 |

## 14. 工作量判断

以一名熟悉当前项目的开发者估算：

- 可发布的 Image Graph MVP：约 **31–48 个开发日**，即约 **6–10 周**。
- 加入稳定多 Pass、Feedback 和纹理：额外约 **6–10 周**。
- 接近 Blender 的 Node Group、丰富纹理/SDF、Custom Function、资产系统与完整交互：属于持续演进能力，不建议设为首版目标。

该估算不包含大规模 UI 视觉重设计；若要求达到 Blender 级别的节点交互细节，需额外预留打磨周期。

## 15. 推荐的第一个可交付切片

不要先做完整画布。第一个开发切片应是：

1. 定义最小 Graph schema。
2. 实现 `UV -> Multiply -> Sin -> Color -> Fragment Output` 所需的 8–10 个节点。
3. 用固定 JSON 生成确定性 `mainImage` GLSL。
4. 接入现有 Runtime 预览。
5. 做一个仅支持创建、拖动和连线的最小 Graph Canvas。
6. 支持保存/重开一个 Image Graph。

这个切片可以尽早验证最关键的三件事：

- 节点模型是否易扩展；
- 生成代码是否能无缝复用现有 Runtime；
- 节点交互是否适合当前 SolidJS UI。

验证通过后，再扩展完整节点库、诊断、Undo/Redo、项目迁移和导出集成。