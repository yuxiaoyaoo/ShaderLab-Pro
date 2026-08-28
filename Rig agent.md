# ShaderLab Pro — 基于 Rig 的技术方案

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ShaderLab Pro                                │
│                                                                     │
│  ┌───────────┐    ┌──────────────────────────────────────────────┐  │
│  │  Tauri    │    │              Rust Core                        │  │
│  │  前端     │◄──►│                                              │  │
│  │  (Web)    │    │  ┌────────────────────────────────────────┐  │  │
│  │           │    │  │         Phase State Machine             │  │  │
│  │ · 代码编辑│    │  │                                        │  │  │
│  │ · 实时预览│    │  │  Planning ──► Coding ──► Testing ──► Doc│  │  │
│  │ · 对话面板│    │  │      ▲                        │         │  │  │
│  │ · 模板库  │    │  │      └────────────────────────┘         │  │  │
│  │           │    │  └────────────────────────────────────────┘  │  │
│  └───────────┘    │                    │                          │  │
│                   │                    ▼                          │  │
│                   │  ┌────────────────────────────────────────┐  │  │
│                   │  │         Rig Agent (单 Agent)            │  │  │
│                   │  │                                        │  │  │
│                   │  │  Model: Claude Sonnet / GPT-4o         │  │  │
│                   │  │  Preamble: ShaderLab System Prompt     │  │  │
│                   │  │  Tools:                                │  │  │
│                   │  │    · search_templates()                │  │  │
│                   │  │    · compile_glsl()                    │  │  │
│                   │  │    · render_test()                     │  │  │
│                   │  │    · get_reference()                   │  │  │
│                   │  │  Extractor: ShaderResponse             │  │  │
│                   │  └────────────────────────────────────────┘  │  │
│                   │                    │                          │  │
│                   │                    ▼                          │  │
│                   │  ┌────────────────────────────────────────┐  │  │
│                   │  │         Validation Layer                │  │  │
│                   │  │                                        │  │  │
│                   │  │  glslang (编译) ──► wgpu (渲染)        │  │  │
│                   │  └────────────────────────────────────────┘  │  │
│                   └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、项目文件结构

```
shaderlab-pro/
├── Cargo.toml
├── src/
│   ├── main.rs                     # Tauri 入口
│   ├── lib.rs
│   │
│   ├── agent/                      # Rig Agent 核心
│   │   ├── mod.rs
│   │   ├── builder.rs              # AgentBuilder 配置
│   │   ├── prompts.rs              # System Prompt + 阶段指令
│   │   ├── extractor.rs            # ShaderResponse 结构化输出
│   │   └── phase.rs                # 阶段状态机
│   │
│   ├── tools/                      # Rig Tool 实现
│   │   ├── mod.rs
│   │   ├── search_templates.rs     # 模板库检索
│   │   ├── compile_glsl.rs         # glslang 编译验证
│   │   ├── render_test.rs          # wgpu 渲染验证
│   │   └── get_reference.rs        # 参考示例获取
│   │
│   ├── templates/                  # 模板库
│   │   ├── mod.rs
│   │   ├── registry.rs             # 模板注册与检索
│   │   └── data/                   # 模板文件 (.glsl + metadata.json)
│   │       ├── particles/
│   │       ├── geometry/
│   │       ├── materials/
│   │       ├── postprocess/
│   │       └── scenes/
│   │
│   ├── validation/                 # 验证层（非 LLM）
│   │   ├── mod.rs
│   │   ├── compiler.rs             # glslang 封装
│   │   └── renderer.rs             # wgpu 帧测试
│   │
│   ├── ipc/                        # Tauri IPC 命令
│   │   ├── mod.rs
│   │   ├── chat.rs                 # 对话相关命令
│   │   └── preview.rs              # 预览相关命令
│   │
│   └── config/                     # 配置
│       ├── mod.rs
│       └── settings.rs             # API Key, 模型选择等
│
├── frontend/                       # Tauri 前端 (React/Svelte)
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx       # 对话面板
│   │   │   ├── CodeEditor.tsx      # GLSL 编辑器
│   │   │   ├── PreviewCanvas.tsx   # 实时预览
│   │   │   └── TemplateGallery.tsx # 模板库
│   │   └── ...
│   └── ...
│
└── tests/
    ├── agent_test.rs
    ├── tools_test.rs
    └── validation_test.rs
```

---

## 三、Cargo.toml 核心依赖

```toml
[package]
name = "shaderlab-pro"
version = "0.1.0"
edition = "2021"

[dependencies]
# AI Agent 框架
rig-core = "0.8"

# LLM Provider
rig-anthropic = "0.8"       # Claude
# rig-openai = "0.8"        # 备选: GPT-4o

# 桌面应用
tauri = { version = "2", features = ["tray-icon"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# GLSL 编译验证
glslang-sys = "0.4"         # glslang FFI 绑定
# 或者用 subprocess 调用 glslangValidator

# GPU 渲染验证
wgpu = "24"
pollster = "0.4"

# 异步运行时
tokio = { version = "1", features = ["full"] }

# 模板检索
tantivy = "0.22"            # 本地全文搜索（模板库）

# 工具
thiserror = "2"
tracing = "0.1"
tracing-subscriber = "0.3"
```

---

## 四、Rig Agent 核心实现

### 4.1 Agent 构建 (`agent/builder.rs`)

```rust
use rig::providers::anthropic::Client;
use rig::agent::AgentBuilder;
use crate::tools::{SearchTemplates, CompileGlsl, RenderTest, GetReference};
use crate::agent::prompts::SHADERLAB_SYSTEM_PROMPT;
use crate::agent::extractor::ShaderResponse;

pub struct ShaderAgent {
    agent: rig::agent::Agent<
        rig::providers::anthropic::CompletionModel,
        (SearchTemplates, CompileGlsl, RenderTest, GetReference),
        ShaderResponse,
    >,
}

impl ShaderAgent {
    pub fn new(api_key: &str) -> Self {
        let client = Client::new(api_key);
        let model = client.completion_model("claude-sonnet-4-20250514");

        let agent = AgentBuilder::new(model)
            .preamble(SHADERLAB_SYSTEM_PROMPT)
            .temperature(0.7)
            .max_tokens(4096)
            // 注册 4 个 Tools
            .tool(SearchTemplates)
            .tool(CompileGlsl)
            .tool(RenderTest)
            .tool(GetReference)
            // 结构化输出
            .extractor::<ShaderResponse>()
            .build();

        Self { agent }
    }

    /// 核心对话入口
    pub async fn chat(&self, phase: Phase, user_message: &str, context: &SessionContext) 
        -> Result<AgentResponse, AgentError> 
    {
        let phase_instruction = phase.instruction();
        let full_prompt = format!(
            "[当前阶段: {}]\n{}\n\n[会话上下文]\n{}\n\n[用户消息]\n{}",
            phase.name(),
            phase_instruction,
            context.serialize(),
            user_message,
        );

        let response = self.agent
            .prompt(&full_prompt)
            .await?;

        Ok(AgentResponse::from_rig(response))
    }
}
```

### 4.2 结构化输出 (`agent/extractor.rs`)

```rust
use rig::completion::ToolDefinition;
use serde::{Deserialize, Serialize};

/// Agent 的结构化输出格式
#[derive(Debug, Serialize, Deserialize)]
pub struct ShaderResponse {
    /// Agent 当前意图
    pub intent: Intent,
    /// 生成的 GLSL 代码（Coding 阶段）
    #[serde(default)]
    pub code: Option<ShaderCode>,
    /// 推荐/匹配的模板（Planning 阶段）
    #[serde(default)]
    pub suggestions: Vec<TemplateSuggestion>,
    /// 追问内容（Planning 阶段，信息不足时）
    #[serde(default)]
    pub clarification: Option<String>,
    /// 文档/解释（Documentation 阶段）
    #[serde(default)]
    pub documentation: Option<ShaderDoc>,
    /// 错误信息（Testing 阶段失败时）
    #[serde(default)]
    pub error_feedback: Option<ErrorFeedback>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    /// 需要更多信息，追问用户
    Clarify,
    /// 推荐模板/方案
    Suggest,
    /// 生成/修改代码
    Generate,
    /// 报告编译/渲染错误
    ReportError,
    /// 提供文档
    Document,
    /// 任务完成
    Complete,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShaderCode {
    /// Fragment Shader 源码
    pub fragment: String,
    /// Vertex Shader（可选，默认全屏四边形）
    #[serde(default)]
    pub vertex: Option<String>,
    /// 使用的 uniform 变量列表
    pub uniforms: Vec<UniformDecl>,
    /// Shadertoy 兼容的输入（iTime, iResolution 等）
    pub shadertoy_inputs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateSuggestion {
    pub name: String,
    pub description: String,
    pub category: String,
    pub preview_thumbnail: String,
    pub code: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShaderDoc {
    /// 逐行/逐块注释
    pub inline_comments: String,
    /// 算法原理说明
    pub algorithm_explanation: String,
    /// 可调参数说明
    pub parameters: Vec<ParamDoc>,
    /// 性能注意事项
    pub performance_notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorFeedback {
    pub phase: String,          // "compile" | "render"
    pub message: String,
    pub line: Option<u32>,
    pub suggestion: String,
}
```

### 4.3 阶段状态机 (`agent/phase.rs`)

