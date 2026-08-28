use super::extractor::{Intent, ShaderResponse};
use super::prompts::{
    CODING_INSTRUCTION, DOCUMENTATION_INSTRUCTION, PLANNING_INSTRUCTION, TESTING_INSTRUCTION,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Planning,
    Coding,
    Testing,
    Documentation,
}

impl Default for Phase {
    fn default() -> Self {
        Phase::Planning
    }
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

    pub fn id(&self) -> &'static str {
        match self {
            Phase::Planning => "planning",
            Phase::Coding => "coding",
            Phase::Testing => "testing",
            Phase::Documentation => "documentation",
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

    pub fn next(&self, response: &ShaderResponse) -> Phase {
        match self {
            Phase::Planning => match response.intent {
                Intent::Clarify | Intent::Suggest => Phase::Planning,
                Intent::Generate => Phase::Coding,
                _ => Phase::Planning,
            },
            Phase::Coding => Phase::Testing,
            Phase::Testing => match response.intent {
                Intent::ReportError => Phase::Coding,
                Intent::Complete => Phase::Documentation,
                _ => Phase::Coding,
            },
            Phase::Documentation => Phase::Planning,
        }
    }
}
