use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Clarify,
    Suggest,
    Generate,
    ReportError,
    Document,
    Complete,
}

impl Default for Intent {
    fn default() -> Self {
        Intent::Clarify
    }
}

impl Intent {
    pub fn parse(raw: &str) -> Option<Intent> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "clarify" => Some(Intent::Clarify),
            "suggest" => Some(Intent::Suggest),
            "generate" => Some(Intent::Generate),
            "report_error" | "reporterror" => Some(Intent::ReportError),
            "document" => Some(Intent::Document),
            "complete" => Some(Intent::Complete),
            _ => None,
        }
    }

    pub fn id(&self) -> &'static str {
        match self {
            Intent::Clarify => "clarify",
            Intent::Suggest => "suggest",
            Intent::Generate => "generate",
            Intent::ReportError => "report_error",
            Intent::Document => "document",
            Intent::Complete => "complete",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ShaderResponse {
    #[serde(default)]
    pub intent: Intent,
    #[serde(default)]
    pub code: Option<ShaderCode>,
    #[serde(default)]
    pub suggestions: Vec<TemplateSuggestion>,
    #[serde(default)]
    pub clarification: Option<String>,
    #[serde(default)]
    pub documentation: Option<ShaderDoc>,
    #[serde(default)]
    pub error_feedback: Option<ErrorFeedback>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShaderCode {
    #[serde(default)]
    pub fragment: String,
    #[serde(default)]
    pub vertex: Option<String>,
    #[serde(default)]
    pub uniforms: Vec<UniformDecl>,
    #[serde(default)]
    pub shadertoy_inputs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UniformDecl {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub glsl_type: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TemplateSuggestion {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub preview_thumbnail: String,
    #[serde(default)]
    pub code: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShaderDoc {
    #[serde(default)]
    pub inline_comments: String,
    #[serde(default)]
    pub algorithm_explanation: String,
    #[serde(default)]
    pub parameters: Vec<ParamDoc>,
    #[serde(default)]
    pub performance_notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParamDoc {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub range: String,
    #[serde(default)]
    pub effect: String,
    #[serde(default)]
    pub default: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ErrorFeedback {
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub suggestion: String,
}

#[derive(Debug, Deserialize)]
struct RawResponse {
    #[serde(default)]
    intent: serde_json::Value,
    #[serde(default)]
    code: Option<ShaderCode>,
    #[serde(default)]
    suggestions: Vec<TemplateSuggestion>,
    #[serde(default)]
    clarification: Option<String>,
    #[serde(default)]
    documentation: Option<ShaderDoc>,
    #[serde(default)]
    error_feedback: Option<ErrorFeedback>,
}

pub fn extract_shader_response(text: &str) -> (ShaderResponse, bool) {
    if let Some(json_str) = find_json_object(text) {
        if let Ok(raw) = serde_json::from_str::<RawResponse>(json_str) {
            let intent = raw
                .intent
                .as_str()
                .and_then(Intent::parse)
                .unwrap_or_default();
            let resp = ShaderResponse {
                intent,
                code: raw.code.filter(|c| !c.fragment.trim().is_empty()),
                suggestions: raw.suggestions,
                clarification: raw.clarification,
                documentation: raw.documentation,
                error_feedback: raw.error_feedback,
            };
            return (resp, true);
        }
    }
    (
        ShaderResponse {
            intent: Intent::Clarify,
            clarification: Some(text.trim().to_string()),
            ..Default::default()
        },
        false,
    )
}

fn find_json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    for (start, ch) in text.char_indices() {
        if ch != '{' {
            continue;
        }
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        for (i, &b) in bytes[start..].iter().enumerate() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    in_string = false;
                }
                continue;
            }
            match b {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&text[start..=start + i]);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

impl ShaderResponse {
    pub fn display_text(&self) -> String {
        match self.intent {
            Intent::Clarify => self
                .clarification
                .clone()
                .unwrap_or_else(|| "需要更多信息，请补充描述。".to_string()),
            Intent::Suggest => {
                if self.suggestions.is_empty() {
                    return "我有一些方案建议。".to_string();
                }
                let mut out = String::from("为你找到以下方案：\n");
                for (i, s) in self.suggestions.iter().enumerate() {
                    out.push_str(&format!("{}. {} —— {}\n", i + 1, s.name, s.description));
                }
                out.push_str("\n告诉我想选哪个，或者直接说\"你来决定\"。");
                out
            }
            Intent::Generate => {
                let lines = self
                    .code
                    .as_ref()
                    .map(|c| c.fragment.lines().count())
                    .unwrap_or(0);
                format!(
                    "已生成 {} 行 shader 代码，已推送到预览面板。\n你可以试试调整颜色、速度或密度。",
                    lines
                )
            }
            Intent::ReportError => {
                let fb = self.error_feedback.clone().unwrap_or_default();
                format!(
                    "[{:?}] {}\n修复建议：{}",
                    fb.phase, fb.message, fb.suggestion
                )
            }
            Intent::Document => self
                .documentation
                .as_ref()
                .map(|d| d.algorithm_explanation.clone())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "文档已生成。".to_string()),
            Intent::Complete => "测试通过！可以进入文档阶段，或继续调整效果。".to_string(),
        }
    }
}