```rust
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Planning,
    Coding,
    Testing,
    Documentation,
}

impl Phase {
    pub fn name(&self) -> &'static str {
        match self {
            Phase::Planning => "规划",
            Phase::Coding => "实现",
            Phase::Testing => "测试",
            Phase::Documentation => "文档",
        }
    }

    pub fn instruction(&self) -> &'static str {
        match self {
            Phase::Planning => PLANNING_INSTRUCTION,
            Phase::Coding => CODING_INSTRUCTION,
            Phase::Testing => TESTING_INSTRUCTION,
            Phase::Documentation => DOCUMENTATION_INSTRUCTION,
        }
    }

    /// 根据 Agent 响应决定下一阶段
    pub fn next(&self, response: &ShaderResponse) -> Phase {
        match self {
            Phase::Planning => {
                match response.intent {
                    Intent::Clarify | Intent::Suggest => Phase::Planning, // 留在规划
                    Intent::Generate => Phase::Coding,                     // 进入实现
                    _ => Phase::Planning,
                }
            }
            Phase::Coding => Phase::Testing,  // 代码生成后必须测试
            Phase::Testing => {
                match response.intent {
                    Intent::ReportError => Phase::Coding,      // 失败→回到实现
                    Intent::Complete => Phase::Documentation,   // 成功→进入文档
                    _ => Phase::Coding,
                }
            }
            Phase::Documentation => Phase::Planning, // 完成→回到起点
        }
    }
}

const PLANNING_INSTRUCTION: &str = r#"
你正在【规划阶段】。目标：理解用户需求，必要时追问澄清，或推荐合适的模板。

规则：
1. 如果用户描述模糊（如"好看的""发光的东西"），先追问 1-2 个具体问题
2. 如果用户明确，使用 search_templates 工具查找匹配模板
3. 给出 2-3 个方案供用户选择，每个方案附带简短描述
4. 不要在此阶段生成完整代码
5. 如果用户说"直接生成"/"你来决定"，则选择最合适的方案并进入实现

输出格式：
- 追问时：intent = "clarify"，clarification 字段填写问题
- 推荐时：intent = "suggest"，suggestions 字段填写匹配模板
- 就绪时：intent = "generate"，准备进入下一阶段
"#;

const CODING_INSTRUCTION: &str = r#"
你正在【实现阶段】。目标：生成高质量的 GLSL Fragment Shader 代码。

规则：
1. 生成完整的、可编译的 GLSL 代码
2. 遵循 Shadertoy 约定：
   - 入口函数为 void mainImage(out vec4 fragColor, in vec2 fragCoord)
   - 可用 uniform: iTime, iResolution, iMouse, iChannel0-3
3. 代码必须包含：
   - 文件头部注释（标题、作者、日期）
   - 关键算法的行内注释
   - 合理的默认参数值
4. 如果用户提供了参考模板，基于模板修改而非从零开始
5. 优先使用数学函数而非纹理采样（除非必要）

输出格式：intent = "generate"，code 字段填写完整代码
"#;

const TESTING_INSTRUCTION: &str = r#"
你正在【测试阶段】。系统已自动执行编译和渲染验证。

规则：
1. 如果编译失败：分析错误信息，给出具体修复方案
2. 如果渲染为黑帧/异常：分析可能原因（除零、未初始化、坐标错误等）
3. 如果测试通过：确认成功，准备进入文档阶段
4. 不要重新生成全部代码，只修复出错部分
5. 最多重试 3 次，如果仍失败，告知用户并建议替代方案

输出格式：
- 失败：intent = "report_error"，error_feedback 字段填写分析
- 成功：intent = "complete"
"#;

const DOCUMENTATION_INSTRUCTION: &str = r#"
你正在【文档阶段】。目标：为生成的 shader 提供清晰的文档。

规则：
1. 生成逐块注释（不是逐行，避免噪声）
2. 用 2-3 段话解释核心算法原理
3. 列出所有可调参数及其效果
4. 如果有性能敏感点，给出优化建议
5. 语气友好、面向中级图形学开发者

输出格式：intent = "document"，documentation 字段填写文档
"#;
```

### 4.4 System Prompt (`agent/prompts.rs`)

```rust
pub const SHADERLAB_SYSTEM_PROMPT: &str = r#"
你是 ShaderLab Pro 的 AI 助手，专注于帮助用户创建、修改和理解 GLSL Shader。

## 你的身份
- 你是一位资深图形程序员，精通 GLSL、Shadertoy、WebGL、实时渲染
- 你同时是一位耐心的老师，善于向不同水平的用户解释概念
- 你的目标是让用户在 30 秒内看到可运行的 shader 效果

## 核心能力
1. 根据自然语言描述生成 GLSL Fragment Shader
2. 搜索和推荐模板库中的现有 shader
3. 分析编译错误和渲染异常，给出修复方案
4. 解释 shader 算法原理和可调参数

## 技术约束
- 目标语言：GLSL 330 core（桌面）/ GLSL ES 3.0（移动端）
- 入口约定：Shadertoy 风格 mainImage(out vec4 fragColor, in vec2 fragCoord)
- 可用 uniform：iTime(float), iResolution(vec3), iMouse(vec4), iChannel0-3(sampler2D)
- 坐标归一化：fragCoord / iResolution.xy → [0,1]，中心对齐 → [-1,1]
- 禁止使用：#include、外部扩展、未声明的 uniform

## 代码风格
- 缩进：4 空格
- 命名：camelCase 变量，UPPER_CASE 常量
- 注释：关键算法必须有注释，参数必须标注范围
- 长度：优先简洁，单文件不超过 200 行（除非用户明确要求复杂效果）

## 交互原则
- 如果用户描述模糊，最多追问 1 次，然后给出最合理的默认实现
- 每次生成后主动建议 2-3 个可调方向（"你可以试试改颜色/速度/密度"）
- 遇到不确定的效果，诚实说明并给出最接近的替代
- 永远不要编造不存在的 GLSL 函数或 uniform
"#;
```

---

## 五、Tool 实现

### 5.1 模板搜索 (`tools/search_templates.rs`)

```rust
use rig::tool::Tool;
use serde::{Deserialize, Serialize};
use crate::templates::registry::TemplateRegistry;

#[derive(Debug)]
pub struct SearchTemplates {
    registry: TemplateRegistry,
}

#[derive(Debug, Deserialize)]
pub struct SearchInput {
    /// 用户的描述或关键词
    pub query: String,
    /// 可选：分类过滤
    #[serde(default)]
    pub category: Option<String>,
    /// 返回数量（默认 3）
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize { 3 }

#[derive(Debug, Serialize)]
pub struct SearchOutput {
    pub results: Vec<TemplateMatch>,
}

#[derive(Debug, Serialize)]
pub struct TemplateMatch {
    pub name: String,
    pub description: String,
    pub category: String,
    pub code: String,
    pub relevance_score: f32,
}

impl Tool for SearchTemplates {
    const NAME: &'static str = "search_templates";
    const DESCRIPTION: &'static str = 
        "搜索模板库中匹配的 shader 模板。当用户描述模糊或需要参考时使用。";

    type Input = SearchInput;
    type Output = SearchOutput;

    async fn execute(&self, input: Self::Input) -> Result<Self::Output, String> {
        let results = self.registry
            .search(&input.query, input.category.as_deref(), input.limit)
            .map_err(|e| format!("模板搜索失败: {}", e))?;

        Ok(SearchOutput { results })
    }
}
```

### 5.2 GLSL 编译验证 (`tools/compile_glsl.rs`)

```rust
use rig::tool::Tool;
use serde::{Deserialize, Serialize};
use std::process::Command;
use tempfile::NamedTempFile;
use std::io::Write;

#[derive(Debug)]
pub struct CompileGlsl;

#[derive(Debug, Deserialize)]
pub struct CompileInput {
    /// 要编译的 GLSL 源码
    pub source: String,
    /// Shader 类型
    #[serde(default = "default_shader_type")]
    pub shader_type: String,  // "fragment" | "vertex"
}

fn default_shader_type() -> String { "fragment".to_string() }

#[derive(Debug, Serialize)]
pub struct CompileOutput {
    pub success: bool,
    pub errors: Vec<CompileError>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CompileError {
    pub line: u32,
    pub column: u32,
    pub message: String,
}

impl Tool for CompileGlsl {
    const NAME: &'static str = "compile_glsl";
    const DESCRIPTION: &'static str = 
        "编译验证 GLSL 代码。返回编译错误和警告。在生成或修改代码后必须调用。";

    type Input = CompileInput;
    type Output = CompileOutput;

    async fn execute(&self, input: Self::Input) -> Result<Self::Output, String> {
        // 写入临时文件
        let mut tmp = NamedTempFile::new().map_err(|e| e.to_string())?;
        write!(tmp, "{}", input.source).map_err(|e| e.to_string())?;

        // 调用 glslangValidator
        let output = Command::new("glslangValidator")
            .arg("--stdin")  // 或传入文件路径
            .arg("-S")
            .arg(&input.shader_type)
            .arg("-G")  // OpenGL 模式
            .arg(tmp.path().to_str().unwrap())
            .output()
            .map_err(|e| format!("无法执行 glslangValidator: {}", e))?;

        if output.status.success() {
            return Ok(CompileOutput {
                success: true,
                errors: vec![],
                warnings: parse_warnings(&output.stderr),
            });
        }

        let errors = parse_errors(&output.stderr);
        Ok(CompileOutput {
            success: false,
            errors,
            warnings: vec![],
        })
    }
}

fn parse_errors(stderr: &[u8]) -> Vec<CompileError> {
    // 解析 glslang 错误格式: "ERROR: 0:42: 'undeclared' : no matching overloaded function found"
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .filter(|l| l.starts_with("ERROR:"))
        .filter_map(|l| {
            // 解析行号和错误信息
            let parts: Vec<&str> = l.splitn(4, ':').collect();
            if parts.len() >= 4 {
                Some(CompileError {
                    line: parts[2].trim().parse().unwrap_or(0),
                    column: 0,
                    message: parts[3].trim().to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

fn parse_warnings(stderr: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .filter(|l| l.starts_with("WARNING:"))
        .map(|l| l.to_string())
        .collect()
}
```

### 5.3 渲染测试 (`tools/render_test.rs`)

