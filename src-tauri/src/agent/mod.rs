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
    ErrorFeedback, Intent, ShaderDoc, ShaderResponse, TemplateSuggestion, extract_shader_response,
};
pub use phase::Phase;
pub use pipeline::{MAX_FIX_ATTEMPTS, TurnOutput, ValidationView};
pub use tools::{CompileReport, validate_shader};
