pub mod agent;
pub mod context;
pub mod extractor;
pub mod phase;
pub mod pipeline;
pub mod prompts;
pub mod tools;

pub use agent::ShaderAgent;
pub use context::{SessionContext, ValidationStatus};
pub use extractor::{
    extract_shader_response, ErrorFeedback, Intent, ShaderDoc, ShaderResponse, TemplateSuggestion,
};
pub use phase::Phase;
pub use pipeline::{TurnOutput, ValidationView, MAX_FIX_ATTEMPTS};
pub use tools::{validate_shader, CompileReport};