```rust
use rig::tool::Tool;
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct RenderTest;

#[derive(Debug, Deserialize)]
pub struct RenderInput {
    pub fragment_source: String,
    /// 渲染分辨率
    #[serde(default = "default_resolution")]
    pub width: u32,
    #[serde(default = "default_resolution")]
    pub height: u32,
    /// 渲染时间点（用于动画验证）
    #[serde(default)]
    pub time: f32,
}

fn default_resolution() -> u32 { 512 }

#[derive(Debug, Serialize)]
pub struct RenderOutput {
    pub success: bool,
    /// 是否为全黑帧（可能表示错误）
    pub is_black_frame: bool,
    /// 是否为全白帧
    pub is_white_frame: bool,
    /// 平均亮度 (0.0-1.0)
    pub avg_brightness: f32,
    /// 非零像素占比
    pub coverage: f32,
    /// 渲染耗时 (ms)
    pub render_time_ms: f64,
    /// 缩略图 (base64 PNG，用于前端预览)
    pub thumbnail_base64: Option<String>,
}

impl Tool for RenderTest {
    const NAME: &'static str = "render_test";
    const DESCRIPTION: &'static str = 
        "使用 wgpu 渲染 shader 并验证输出。检测黑帧、白帧等异常。编译通过后调用。";

    type Input = RenderInput;
    type Output = RenderOutput;

    async fn execute(&self, input: Self::Input) -> Result<Self::Output, String> {
        let start = std::time::Instant::now();

        // 1. 创建 wgpu 离屏渲染管线
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .ok_or("无法获取 GPU 适配器")?;

        let (device, queue) = adapter.request_device(
            &wgpu::DeviceDescriptor::default(),
            None,
        ).await.map_err(|e| e.to_string())?;

        // 2. 编译 shader module
        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("test_shader"),
            source: wgpu::ShaderSource::Glsl {
                shader: std::borrow::Cow::Borrowed(&input.fragment_source),
                stage: wgpu::naga::front::glsl::Stage::Fragment,
                defines: Default::default(),
            },
        });

        // 3. 设置渲染管线（全屏三角形 + 离屏纹理）
        // ... (管线配置代码)

        // 4. 渲染到 offscreen texture
        // ... (渲染代码)

        // 5. 回读像素并分析
        let pixels = read_back_pixels(&device, &queue, &output_texture).await?;
        let analysis = analyze_frame(&pixels, input.width, input.height);

        let elapsed = start.elapsed();

        Ok(RenderOutput {
            success: true,
            is_black_frame: analysis.avg_brightness < 0.01,
            is_white_frame: analysis.avg_brightness > 0.99,
            avg_brightness: analysis.avg_brightness,
            coverage: analysis.coverage,
            render_time_ms: elapsed.as_secs_f64() * 1000.0,
            thumbnail_base64: Some(encode_thumbnail(&pixels, input.width, input.height)),
        })
    }
}
```

### 5.4 参考获取 (`tools/get_reference.rs`)

```rust
use rig::tool::Tool;
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct GetReference;

#[derive(Debug, Deserialize)]
pub struct RefInput {
    /// 参考类型
    pub ref_type: RefType,
    /// 具体标识（模板名/技术名）
    pub identifier: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefType {
    Template,       // 模板库中的完整代码
    Technique,      // 技术说明（如 "raymarching", "fbm", "sdf"）
    Uniform,        // uniform 用法说明
}

#[derive(Debug, Serialize)]
pub struct RefOutput {
    pub content: String,
    pub metadata: serde_json::Value,
}

impl Tool for GetReference {
    const NAME: &'static str = "get_reference";
    const DESCRIPTION: &'static str = 
        "获取参考代码或技术说明。用于查找特定技术的实现示例或 uniform 用法。";

    type Input = RefInput;
    type Output = RefOutput;

    async fn execute(&self, input: Self::Input) -> Result<Self::Output, String> {
        match input.ref_type {
            RefType::Template => {
                // 从模板库获取完整代码
                get_template_code(&input.identifier)
            }
            RefType::Technique => {
                // 从知识库获取技术说明 + 示例片段
                get_technique_doc(&input.identifier)
            }
            RefType::Uniform => {
                // 获取 uniform 变量的说明和用法
                get_uniform_doc(&input.identifier)
            }
        }
    }
}
```

---

## 六、Tauri IPC 层 (`ipc/chat.rs`)

```rust
use tauri::{AppHandle, State};
use crate::agent::{ShaderAgent, Phase, SessionContext};
use std::sync::Mutex;

pub struct AppState {
    pub agent: ShaderAgent,
    pub session: Mutex<Session>,
}

pub struct Session {
    pub phase: Phase,
    pub context: SessionContext,
    pub history: Vec<ChatMessage>,
}

#[tauri::command]
pub async fn chat(
    message: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ChatResponse, String> {
    let mut session = state.session.lock().unwrap();
    let current_phase = session.phase;

    // 调用 Agent
    let response = state.agent
        .chat(current_phase, &message, &session.context)
        .await
        .map_err(|e| e.to_string())?;

    // 状态机转换
    let next_phase = current_phase.next(&response.shader_response);
    session.phase = next_phase;
    session.history.push(ChatMessage::user(&message));
    session.history.push(ChatMessage::assistant(&response));

    // 如果有代码，触发前端预览更新
    if let Some(code) = &response.shader_response.code {
        app.emit("shader-updated", code).ok();
    }

    // 如果有模板推荐，触发前端模板面板更新
    if !response.shader_response.suggestions.is_empty() {
        app.emit("templates-suggested", &response.shader_response.suggestions).ok();
    }

    Ok(ChatResponse {
        text: response.display_text(),
        phase: next_phase.name().to_string(),
        has_code: response.shader_response.code.is_some(),
        suggestions: response.shader_response.suggestions,
    })
}

#[tauri::command]
pub async fn get_phase(state: State<'_, AppState>) -> Result<String, String> {
    let session = state.session.lock().unwrap();
    Ok(session.phase.name().to_string())
}

#[tauri::command]
pub async fn reset_session(state: State<'_, AppState>) -> Result<(), String> {
    let mut session = state.session.lock().unwrap();
    *session = Session::new();
    Ok(())
}
```

---

## 七、会话上下文管理

```rust
/// 跨轮次保持的上下文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionContext {
    /// 用户已确认的需求描述
    pub confirmed_requirements: Option<String>,
    /// 当前代码版本
    pub current_code: Option<ShaderCode>,
    /// 编译/渲染状态
    pub validation_status: ValidationStatus,
    /// 已尝试的修复次数
    pub fix_attempts: u32,
    /// 用户选择的模板（如果有）
    pub selected_template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ValidationStatus {
    NotStarted,
    CompileFailed { errors: Vec<CompileError> },
    RenderFailed { reason: String },
    Passed,
}

impl SessionContext {
    pub fn serialize(&self) -> String {
        let mut parts = vec![];

        if let Some(req) = &self.confirmed_requirements {
            parts.push(format!("已确认需求: {}", req));
        }
        if let Some(code) = &self.current_code {
            parts.push(format!("当前代码长度: {} 行", code.fragment.lines().count()));
        }
        parts.push(format!("验证状态: {:?}", self.validation_status));
        if self.fix_attempts > 0 {
            parts.push(format!("已尝试修复: {} 次", self.fix_attempts));
        }

        parts.join("\n")
    }
}
```

---

## 八、错误处理与重试策略

```rust
/// 测试阶段的重试逻辑
pub async fn test_with_retry(
    agent: &ShaderAgent,
    code: &mut ShaderCode,
    max_attempts: u32,
) -> TestResult {
    for attempt in 1..=max_attempts {
        // 编译验证
        let compile_result = compile_glsl(&code.fragment).await;
        if !compile_result.success {
            tracing::warn!("编译失败 (尝试 {}/{}): {:?}", attempt, max_attempts, compile_result.errors);
            
            if attempt == max_attempts {
                return TestResult::CompileFailed(compile_result.errors);
            }

            // 让 Agent 修复
            let fix = agent.fix_code(code, &compile_result.errors).await?;
            *code = fix;
            continue;
        }

        // 渲染验证
        let render_result = render_test(&code.fragment).await;
        if render_result.is_black_frame {
            tracing::warn!("黑帧检测 (尝试 {}/{})", attempt, max_attempts);
            
            if attempt == max_attempts {
                return TestResult::RenderFailed("输出为全黑帧".into());
            }

            let fix = agent.fix_black_frame(code).await?;
            *code = fix;
            continue;
        }

        return TestResult::Passed(render_result);
    }

    TestResult::MaxRetriesExceeded
}
```

---

## 九、模板库设计 (`templates/`)

### 元数据格式

```json
// templates/data/particles/starfield.json
{
    "name": "星空粒子",
    "category": "particles",
    "description": "使用哈希函数生成的星空背景，支持闪烁和视差",
    "tags": ["星空", "粒子", "闪烁", "背景", "simple"],
    "difficulty": "beginner",
    "uniforms": ["iTime", "iResolution"],
    "code_file": "starfield.glsl"
}
```

### 检索实现

```rust
pub struct TemplateRegistry {
    templates: Vec<TemplateEntry>,
    // 方案 A: 简单关键词匹配（MVP）
    // 方案 B: tantivy 全文索引（v1.1）
    // 方案 C: 嵌入向量（v2.0）
}

impl TemplateRegistry {
    pub fn load() -> Result<Self, anyhow::Error> {
        // 扫描 templates/data/ 目录，加载所有 .json + .glsl
        todo!()
    }

    pub fn search(
        &self, 
        query: &str, 
        category: Option<&str>, 
        limit: usize
    ) -> Result<Vec<TemplateMatch>, anyhow::Error> {
        // MVP: 关键词匹配 + 标签匹配
        let mut scores: Vec<(f32, &TemplateEntry)> = self.templates
            .iter()
            .filter(|t| category.map_or(true, |c| t.category == c))
            .map(|t| {
                let score = self.relevance_score(query, t);
                (score, t)
            })
            .filter(|(score, _)| *score > 0.1)
            .collect();

        scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        
        Ok(scores.into_iter()
            .take(limit)
            .map(|(score, t)| TemplateMatch {
                name: t.name.clone(),
                description: t.description.clone(),
                category: t.category.clone(),
                code: t.code.clone(),
                relevance_score: score,
            })
            .collect())
    }
}
```

---

## 十、数据流图

