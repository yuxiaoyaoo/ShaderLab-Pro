use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Locale-neutral parameter values shared by IPC errors and product notices.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ProductParam {
    String(String),
    Integer(i64),
    Decimal(f64),
}

impl From<String> for ProductParam {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for ProductParam {
    fn from(value: &str) -> Self {
        Self::String(value.to_string())
    }
}

impl From<usize> for ProductParam {
    fn from(value: usize) -> Self {
        Self::Integer(value as i64)
    }
}

impl From<u32> for ProductParam {
    fn from(value: u32) -> Self {
        Self::Integer(value as i64)
    }
}

impl From<f32> for ProductParam {
    fn from(value: f32) -> Self {
        Self::Decimal(value as f64)
    }
}

/// Stable product-owned notice. Rendering is intentionally deferred to the UI locale.
#[derive(Debug, Clone, Serialize)]
pub struct ProductNotice {
    pub code: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, ProductParam>,
}

impl ProductNotice {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn with_param(
        mut self,
        name: impl Into<String>,
        value: impl Into<ProductParam>,
    ) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }
}

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
    /// Returns only model-authored text. Product-owned summaries are emitted separately as
    /// ProductNotice descriptors and localized by the frontend.
    pub fn display_text(&self) -> String {
        match self.intent {
            Intent::Clarify => self.clarification.clone().unwrap_or_default(),
            Intent::ReportError => {
                let fb = self.error_feedback.as_ref();
                fb.into_iter()
                    .flat_map(|feedback| [&feedback.message, &feedback.suggestion])
                    .filter(|part| !part.trim().is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            Intent::Suggest | Intent::Generate | Intent::Document | Intent::Complete => {
                String::new()
            }
        }
    }

    pub fn product_notices(&self) -> Vec<ProductNotice> {
        match self.intent {
            Intent::Clarify if self.clarification.as_deref().unwrap_or("").trim().is_empty() => {
                vec![ProductNotice::new("chat.notice.clarification-required")]
            }
            Intent::Suggest if self.suggestions.is_empty() => {
                vec![ProductNotice::new("chat.notice.suggestions-empty")]
            }
            Intent::Suggest => vec![ProductNotice::new("chat.notice.suggestions-available")
                .with_param("count", self.suggestions.len())],
            Intent::Generate if self.code.is_some() => {
                vec![ProductNotice::new("chat.notice.code-generated").with_param(
                    "lines",
                    self.code
                        .as_ref()
                        .map(|code| code.fragment.lines().count())
                        .unwrap_or(0),
                )]
            }
            Intent::Generate => Vec::new(),
            Intent::Document => vec![ProductNotice::new("chat.notice.documentation-ready")],
            Intent::Complete => vec![ProductNotice::new("chat.notice.complete")],
            Intent::Clarify | Intent::ReportError => Vec::new(),
        }
    }
}
