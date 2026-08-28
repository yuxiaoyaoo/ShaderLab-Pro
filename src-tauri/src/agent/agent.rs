use super::context::SessionContext;
use super::phase::Phase;
use super::prompts::SHADERLAB_SYSTEM_PROMPT;
use crate::config::AgentConfig;
use futures_util::StreamExt;
use rig_agent::agent::{MultiTurnStreamItem, Text};
use rig_agent::completion::Chat;
use rig_agent::prelude::CompletionClient;
use rig_agent::streaming::{StreamedAssistantContent, StreamingChat};
use rig_agent::{Agent, AgentBuilder};
use rig_core::client::BearerAuth;
use rig_core::message::Message;
use rig_core::providers::openai;
use std::sync::Mutex;

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

type LlmAgent = Agent;

/// M5：LLM 输出进度回调——每收到一段增量文本即触发一次，
/// 全局单观察者即可（桌面端同时至多一轮对话在途）。
pub type ProgressObserver = Box<dyn Fn(&str) + Send + Sync>;

pub struct ShaderAgent {
    inner: LlmAgent,
    progress: Mutex<Option<ProgressObserver>>,
}

impl ShaderAgent {
    pub fn new(config: &AgentConfig) -> Result<Self, String> {
        let api_key = config.api_key.trim();
        if api_key.is_empty() {
            return Err("API Key 未配置".to_string());
        }
        let model_name = config.model.trim();
        if model_name.is_empty() {
            return Err("模型名称未配置".to_string());
        }
        let mut builder =
            openai::Client::builder().api_key::<BearerAuth>(api_key.to_string());
        let base_url = config.base_url.trim();
        if !base_url.is_empty() && !base_url.eq_ignore_ascii_case(DEFAULT_OPENAI_BASE_URL) {
            builder = builder.base_url(base_url);
        }
        let client = builder
            .build()
            .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?
            .completions_api();
        let model = client.completion_model(model_name.to_string());
        let inner = AgentBuilder::new(model)
            .preamble(SHADERLAB_SYSTEM_PROMPT)
            .temperature(config.temperature as f64)
            .max_tokens(config.max_tokens as u64)
            .build();
        Ok(ShaderAgent {
            inner,
            progress: Mutex::new(None),
        })
    }

    /// M5：注册/清除流式进度观察者。有观察者时 send_turn 改走 SSE 流式
    /// 并逐段转发增量；无观察者时维持原有阻塞请求（离线测试/抓包均不变）。
    pub fn set_progress_observer(&self, observer: Option<ProgressObserver>) {
        *self.progress.lock().unwrap() = observer;
    }

    fn full_prompt_for(phase: Phase, user_message: &str, context: &SessionContext) -> String {
        format!(
            "[当前阶段: {}]\n{}\n\n[会话上下文]\n{}\n\n[用户消息]\n{}",
            phase.name(),
            phase.instruction(),
            context.serialize(),
            user_message,
        )
    }

    async fn send_turn_streaming(
        &self,
        full_prompt: String,
        history: &mut Vec<Message>,
    ) -> Result<String, String> {
        // StreamingPromptRequest 实现 IntoFuture<Output = StreamingResult>，直接 await 即得流。
        // 克隆一份供 FinalResponse 后写回历史（等价阻塞 chat() 的语义）。
        let mut stream = self
            .inner
            .stream_chat(full_prompt.clone(), history.iter().cloned())
            .await;
        let mut accumulated = String::new();
        // 模型轮被供应商打回重试时，先前已发出的增量必须作废：通知前端清屏重来。
        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(
                    Text { text, .. },
                ))) => {
                    accumulated.push_str(&text);
                    if let Some(cb) = self.progress.lock().unwrap().as_ref() {
                        cb(&text);
                    }
                }
                Ok(MultiTurnStreamItem::ModelTurnRetried { .. }) => {
                    accumulated.clear();
                    if let Some(cb) = self.progress.lock().unwrap().as_ref() {
                        cb("\u{1}[reset]");
                    }
                }
                Ok(MultiTurnStreamItem::FinalResponse(res)) => {
                    // 对齐阻塞 chat()：把本轮提示与最终回复写回历史，否则下轮失忆。
                    // 本代理未配置工具，一回合恒为一对消息。
                    history.push(Message::user(full_prompt.clone()));
                    history.push(Message::assistant(res.output.clone()));
                    return Ok(res.output);
                }
                Err(e) => return Err(format!("LLM 调用失败: {}", e)),
                _ => {}
            }
        }
        // 理论上 FinalResponse 必达；流意外收尾时以累积文本兜底，保证与已展示内容一致。
        history.push(Message::user(full_prompt.clone()));
        let fallback = accumulated;
        history.push(Message::assistant(fallback.clone()));
        Ok(fallback)
    }

    pub async fn send_turn(
        &self,
        phase: Phase,
        user_message: &str,
        context: &SessionContext,
        history: &mut Vec<Message>,
    ) -> Result<String, String> {
        let full_prompt = Self::full_prompt_for(phase, user_message, context);
        if self.progress.lock().unwrap().is_some() {
            return self.send_turn_streaming(full_prompt, history).await;
        }
        self.inner
            .chat(full_prompt, history)
            .await
            .map_err(|e| format!("LLM 调用失败: {}", e))
    }
}