```
用户输入 "我想要一个火焰效果"
    │
    ▼
┌─────────────────────────────────────────┐
│ Phase: PLANNING                         │
│ Agent 调用 search_templates("火焰")     │
│ 返回: [粒子火焰, SDF火焰, 噪声火焰]    │
│ Agent: "我找到3种方案，你想用哪种？"     │
└─────────────────────────────────────────┘
    │ 用户选择 "粒子火焰"
    ▼
┌─────────────────────────────────────────┐
│ Phase: CODING                           │
│ Agent 基于模板生成完整代码              │
│ 输出: ShaderCode { fragment: "..." }   │
└─────────────────────────────────────────┘
    │ 自动触发
    ▼
┌─────────────────────────────────────────┐
│ Phase: TESTING                          │
│ 1. compile_glsl() → ✅ 通过            │
│ 2. render_test()  → ✅ 非黑帧          │
│ 3. 缩略图发送到前端预览                 │
└─────────────────────────────────────────┘
    │ 测试通过
    ▼
┌─────────────────────────────────────────┐
│ Phase: DOCUMENTATION                    │
│ Agent 生成:                            │
│ - 算法说明（粒子系统 + 噪声扰动）      │
│ - 参数说明（颜色、速度、密度）         │
│ - 性能建议                             │
└─────────────────────────────────────────┘
    │
    ▼
前端显示: 代码 + 预览 + 文档 + "试试调整颜色？"
```

---

## 十一、实施路线图

|阶段|时间|交付物|优先级|
|---|---|---|---|
|**M0: 骨架**|第 1 周|Tauri 项目 + Rig 集成 + 最简对话（无 Tool）|P0|
|**M1: 核心生成**|第 2-3 周|Coding 阶段 + compile_glsl Tool + 错误重试|P0|
|**M2: 渲染验证**|第 4 周|render_test Tool + wgpu 离屏渲染 + 缩略图|P0|
|**M3: 规划阶段**|第 5 周|模板库（20个）+ search_templates + 追问逻辑|P1|
|**M4: 文档阶段**|第 6 周|文档生成 + 前端展示|P1|
|**M5: 体验打磨**|第 7-8 周|流式输出、快捷键、模板预览、导出|P2|
|**M6: 扩展**|后续|更多模板、用户自定义模板、多模型切换|P3|

---

## 十二、关键设计决策总结

|决策|选择|理由|
|---|---|---|
|Agent 架构|单 Agent + 4 Tools|任务封闭、验证客观、延迟敏感|
|阶段控制|Rust 状态机（非 LLM 自主切换）|确定性、可调试、不会跳步|
|验证方式|glslang + wgpu（确定性）|零幻觉、零成本、毫秒级|
|模板检索|关键词匹配 → tantivy → 嵌入|渐进式复杂度|
|结构化输出|Rig Extractor + serde|类型安全、前端直接消费|
|重试策略|最多 3 次，同一上下文|避免无限循环，保持信息完整|
|前端通信|Tauri IPC + Event|低延迟、类型安全|
|模型选择|Claude Sonnet（默认）|代码质量最优、成本可控|

---

这就是完整方案。需要我展开任何一个模块的具体实现细节吗？

---

## 十三、M6 扩展实施规划（P3 · 收官里程碑）

> 2026-08-27 落盘。前一里程碑 M5「体验打磨」（流式输出 / 快捷键 / 模板预览 / 导出）已全部交付并通过全量回归：`cargo test` lib 单测 16 + e2e 集成 17 全绿，`tsc --noEmit` 无错。

### 13.1 目标

兑现 §十一 路线图最后一行：**更多模板、用户自定义模板、多模型切换**。三项均有现成地基，增量可控。

### 13.2 子任务分解与执行状态

| # | 任务 | 核心内容 | 关键落点 | 状态 |
|---|---|---|---|---|
| **m6a** | 更多内置模板 | 每类 +2 共 10 个新 GLSL（流星雨 / 蜂群 / 莫比乌斯环 / 晶体群 / 丝绸 / 液态金属 / 胶片颗粒 / 鱼眼 / 极光 / 城市夜景）；manifest 同步；新增「全模板逐个过 glslang 编译」硬核单测；`len()==20` 断言改 `==30`；删除死常量 `DEFAULT_LIMIT`（registry.rs 现有编译警告） | `templates/registry.rs` · `templates/data/` | ✅ 完成 |
| **m6b** | 自定义模板·后端 | 架构解药：`TemplateEntry.code` 从 `&'static str` 改 `String`；`app_data_dir/user_templates/*.json` 目录存储（无缓存直读盘，写即生效）；`search` / `find_by_name` 双池合并检索；IPC 三命令 `list_user_templates` / `save_user_template` / `delete_user_template`，save 复用 compile_glsl 工具做编译预检；`select_template` 合并接入用户池 | `templates/registry.rs` 重构 · `ipc/chat.rs` | ✅ 完成 |
| **m6c** | 自定义模板·前端 | 「我的模板」分组 + 新建/编辑表单 + 删除；编辑器当前代码一键带入表单；应用走既有 adopt 通道；预览复用 M5e 非破坏性预览通道 | `TemplateDialog.tsx` | ✅ 完成（含 agentClient 三包装 + App 首个事件监听 user-templates-changed + 表单态内嵌对话框，tsc 零错误） |
| **m6d** | 多模型切换 | 后端静态 presets 清单（OpenAI / DeepSeek / 通义兼容 / Kimi / Ollama 本地 / LM Studio 本地）随 config 视图下发；设置弹窗模型行升级为 provider 下拉联动 base_url + model 推荐列表，保留手动输入兜底；热切换零后端改动——`rebuild_agent` 基础设施已备 | `ipc/chat.rs` · `AgentSettingsDialog.tsx` | ✅ 完成（presets 随 get/set config 双向下发 + 3 单测；前端 activePreset 由 base_url 派生避免双向同步、datalist 模型推荐、本地服务占位符提示，tsc/cargo 全绿） |
| **m6e** | 回归收尾 | 全量 `cargo test` + `tsc --noEmit` + 手动冒烟清单（换模型→对话、存自定义模板→AI suggest 命中） | — | ✅ 自动化完成（cargo lib 24 + e2e 17 全绿 / tsc 零错误）；GUI 实操项落档 §13.6 冒烟清单 |

### 13.3 已定设计假设（异议可推翻重议）

1. **不做多 profile 存档**：P3 范围裁剪，「多模型切换」落地为预设下拉联动 + 单配置热替换，与现有产品形态一致；完整多档案按需后续追加。
2. **用户模板文件格式**：一个模板 = `user_templates/` 下一个 JSON（name / category / description / tags / uniforms / code 全内嵌）；中文 bigram 检索逻辑对用户模板同等生效。
3. **同名冲突用户优先**：自定义模板与内置模板同名时，自定义版本胜出。
4. **质量门**：保存自定义模板前强制 glslang 编译预检——延续 M1 的「零幻觉验证」原则，不让坏代码污染检索池。

### 13.4 现状盘点结论（规划依据）

- `src/templates.ts` 与 Rust 注册表**不是双源重复**：前者是工程模板（多通道 buffers / Sound 的 Project 结构，服务新建项目流程），后者是 AI 检索库（M3 的 20 个单 Image GLSL，服务 suggest / select_template）。用户自定义模板挂后者。
- `set_agent_config` → `rebuild_agent`（ipc/chat.rs）已支持配置热替换并持久化到 `app_data_dir/shaderlab_agent_config.json`，「多模型切换」后端地基现成。
- `select_template` 目前只查内嵌 `TemplateRegistry::global()`；`TemplateEntry.code: &'static str` 是自定义模板的最大架构冲突点（磁盘文件代码无 `'static` 生命周期），故 m6b 首要动刀处即在此。

### 13.5 验收标准

- 内置模板池扩充至 30 个，且全部通过 glslang 编译单测；
- 用户可从零新建模板 → AI 对话检索能命中并一键采用；
- 切换 provider 仅需设置弹窗两步操作，对话即刻走新端点，重启后配置仍在；
- M0–M5 全部既有测试零回归。

### 13.6 手动冒烟清单（M6 收官 · 自动化已全绿，以下为 GUI 实操项）

**A. 多模型切换（m6a/m6d 联动）**

1. 打开设置弹窗 → 确认「服务商」下拉出现 6 个预设：OpenAI / DeepSeek / 通义兼容 / Kimi / Ollama 本地 / LM Studio 本地 + 自定义；
2. 选 DeepSeek → Base URL 与模型行自动联动为 `https://api.deepseek.com` + 推荐模型；下拉里手改任意 URL 字符 → 服务商回显切至「自定义」（派生状态正确性）;
3. 切换至 Ollama 本地 → API Key 占位符变为「本地服务可填任意字符，如 ollama」，模型推荐列表随预设切换；
4. 保存配置 → 发起一轮对话验证新端点生效；重启应用 → 配置仍在（`shaderlab_agent_config.json` 持久化），对话正常。

**B. 自定义模板（m6b/m6c 联动）**

5. 模板弹窗 → 确认顶部出现「📌 我的模板」分组（空态提示文案）与「🧱 项目模板」分组并列展示；
6. 「新建模板」→ 表单提交一段非法 GLSL → 应被后端 glslang 编译预检拦截，错误信息逐字显示于红色 `<pre>` 区块；改回合法代码 → 保存成功，列表即时刷新（user-templates-changed 事件链）；
7. 编辑器写入一段当前 shader 代码 → 「带入编辑器代码」→ 表单 code 域填充无误 → 保存；
8. 对自定义模板点「预览」→ M5e 非破坏性预览通道生效，主工程未被覆盖；点「应用」→ 阶段机经 adopt 通道推进（异常时直落代码兜底）；
9. 在 AI 对话中输入与自定义模板相关的中文关键词 → suggest 命中该用户模板；与内置同名时以自定义版本胜出；
10. 「删除」自定义模板 → window.confirm 二次确认 → 列表移除。

**C. 回归侧检（m6a）**

