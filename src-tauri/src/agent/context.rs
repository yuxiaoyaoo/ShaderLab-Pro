use super::extractor::ShaderCode;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionContext {
    #[serde(default)]
    pub confirmed_requirements: Option<String>,
    #[serde(default)]
    pub current_code: Option<ShaderCode>,
    #[serde(default)]
    pub validation_status: ValidationStatus,
    #[serde(default)]
    pub fix_attempts: u32,
    #[serde(default)]
    pub selected_template: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ValidationStatus {
    #[default]
    NotStarted,
    CompileFailed {
        errors: Vec<CompileError>,
    },
    RenderFailed {
        reason: String,
    },
    Passed,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CompileError {
    #[serde(default)]
    pub line: u32,
    #[serde(default)]
    pub column: u32,
    #[serde(default)]
    pub message: String,
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
        parts.push(format!(
            "验证状态: {}",
            match &self.validation_status {
                ValidationStatus::NotStarted => "未验证".to_string(),
                ValidationStatus::CompileFailed { errors } => format!(
                    "编译失败({} 个错误): {}",
                    errors.len(),
                    errors
                        .iter()
                        .take(3)
                        .map(|e| e.message.clone())
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
                ValidationStatus::RenderFailed { reason } => {
                    format!("渲染异常: {}", reason)
                }
                ValidationStatus::Passed => "通过".to_string(),
            }
        ));
        if self.fix_attempts > 0 {
            parts.push(format!("已尝试修复: {} 次", self.fix_attempts));
        }
        if let Some(tpl) = &self.selected_template {
            parts.push(format!("用户选择的模板: {}", tpl));
        }
        parts.join("\n")
    }
}