11. 模板库总数 30 个；m4a 内置模板编译单测全部通过（自动化 24+17 已覆盖，GUI 仅需确认弹窗分类渲染无样式错位）。

## 十四、M7 UI 重设计规划（P3 · 双主题 + 精简）

### 14.1 需求与风格决议

- **全方面 UI 重设计**：工具栏 / 侧栏 / 预览区 / 对话面板 / 弹窗统一刷新视觉。
- **双主题可切换**（用户最终决议）：
  - 深色 = **Aurora Glass**（深蓝底 `#070a18` + 极光径向渐变 + 玻璃拟态面板），默认主题；
  - 浅色 = **Soft Light**（薰衣草底 `#c6cbe9` + 白卡片 + 黑色药丸主按钮）；
  - 工具栏右上角 ☀/🌙 图标按钮一键切换，选择持久化到 `localStorage('shaderlab-theme')`。
- 设计稿：`design/m7-ui-mockup.html`（深色）/ `design/m7-ui-mockup-light.html`（浅色）。
- **功能裁剪**（用户明确要求）：
  - 删除「📷 截图」单帧 PNG 导出（序列帧导出已覆盖该需求）；
  - 关闭 Monaco minimap 缩略栏。

### 14.2 技术方案

- **令牌架构**：`styles.css` 重写为双主题 CSS 自定义属性——`:root` 为深色 Aurora Glass，`:root[data-theme='light']` 整组覆盖为 Soft Light；`color-scheme` 同步切换原生控件配色。旧变量（--bg/--panel/--text 等）以别名方式映射到新令牌，既有组件样式零改动兼容。
- **主题基础设施**：`src/theme.ts`——SolidJS signal + localStorage 持久化 + `documentElement.dataset.theme` 同步；`index.html` 头部内联脚本在首帧渲染前恢复主题，防止启动闪白/闪黑。
- **Monaco 跟随**：`index.tsx` 定义 `shaderlab-dark`（vs-dark 基底，背景对齐 `--code-bg: #0b1026`）与 `shaderlab-light`（vs 基底，背景 `#f0f3fc`）双主题；`EditorPane` 内 `createEffect` 监听主题 signal 调用 `monaco.editor.setTheme` 全局切换。
- **截图功能移除面**：App.tsx（takeShot 函数 / bridge capture 字段 / 📷 按钮）+ runtime.ts（RuntimeApi.capture 声明与实现）；`captureAt` 保留（序列帧导出 ExportDialog / videoExport 依赖）。
- **minimap**：EditorPane 创建参数 `minimap: { enabled: false }`。

### 14.3 m7a 执行状态

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| m7a-1 | 盘点截图/minimap/令牌/主题代码定位 | ✅ |
| m7a-2 | styles.css 双主题令牌系统重写（约 1806 行） | ✅ |
| m7a-3 | 主题切换基础设施（theme.ts / index.html 防闪烁 / Monaco 双主题与跟随 / 工具栏切换按钮） | ✅ |
| m7a-4 | 删除截图功能（5 处） | ✅ |
| m7a-5 | 关闭 Monaco minimap | ✅ |
| m7a-6 | agent.md 记录 | ✅ |
| m7a-7 | 回归验证 tsc + cargo test（tsc 零错误 / Rust 测试全绿） | ✅ |

### 14.4 手动冒烟清单

1. 冷启动 → 默认深色 Aurora Glass，无闪白；
2. ☀ 切浅色 → 全局（工具栏/侧栏/编辑器/对话/弹窗）切至 Soft Light；重启后仍为浅色（localStorage 恢复，无闪烁）；
3. 工具栏无「📷 截图」按钮；「🎞 序列帧」导出功能正常；
4. 编辑器右侧无 minimap 缩略栏；切换主题时代码编辑器配色跟随。

### 14.5 m7b 结构重构（对齐参考稿，2026-08-28）

**驱动**：用户反馈「现在的风格看起来不像参考图」——m7a 仅做了令牌换肤（旧 toolbar 布局 + 新配色），结构上与两份设计稿不符。m7b 将 JSX 与 CSS 布局骨架整体重构为参考稿结构。

**App.tsx 结构迁移**（旧 → 新）：
- `div.app` 内新增 `.aurora` 极光背景层（深色专属，浅色由 CSS 隐藏）；
- `.toolbar` 顶栏 → `.rail` 左侧 58px 玻璃导航（logo / 项目 / Pass / Uniform / 模板库 / 诊断 / spacer / 主题切换 / AI 设置 / AI 助手），菜单按钮改为 `.rail-btn` 图标钮 + `.rail-slot`/`.rail-pop` 右侧展开弹层；
- 顶栏改 `.topbar.glass` 浮动玻璃条：`.proj`（项目名 + 修改点 + 文件 chip）+ `.transport`（圆形 `.t-btn` ×3 + 渐变 `.t-play` + `input[type=range].timeline` 进度填充 + `.tl-time` + 倍速 `.chip` 下拉）+ 查看/分辨率 `.chip`；
- `.statusbar` → 编辑器卡片内 `.statusline`；`.toolbar-stats` → 画布右上 `.hud-tr` HUD 玻璃片；`.editor-column` → `.editor.glass` / `.preview.glass` 卡片；
- 预览区：`.canvas` 渐变底 + `.hud-tl`/`.hud-tr` 玻璃 HUD + `.float-ai` 悬浮 AI 按钮 + `.preset-strip` Uniform 迷你滑条（取前 3 个数值 slider，`--val` 填充）；
- topbar 品牌区改为 `.brand-col > .proj-row + .proj-sub`（副标题「ShaderLab Pro · GLSL 工作台」）——深色下 `display: contents` 打散为行内，浅色下呈现两行排版（对齐浅色稿 `.brand h1+p`）。

**styles.css 扩展**：
- 新增 M7b 结构令牌（双主题各一组）：`--glass-bg/--glass-shadow/--rail-btn-*/--tl-fill/--tl-track/--tl-thumb/--canvas-bg/--hud-bg/--chip-file-bg/--play-bg/--play-shadow`；
- 布局骨架：`.aurora`（双伪元素 + aurora-drift 动画 + prefers-reduced-motion 降级）、`.glass` 基类、`.rail` 系列、`.topbar/.transport/.t-btn/.t-play`、timeline `--val` 进度填充、`.chip` 系列、`.canvas/.hud*/.hud-chip/.float-ai/.preset-strip/.umi*`、`.statusline/.sl-status`；
- 浅色适配（`data-theme='light'` 覆盖）：`.app` 变 `.shell` 大圆角容器（margin 14px / radius 26px / `--bg1` 实底 + 大投影）、`.rail` 扁平化 64px、topbar 去玻璃改品牌排版、`.preview` 内衬 10px + `.canvas` 15px 圆角鲜艳蓝紫渐变（对齐浅色稿）；
- `.chat-panel` 卡片化（border-radius + glass-bg + overflow hidden）。
- 旧类清理：`.toolbar/.brand/.brand-mark/.toolbar-group/.toolbar-stats/.statusbar/.speed-group/.timeline-wrap/.editor-column` 规则移除；`.res-select` 保留（ExportDialog 仍在用）。

**m7b 执行状态**：

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| m7b-1 | 读取浅色稿捕获结构差异 | ✅ |
| m7b-2 | 重读 App.tsx 制定迁移映射 | ✅ |
| m7b-3 | App.tsx 结构重构（aurora + rail + glass） | ✅ |
| m7b-4 | styles.css 结构样式扩展（10 处编辑） | ✅ |
| m7b-5 | 浅色主题结构适配（shell/扁平 rail/品牌排版/鲜艳画布） | ✅ |
| m7b-6 | typecheck 通过 + Vite 预览无报错 | ✅ |
| m7b-7 | agent.md 记录（本节） | ✅ |

修复记录：m7b-3 迁移遗留重复 `</header>` 闭合标签导致 6 个级联 TS 错误，已修复并 typecheck 归零。

**m7b 冒烟补充**：深色下 rail 玻璃导航 + 极光背景 + 画布 HUD/悬浮 AI/Uniform 迷你滑条可见；浅色下应用整体为带外边距的大圆角 shell、rail 无卡片感、项目名下方有副标题、画布为鲜艳蓝紫渐变内衬卡片。

### 14.6 m7c 一致性优化（用户 5 点反馈，2026-08-28）

**驱动**：用户反馈深浅主题元素位置不统一、播放按钮偏大、编辑/预览间距过大、诊断按钮激活态形状不一致、查看/分辨率芯片下拉箭头重复——要求按浅色基准统一。

**修复明细**：

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 深浅主题布局/按钮位置不统一 | 基础(深色)与浅色覆盖采用两套几何值（rail 58px/10px 内衬 vs 64px/14px；main padding 两套；topbar padding 16px vs 2px） | 浅色几何值上提为全局基准：`.rail` 64px + `padding:14px 0`、`.main` `padding:14px 16px 16px 4px`、`.topbar` `padding:0 12px` 固定 54px 高；浅色覆盖仅保留视觉差异（margin 0 / 透明 / 无边框阴影），切主题不再跳位 |
| 2 | 播放按钮大于重置/导出 | `.t-play` 36×36 ≠ `.t-btn` 32×32 | `.t-play` 统一为 32×32（保留渐变+光晕） |
| 3 | 编辑器与预览区间距过大 | `.workspace` gap 10px | 缩至 6px（`.pane-divider` 7px 负外边距热区不变） |
| 4 | 诊断等 rail 按钮激活态为长条形 | `.menu-root.rail-slot .rail-btn{width:100%}` 而槽位自身宽度不定，被包裹按钮（Pass/Uniform/AI 设置/AI 助手）宽度塌缩成长方形；直连按钮（诊断/主题）固定 38×38 正常 | `.menu-root.rail-slot` 增加固定 `width:38px; flex:0 0 38px`，所有 rail 按钮统一 38×38 圆角 12px 方形 |
| 5 | 查看/分辨率芯片下拉箭头重复 | `<select class="chip-select">` 自带原生箭头 + 芯片内显式 SVG chevron 双重箭头 | 移除两处 SVG chevron（App.tsx），仅保留 select 原生箭头（位于数值一侧） |

**验证**：`npm run typecheck` 通过（exit 0）；Vite HMR 全量推送（styles.css ×6 + App.tsx ×2），预览无报错。

### 14.7 m7d 外壳统一与三处观感修复（用户 3 点反馈，2026-08-28）

**驱动**：用户反馈切换主题仍有元素跳位、深色模式下很多元素被"分割开"、浅色模式打开 AI 助手后"AI 助手"图标看不清。

**根因与修复**（仅改 `src/styles.css`）：

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 切主题仍跳位 | 浅色覆盖里残留 7 处**几何**差异：`.app`（height/margin/radius 外壳）、`.rail`（margin 10px→0）、`.brand-col`/`.proj-row`（display:contents→flex）、`.proj-name`（14px→19px）、`.proj-sub`（隐藏→显示）、`.dot-mod`（7px→8px）、`.preview`（padding 0→10px） | 全部上提为基础规则（以浅色几何为基准），深浅共享；新增 `--shell-bg`/`--shell-shadow` 令牌（深色半透明外壳透出极光，浅色实底白壳），浅色区只保留配色覆盖。主题差异 CSS 中不再存在任何几何属性，构造性零跳位 |
| 2 | 深色元素被分割 | 深色下 rail/topbar/editor/preview 各自是独立玻璃卡（各自边框+阴影+模糊背景），碎成多块悬浮板 | rail 基础规则去掉玻璃卡观感（透明、无边框阴影）；`.topbar` 基础规则覆盖 `.glass`（透明融入外壳，注意 `.topbar` 规则位于 `.glass` 之后靠源序取胜）；深色同样应用外壳容器。深浅均呈"一个外壳 + 两张内容卡"结构 |
| 3 | 浅色 AI 激活态图标看不清 | `:root[data-theme='light'] .rail-btn.active{background:#fff}`（特异度 0,4,0）压过 `.rail-ai.active` 的深色背景（0,2,0），而其 `color:#fff` 仍生效 → 白图标落白底 | 白底激活态改写为 `:root[data-theme='light'] .rail-btn.active:not(.rail-ai)`，AI 按钮继续走基础 `.rail-ai.active`（`--primary-bg-hover` 墨色底 + 白图标） |

**附带修正**：`.dot-mod` 合并重复 `box-shadow` 为一条双值声明（`0 0 0 3px …, 0 0 8px …`），避免后者覆盖前者。

**验证**：`npm run typecheck` 通过（exit 0）；浏览器 1600×900 回归截图 `.shots/dark-after.png` / `light-after.png` / `light-ai-after.png`——深浅两版元素位置像素级一致；深色 rail/顶栏融入外壳无分割感；浅色 AI 激活态 rail 按钮（左下）与悬浮按钮（右下）均为墨底白图标，清晰可见。

### 14.8 m8 创作留存生态：GIF/MP4 导出 + Shadertoy JSON 互通（2026-08-28）

**驱动**：用户提出"创作留存生态（逐帧渲染 → GIF/MP4 录制导出、Shadertoy JSON 互通）"需求，在既有 PNG 序列帧 / WebM / WAV 导出基础上补齐 GIF 动图、MP4 视频两种格式，并实现与 Shadertoy 官方 JSON 格式的双向转换。

**新增依赖**：`gifenc@1.0.3`（纯 JS GIF 编码器，逐帧调色板量化）、`mp4-muxer@5.2.2`（MP4 复用器，配 WebCodecs 硬件编码）。`src/types/gifenc.d.ts` 为 gifenc 补类型声明。

**新增模块**：

| 模块 | 职责 | 关键点 |
| --- | --- | --- |
| `src/export/gifExport.ts` | `exportGif()`：逐帧渲染 → gifenc 编码 | `GIF_MAX_FPS=50`：浏览器 GIF 帧延迟下限 20ms，60 FPS 物理不可达；`clampGifFps()` 供对话框钳制；每帧独立调色板（`quantize` + `applyPalette`） |
| `src/export/mp4Export.ts` | `exportMp4()`：VideoEncoder(H.264) + AudioEncoder(AAC) → mp4-muxer | 7 个 H.264 codec 候选逐个探测；`fastStart:'in-memory'` + `ArrayBufferTarget`；背压控制：视频 `encodeQueueSize>8` / 音频 `>16` 轮询等待；`isMp4ExportSupported()` 探测 WebCodecs 可用性 |
| `src/shadertoy/json.ts` | `toShadertoyJson()` / `parseShadertoyJson()` 双向转换 | 对齐官方 `shader.renderpass[]` 结构（type: image/buffer/sound/common）；buffer 链接经 `outputs[].id ↔ inputs[].id` 不透明数字 ID 映射回 BufferA-D；`shadertoyFileName()` 生成规范文件名 |

**UI 接线**：

- `ExportDialog.tsx`（m8-5）：格式下拉扩展为 PNG / GIF / MP4 / WebM / WAV 五项；MP4 项按 `isMp4ExportSupported()` 动态禁用；切到 GIF 自动把 FPS 钳到 50、切走恢复 60；按格式显隐——码率（webm/mp4）、分辨率（除 png/wav）、音频开关（webm/mp4）、每格式独立编码器说明（menu-info）、前缀后缀提示（`.gif`/`.mp4`/`.webm`）。
- `App.tsx`（m8-6）：项目菜单新增"导入 Shadertoy JSON…"/"导出 Shadertoy JSON…"（位于"另存为…"分隔线后）；导入走 `pickFile → readTextFile → parseShadertoyJson → applySources`（逐 Pass 拷贝 cfg + setMeta，汇总跳过项通知）；导出走 `pickFolder → toShadertoyJson → writeTextFile(joinPath(dir, name))`。
- 后端：`lib.rs` 新增 `pick_file` 命令（`rfd::AsyncFileDialog::pick_file`，`add_filter` 扩展名过滤），`bridge.ts` 补 `pickFile()` 封装（mock 分支 + `invoke('pick_file', { args })` + 无 Tauri 抛 `NativeUnavailableError`）。

**过程中发现并修复的两处问题**：

1. **Solid `select` + 动态 `option` 时序竞态**：切 GIF 时 `setFps(50)` 与 `setFormat('gif')` 同批刷新，Solid 按 effect 创建顺序先赋 `select.value`（旧选项表 24/30/60 无 "50"，赋值静默失败）后重建选项，浏览器回退显示首项"24 FPS"。修复：FPS 选项改为静态全量 `[24,30,50,60]`，GIF 模式仅对 60 加 `disabled`——选项永不增删，value 恒可匹配，竞态根除且"60 被禁用"提示更明确。
2. **同文件并行编辑互踩**：一次批量对 `lib.rs` 发两处 SearchReplace，后者基于旧文件状态覆盖了前者（函数体丢失、仅剩注册），`cargo check` 报 `cannot find macro __cmd__pick_file`。教训：**同一文件的多处修改不可并入同一批次**，须单次合并编辑或串行执行。修复后 `cargo check` 通过。

**验证**：`npm run typecheck` exit 0；`cargo check` exit 0；Vite HMR 无报错。agent-browser 回归（localhost:1420）：五格式下拉齐全；GIF 模式 FPS 正确钳 50 且 60 置灰、分辨率选择器出现；MP4 模式（headless Chrome 支持 WebCodecs）码率/分辨率/音频开关/编码器说明齐备，切回时 FPS 恢复 60；项目菜单两个 Shadertoy 入口就位，无 Tauri 环境点击导入被 try/catch 优雅接管（不崩溃、渲染循环持续）；WebM 面板截图确认编码器信息框、`.webm` 后缀、音频勾选框视觉完整，状态栏"编译通过"。

### 14.9 u9 五点观感修复：默认分辨率 / 缩进参考线 / 预览去框 / 主题衬底统一 / AI 入口整理（用户 5 点反馈，2026-08-28）

**驱动**：用户反馈五项——默认分辨率应为 1440×960；编辑器代码与"竖线"重叠（问竖线用途）；预览外部框与内部画面割裂，只要内部渲染部分；浅色深色模式看到的画面效果不一样；画面上的 AI 助手悬浮按钮不需要，AI 助手面板左上角图标要更现代。

**根因与修复**：

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 默认分辨率 | `lib.rs` 窗口构建为 `.inner_size(1280.0, 800.0)` | 改为 `.inner_size(1440.0, 960.0)`（`min_inner_size` 不变） |
| 2 | 代码与竖线重叠 | 竖线是 Monaco 默认**缩进参考线**（indent guides，指示缩进层级），与 GLSL 高密度代码视觉冲突 | `EditorPane.tsx` 创建选项加 `guides: { indentation: false }` 关闭 |
| 3 | 预览外框割裂 | `.preview` 同时挂 `glass` 卡片类 + 自带 `padding: 10px`，画布外多出一圈卡片壳 | `App.tsx` 去掉 `glass` 类；`styles.css` 删除 `.preview` 的 `padding`，画布直接贴内容区 |
| 4 | 深浅模式画面不一样 | 画布衬底 `--canvas-bg` 深色为近黑 `#05081a` 径向渐变、浅色为亮蓝紫 `#5b95ff→#7a5cf9` 线性渐变，同一 shader 在两种主题下观感漂移 | 按视频工具 letterbox 惯例，浅色主题的 `--canvas-bg` 覆写为与深色相同的深色衬底（注释说明"画布衬底两主题恒定深色"）；界面外壳仍随主题切换，仅预览衬底恒定 |
| 5 | AI 悬浮按钮 + 面板图标 | 画布右下 `float-ai` 悬浮按钮遮挡画面；面板标题为 🤖 emoji，观感陈旧 | 删除 `App.tsx` 中 `float-ai` 按钮 JSX 与 `styles.css` 整段样式（左侧栏 AI 入口保留）；`ChatPanel.tsx` 标题改用 SVG 渐变徽章图标（`linearGradient` #8b7bff→#4f7dff 圆角方块 + 白色四角星与次级星光），新增 `.chat-title-icon`（19px、圆角、投影）与 `.chat-title` inline-flex 布局 |

**验证**：`npm run typecheck` exit 0；`cargo check`（src-tauri）exit 0。agent-browser 1440×960 回归：深色首屏确认 #1/#2/#3/#5 生效（编辑器无竖线、画布无外框、画面无悬浮按钮）；切浅色定位 #4 根因并修复后，浅色画布衬底与深色一致（UNIFORM 条 DOM 校验仍在）；放大截图确认 AI 面板渐变徽章图标渲染清晰；切回深色终检通过。

### 14.10 u10 编辑器"竖线"根治：当前行高亮边框盒透明化（用户复核反馈，2026-08-28）

**驱动**：用户红框复测 u9 第 2 项——第 9 行长代码行尾仍有"竖线"与代码重叠，关闭缩进参考线的方案未根治。

**根因与修复**：agent-browser DOM 检测（细高元素 / `.current-line` / `.view-ruler` 三路并查）定位真凶——不是缩进参考线，而是 Monaco 基础主题（`vs-dark`/`vs`）继承的**当前行高亮边框盒**：`editor.lineHighlightBorder` 默认 `#282828`，`.current-line` 四周画 2px 边框；光标停长行时右边框恰好落在代码行尾，视觉上即"与代码重叠的竖线"。修复（`index.tsx` 两个自定义主题 colors 显式覆写）：`editor.lineHighlightBorder: '#00000000'`（Monaco 硬编码 2px 宽度无法缩窄，颜色透明即视觉不可见）+ `editor.lineHighlightBackground` 柔和衬底（深色 `#151c42` / 浅色 `#e7ecfa`，对齐 VS Code"以背景标注当前行"惯例）；u9 的 `guides: { indentation: false }` 保留。

**验证**：整页刷新后 DOM 断言——`.current-line` 背景 rgb(21,28,66)/rgb(231,236,250)、边框颜色 rgba(0,0,0,0)（宽度保留 2px 但透明）；全页"细高竖线"元素扫描 0 命中，编辑器容器链边框均为 0px。键盘导航（ArrowDown×7 + End）把光标移至第 9 行长行复现原场景，深色/浅色双主题截图确认行尾无竖线、当前行仅柔和背景；浅色实况复核截图再次确认第 9 行 `* 0.55;` 行尾干净。注意 `defineTheme` 仅在编辑器创建时读取，改动需整页刷新（或重开应用）生效。

### 14.11 u11 无边框窗口 + 导出失败根治：Tauri v2 参数命名陷阱（用户需求，2026-08-28）

**驱动**：用户两条需求——(1) Tauri 桌面端改无边框窗口，"只要红框的内容，外面都不要"（去掉系统标题栏/边框）；(2) MP4 导出在"已完成 300/300 帧"后失败、PNG 导出在"已完成 0/30 帧"即失败，错误均为 `invalid args dataBase64 for command write_binary_file: missing required key dataBase64`。

**根因与修复**：导出失败根因是 **Tauri v2 参数命名规则**——Rust command 的 snake_case 参数（`write_binary_file(path, data_base64)`）会被自动映射为 JS 侧的 camelCase（`dataBase64`），而 `bridge.ts` invoke 时传的是 `{ path, data_base64 }`，key 不匹配导致 IPC 反序列化直接报"missing required key"（MP4 全部帧渲染完才落盘所以最后才炸；PNG 序列帧每帧写文件所以第 0 帧即炸）。修复 `bridge.ts`：`invoke('write_binary_file', { path, dataBase64 })`。无边框窗口三处配合：(1) `lib.rs` 窗口 builder 追加 `.decorations(false)`（Tauri v2 Windows 下 undecorated_resizing 默认开启，边缘拖拽缩放保留）；(2) `capabilities/default.json` 追加 `core:window:allow-minimize / allow-toggle-maximize / allow-close / allow-is-maximized`（`core:default` 已含 `allow-start-dragging` 与 `allow-internal-toggle-maximize`，故拖动区与双击最大化开箱即用）；(3) `App.tsx` 新增 `WindowControls` 组件——`getCurrentWindow()` 的 minimize/toggleMaximize/close，`onResized` 轮询 `isMaximized()` 同步最大化/还原图标，`Show when={hasTauri()}` 保证浏览器端不渲染；顶栏 `header.topbar` 与 `.proj` 挂 `data-tauri-drag-region`（该属性只对被点中的目标元素生效，按钮/chip 交互不受影响）；`styles.css` 新增 `.win-controls/.win-btn` 样式（`align-self: stretch` 撑满 54px 顶栏、关闭钮 hover 红底白字，沿用 `--txt2/--input-bg` 主题变量）。

**验证**：`npm run typecheck`（tsc --noEmit）0 错误；`cargo check` 通过（capabilities 权限标识符经 tauri-build 编译期校验，通过即证明权限名合法）；浏览器回归截图确认顶栏布局完好（品牌区左/transport 中/chip 右）、WindowControls 在浏览器端正确隐藏。无边框观感、拖动区、双击最大化、窗口控制按钮与 MP4/PNG 导出需在 Tauri 桌面端重启应用后实测。

### 14.12 u12 无边框拖动失效 + 外框缝隙归零：drag-region 属性盲区（用户复测反馈，2026-08-28）

**驱动**：用户复测 u11——(1) 无边框窗口完全拖不动；(2) 应用内容（红框）外沿还有一圈缝隙与圆角，希望内容与窗口边缘完全贴紧、"外框"全透明，视觉上像没有外面的框。

**根因与修复**：(1) **`data-tauri-drag-region` 属性只对 mousedown 的目标元素本身生效**（Tauri 注入脚本检查 `e.target.hasAttribute(...)`），而顶栏大部分面积被子元素覆盖——`.transport` 以 `flex:1` 占满中部、品牌区文字、chip 等；点"空白处"时 target 是这些无属性子元素，拖动永不触发（属性方案只在元素自身 padding/gap 上有效，是结构性盲区）。修复：移除该属性，改为顶栏 `header.topbar` 整体 `onMouseDown` 手动调 `getCurrentWindow().startDragging()` + `onDblClick` `toggleMaximize()`，用 `closest('button, input, select, textarea, label, .menu-root, .menu-pop')` 排除交互控件——整栏任意位置（含子元素空白）均可拖动/双击最大化。(2) 外框来自 `.app` 外壳的 `margin: 14px` + `border-radius: 26px` + `box-shadow`（露出 body 渐变背景形成"框"）。修复：`margin: 0; height: 100%; border-radius: 0; box-shadow: none`，内容四边直贴窗口边缘。

**验证**：typecheck 0 错误；浏览器回归截图确认内容四边贴紧窗口边缘、无外框带、顶栏布局与浏览器端控件隐藏逻辑正常。拖动手感与双击最大化需桌面端重启实测。经验：Tauri 拖动区需求优先用手动 `startDragging()` 接管（确定性），`data-tauri-drag-region` 仅适合元素自身面积足够大的场景。

### 14.13 u13 顶栏控件视觉错位：chip 内部标签/值顺序镜像（用户复测反馈，2026-08-28）

**驱动**：用户反馈顶栏右侧一排控件"能对齐吗 感觉视觉上不好"，附截图条：查看 Image▼ / 1×▼ 分辨率 / — □ ×。

**根因与修复**：DOM 探针实测（getBoundingClientRect）显示顶栏所有子元素垂直中心线完全一致（cy=41px）——**不存在垂直错位**；真正的病灶是两个 chip 的内部结构左右镜像：查看 chip 为「标签在前、select 在后」（渲染"查看 Image▼"），分辨率 chip 为「select 在前、标签在后」（渲染"1×▼ 分辨率"）。并排时第二个胶囊的边界被视觉拆散——"1×▼"像一个完整控件、"分辨率"像孤立的漂浮文字，产生"没对齐"的观感。修复：`App.tsx` 中把分辨率 chip 的 `chip-k` 标签移到 `chip-select` 之前，统一为「标签→值」平行结构（渲染"分辨率 1×▼"），与查看 chip 阅读方向一致。其余候选（chip 28px vs win-controls 54px、tl-time 11px 字号）经测量均以 27px 公共中线对齐，属于有意的层级设计，未改动。

**验证**：typecheck 0 错误；浏览器回归截图确认右侧渲染为「查看 Image▼ | 分辨率 1×▼」平行结构。经验：复合控件的"对齐"问题先探针区分垂直/水平两个维度——flex 容器 `align-items:center` 下垂直天然居中，真正的错位常是**同类控件内部结构不平行**（标签/值顺序、图标方向），这种镜像只能靠结构统一而非 CSS 微调解决。另：PowerShell 下 agent-browser 复杂 JS 求值用 `-b`（base64）传参最稳，单引号参数会被进程重建剥掉、`--stdin` 管道可能送达空内容。

### 14.14 u13 追加：左上 logo 与右侧窗口按钮跨容器对齐（用户澄清反馈，2026-08-28）

**驱动**：用户澄清 u13 的"对齐"另有所指——最左边的蓝紫色 logo 与右侧 — □ × 窗口控制钮没有对齐。

**根因与修复**：两个元素分属无关联的容器（`aside.rail` 与 `header.topbar`），没有共享的对齐系统，各自的内边距累积出双维度偏差：(1) **垂直**——logo 中心 = rail padding-top 14 + 16 = **30px**，而顶栏整行中心 = main padding-top 14 + 54/2 = **41px**，logo 高出 11px；(2) **水平边距**——logo 左缘距窗口左缘 **16px**，× 图标右缘却距窗口右缘 **42px**（main 16 + topbar 12 + win-btn 内空隙 14）。修复：`.logo` 加 `margin-top: 11px`（中心 30→41，与顶栏中线重合，rail 后续按钮顺延无副作用）；`.win-controls` 加 `margin-right: -26px` 抵消右侧双层内边距，使 × 图标右缘回到 16px、与 logo 左缘边距精确对称。

**验证**：探针实测 logo cy=41（=topbar cy=41）；浏览器端 `.win-controls` 因 `hasTauri()` 不渲染，采用**向顶栏动态注入克隆节点再测量**的方式拿到真实渲染几何：× 图标右缘距窗口右缘 16px = logo 左缘距窗口左缘 16px，对称成立；typecheck 0 错误；截图确认整行同一中线。经验：跨容器"对齐"类问题本质是**两个独立 padding 链的累积差**，修复手段是计算差值后用 margin 抵消（本例 -26px）；对仅桌面端渲染的组件，可在浏览器端注入同 class 克隆节点验证几何，绕开必须开 Tauri 实测的限制。

### 14.15 u14：桌面端拖动失效真因（ACL 默认集不含 start-dragging）+ 工作区底部左右卡片视觉底缘不齐（2026-08-28）

**驱动**：用户反馈两条——① 桌面端窗口拖动依然失效（u12 修复实测无效）；② 浅色主题截图中底部左右两边的底缘看起来不齐（红线标注高度差）。

**根因与修复**：① u12 时"core:default 已包含 start-dragging"的判断是错的。解析 `gen/schemas/acl-manifests.json` 中 `core:window` 的 `default_permission` 权限清单（28 项，全部为只读查询与 `allow-internal-toggle-maximize`），**不含 `allow-start-dragging`**。这精确解释了症状的选择性：双击最大化可用（`allow-toggle-maximize` 已显式授权且内部切换项在默认集），唯独 `startDragging()` 被权限拒绝且被静默吞掉。修复：`capabilities/default.json` 显式添加 `core:window:allow-start-dragging`；`App.tsx` 的 `topbarStartDrag` 补 `.catch(console.error)`，权限拒绝不再无声。注意 capabilities 是编译期产物，必须重启 `tauri dev`（自动触发 Rust 重编）或重建桌面端才生效。② 探针实测 `.editor` 与 `.preview` DOM 盒完全等高（均到 y=609），但 `.preview` 无背景无边框——右侧真正的可见卡片是内层 `.canvas`（到 y=567 即止），其下 42px 高的 `.preset-strip`（UNIFORM 条）全透明，内容浮在应用底色上，视觉底缘差恰好 42px。修复：`.preview` 挂 `glass` 类获得与 `.editor` 完全一致的卡片外观（背景/1px 边框/16px 圆角/阴影），`.canvas` 圆角归零（由卡片 `overflow: hidden` 裁出上圆角），preset-strip 成为卡内底栏（已有 border-top 分隔）。

**验证**：探针复测 `bottomDiff: 0`，`.preview` 与 `.editor` 的背景、边框、圆角逐项一致；截图确认左右卡片底缘齐平、结构平行（左：tabs+代码+状态栏，右：画布+UNIFORM 条）；typecheck 0 错误。经验：(1) Tauri ACL 的"默认集"不能凭印象断言——schema 文件里存在权限标识符 ≠ `core:default` 实际包含它，必须解析 `acl-manifests.json` 的 `default_permission.permissions` 清单；权限拒绝表现为 Promise reject，静默 catch 会把问题彻底藏住，给所有窗口 API 调用补错误日志是最低成本的诊断保险。(2) "flex 子项 stretch 等高"只保证 DOM 盒等高，不保证**视觉**等高——当卡片 chrome（背景/边框/圆角）挂在内层子元素上时，可见底缘由那个子元素决定；排查视觉对齐必须区分 DOM 盒与可见盒，探针要同时采 getBoundingClientRect 与 computed style。

### 14.16 u15：AI 服务设置 icon 与浅色主题太阳 icon 撞形（2026-08-28）

**驱动**：用户反馈——「AI 服务设置」的 icon 和浅色主体的 icon 是一样的，需要修改。

**根因与修复**：rail 的 AI 服务设置按钮 icon（圆心 r=3.4 + 8 根辐射线 stroke path）与主题切换按钮在浅色态显示的太阳 icon（圆心 r=4 + 8 根辐射线）结构完全同构，仅半径微差，24px 渲染尺寸下视觉无法区分。排查确认旧 icon 全库仅 rail 此一处使用（ChatPanel 设置入口为纯文字「⚙ 设置」，AgentSettingsDialog 模态标题为纯文字），可安全替换。原拟改用四角星 sparkle（AI 惯用符号），但盘点相邻按钮发现「AI 助手」rail-btn 已是双四角星形态，sparkle 方案否决——否则按下葫芦浮起瓢；最终采用机器人头造型：rect(4.8,9.1,14.4×10.8,rx=3) 头部轮廓 + 天线竖线 + 顶部实心圆天线帽 + 双实心圆眼睛 + 横线嘴，与 rail 全部 9 种 icon 形态（logo 四方块/文档折角/四格/三层菱形/滑杆/波形/月牙/太阳/四角星）零撞形。替换期间遭遇并发会话编辑：两次 Read 间行号漂移、SearchReplace 首次报 "search content not found"，HMR 日志证实另一会话正给按钮补 `aria-label`（AgentSettingsDialog.tsx 同期三次 hmr update）；对策为 Grep 重读取含 aria-label 的最新内容作替换锚点，保留并发方改动。

**验证**：typecheck 0 错误；浏览器探针 `aiBtnFound:true / hasRobotRect:true / rectXY:"4.8,9.1" / circles:3 / paths:2`，且 `rootSign:"light"`（正是用户报告撞形的浅色主题场景，themeBtnTitle 为「切换到深色主题」）；原始截图按按钮 bounding rect 本地裁切 4x 放大，太阳/机器人头/四角星三连图标逐个可辨。经验：(1) 替换 icon 前必须盘点目标容器**全部**现有形态——只修当前撞形却引入新撞形等于没修，形态盘点范围是整个视觉容器而非相邻一两个；(2) CSS zoom 放大页面截图会把视口底部元素挤出画面，小图标验证应拍原始尺寸截图后按探针取得的 bounding rect 本地裁切放大（PowerShell System.Drawing + NearestNeighbor）；(3) 多会话并发编辑同一文件时，用内容匹配而非行号定位替换点，且替换前重读、替换时保留并发方新增的属性。

### 14.17 u16：编辑器与预览之间常驻分隔线移除（2026-08-28）

**驱动**：用户反馈——代码和右边显示中间那条线可以不要。

**根因与修复**：那条线不是卡片边框也不是 gap，而是分栏拖拽把手 `.pane-divider` 的 `::after` 在**闲置态常驻**画的 1px `var(--line-strong)` 竖线（上下各内缩 8px）。把手本体是 7px 透明条（`margin: 0 -3px` 骑跨在 workbench 6px gap 上），承担拖拽调宽、方向键微调、双击复位三项功能。修复：`::after` 闲置 `background` 改为 `transparent`（几何属性全保留），`:hover / :focus-visible / body.resizing` 时显形为品牌色 3px 竖条的规则不动——常驻线消失，但把手能力全部保留，悬停即显形提示可拖。两张玻璃卡各自的 1px 边框属 u14 定稿的卡片外观，不在本次范围。

**验证**：HMR 后探针 `getComputedStyle(::after).backgroundColor === rgba(0,0,0,0)`；中间条带（x:640-690）截图 4x 放大确认 gap 干净无线；功能回归：focus 把手后 ArrowLeft 使分栏比例 50→48（editorR 658→629），程序化派发 `dblclick` 复位 50%（顺带验证双击复位路径）。经验：(1) 「去掉分隔线」类需求必须先找到线的真正来源——它可能是功能性元素的装饰态，直接删元素会连功能一起删掉，正确做法是把「闲置可见」降级为「交互时显形」；(2) 分栏比例的连续同向方向键有加速步进（1%、2%、3%…），用按键复原比例不可靠，派发 `dblclick` 是可靠的程序化复位入口。

### 14.18 u17：浅色模式下代码区背景间歇变深色（2026-08-28）

**驱动**：用户反馈——浅色模式，代码部分的背景颜色有时候会变成深色，帮我查找什么原因并解决。

**根因与修复**：探针抓到活体复现（应用 root=light，Monaco 背景 `rgb(11,16,38)`=#0b1026 即深色主题 editor.background）。根因是初始化与同步的时机错位：`EditorPane` 的 `onMount` 里 `monaco.editor.create` **硬编码** `theme: 'shaderlab-dark'`，而主题同步 `createEffect` 只在 `theme()` 信号**变化**时重跑；Solid 中该 effect 注册于 onMount 之前、同一轮 flush 按注册顺序先执行，于是「浅色模式下加载页面」的时序为：全局设浅色 → 创建编辑器以硬编码深色覆盖自身 → 卡在深色。用户切换一次主题会触发 effect 重跑、`setTheme` 应用到已存在编辑器，看似"好了"，下次刷新又复发——这就是"有时候"的真相（精确触发条件：浅色态下刷新页面/编辑器重挂载）。修复：创建参数改为 `theme: theme() === 'dark' ? 'shaderlab-dark' : 'shaderlab-light'`，任何时刻挂载都与信号一致；effect 继续负责后续变化。theme.ts 的持久化/系统跟随层排查无问题。

**验证**：三场景探针——刷新后浅色 `#f0f3fc`（原 bug 场景）、切深色 `#0b1026`、切回浅色 `#f0f3fc`，全部正确。typecheck：本次文件 0 错误（项目现存 2 个错误为并发会话 `RuntimeApi.beginCaptureFromPreview` 重构中间态，位于 PreviewPane.tsx/runtime.ts，非本次引入，未代改以免编辑冲突）。经验：(1) "初始化用常量 + 同步靠变化事件"的结构，在「加载时状态已非默认值」场景必然卡死——初始化参数必须与同步逻辑同源（取自同一信号）；(2) Solid 的 createEffect 先于 onMount（同轮 flush 按注册顺序），靠注册顺序实现"先设全局再创建"是脆弱耦合，正确做法是创建时直接读信号；(3) "有时候"类反馈先抓活体复现再读代码——页面恰处 bug 态时一次探针就能把"时序猜测"变成"实锤"，避免在错误的怀疑点（如 matchMedia 监听、localStorage）上空转。