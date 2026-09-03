use crate::agent::extractor::{ProductNotice, ProductParam, ShaderCode};
use crate::agent::pipeline::{self, ValidationView};
use crate::agent::{Intent, Phase, SessionContext, ShaderAgent, ValidationStatus};
use crate::config::{AgentConfig, AgentConfigView, PROVIDER_PRESETS};
use crate::templates::{
    delete_user_entry, list_user_entries, save_user_entry, TemplateEntry, TemplateMeta,
    TemplateRegistry, UserTemplateError, UserTemplateRecord, USER_CATEGORY,
};
use rig_core::message::Message;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager};

pub struct AppState {
    pub agent: RwLock<Option<Arc<ShaderAgent>>>,
    pub config: Mutex<AgentConfig>,
    pub session: Mutex<Session>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            agent: RwLock::new(None),
            config: Mutex::new(AgentConfig::default()),
            session: Mutex::new(Session::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
}

pub struct Session {
    pub phase: Phase,
    pub context: SessionContext,
    pub history: Vec<ChatMessage>,
    pub llm_history: Vec<Message>,
}

impl Session {
    pub fn new() -> Self {
        Session {
            phase: Phase::Planning,
            context: SessionContext::default(),
            history: Vec::new(),
            llm_history: Vec::new(),
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
pub struct IpcError {
    pub code: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, ProductParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_detail: Option<String>,
}

impl IpcError {
    fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            raw_detail: None,
        }
    }

    fn raw(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            raw_detail: Some(detail.into()),
        }
    }

    fn with_param(
        mut self,
        name: impl Into<String>,
        value: impl Into<ProductParam>,
    ) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }
}

impl From<UserTemplateError> for IpcError {
    fn from(error: UserTemplateError) -> Self {
        match error {
            UserTemplateError::NameEmpty => IpcError::new("chat.template-name-empty"),
            UserTemplateError::NameTooLong { max } => {
                IpcError::new("chat.template-name-too-long").with_param("max", max)
            }
            UserTemplateError::CodeEmpty => IpcError::new("chat.template-code-empty"),
            UserTemplateError::CodeTooLarge { max_kb } => {
                IpcError::new("chat.template-code-too-large").with_param("maxKb", max_kb)
            }
            UserTemplateError::EntryMissing { signature } => {
                IpcError::new("chat.template-entry-missing").with_param("signature", signature)
            }
            UserTemplateError::UniformDeclared => {
                IpcError::new("chat.template-uniform-declared")
            }
            UserTemplateError::DirectoryCreate(detail) => {
                IpcError::raw("chat.template-dir-create-failed", detail)
            }
            UserTemplateError::NameInvalid => IpcError::new("chat.template-name-invalid"),
            UserTemplateError::NameCollision => {
                IpcError::new("chat.template-name-collision")
            }
            UserTemplateError::Serialize(detail) => {
                IpcError::raw("chat.template-serialize-failed", detail)
            }
            UserTemplateError::Write(detail) => {
                IpcError::raw("chat.template-write-failed", detail)
            }
            UserTemplateError::SlugInvalid { slug } => {
                IpcError::new("chat.template-slug-invalid").with_param("slug", slug)
            }
            UserTemplateError::NotFound => IpcError::new("chat.template-delete-not-found"),
            UserTemplateError::Delete(detail) => {
                IpcError::raw("chat.template-delete-file-failed", detail)
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub text: String,
    pub notices: Vec<ProductNotice>,
    pub phase_id: String,
    pub phase: String,
    pub intent: String,
    pub parse_ok: bool,
    pub has_code: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_fragment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertex_shader: Option<String>,
    pub suggestions: Vec<crate::agent::TemplateSuggestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation: Option<crate::agent::ShaderDoc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_feedback: Option<crate::agent::ErrorFeedback>,
    /// M1：自动编译验证结果（仅 generate 路径返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<ValidationView>,
}

#[derive(Debug, Serialize)]
pub struct PhaseView {
    pub id: String,
    pub name: String,
}

/// M3：确定性模板选型桥接的返回体（§5.1）
#[derive(Debug, Serialize)]
pub struct TemplateAdoptResponse {
    pub text: String,
    pub notices: Vec<ProductNotice>,
    pub template_name: String,
    pub category: String,
    pub phase_id: String,
    pub phase: String,
    pub intent: String,
    pub has_code: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_fragment: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetAgentConfigArgs {
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, IpcError> {
    app.path()
        .app_data_dir()
        .map_err(|error| IpcError::raw("chat.data-dir-failed", error.to_string()))
}

pub fn init_from_disk(state: &AppState, dir: &Path) {
    let mut config = state.config.lock().unwrap();
    if let Some(saved) = AgentConfig::load(dir) {
        *config = saved;
    }
    let cfg = config.clone();
    drop(config);
    if cfg.is_configured() {
        match ShaderAgent::new(&cfg) {
            Ok(agent) => {
                *state.agent.write().unwrap() = Some(Arc::new(agent));
            }
            Err(e) => log::warn!("AI 代理初始化失败: {}", e),
        }
    }
}

fn rebuild_agent(state: &AppState, cfg: &AgentConfig) -> Result<(), IpcError> {
    let next = if cfg.is_configured() {
        Some(Arc::new(
            ShaderAgent::new(cfg)
                .map_err(|detail| IpcError::raw("chat.agent-init-failed", detail))?,
        ))
    } else {
        None
    };
    *state
        .agent
        .write()
        .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))? = next;
    Ok(())
}

fn config_view(cfg: &AgentConfig) -> AgentConfigView {
    AgentConfigView {
        configured: cfg.is_configured(),
        base_url: cfg.base_url.clone(),
        model: cfg.model.clone(),
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        api_key_hint: cfg.api_key_hint(),
        presets: PROVIDER_PRESETS.to_vec(),
    }
}

/// M5：流式回合的增量事件——经 Tauri Channel 推送给前端打字气泡。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    Delta { text: String },
    Reset,
}

/// send_turn_streaming 的模型轮重试哨兵：后端截获转译为 Reset 事件，
/// 前端据此清空气泡重新累积。
const STREAM_RESET_SENTINEL: &str = "\u{1}[reset]";

/// 观察者 RAII 守卫：任何退出路径（含 `?` 提前出错）都保证摘除观察者，
/// 防止后续普通轮被误导入流式分发。
struct ObserverGuard<'a>(&'a ShaderAgent);
impl Drop for ObserverGuard<'_> {
    fn drop(&mut self) {
        self.0.set_progress_observer(None);
    }
}

#[tauri::command]
pub async fn chat(
    message: String,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<ChatResponse, IpcError> {
    execute_chat_turn(message, &state, &app, None).await
}

/// M5：与 chat 共用同一套编排，仅多挂一个进度观察者——
/// LLM 文本增量实时经 Channel 直播；最终返回完整 ChatResponse，
/// 前端在完成信号到达后用富结构整包替换直播气泡。
#[tauri::command]
pub async fn chat_stream(
    message: String,
    on_event: tauri::ipc::Channel<ChatStreamEvent>,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<ChatResponse, IpcError> {
    execute_chat_turn(message, &state, &app, Some(on_event)).await
}

async fn execute_chat_turn(
    message: String,
    state: &tauri::State<'_, AppState>,
    app: &AppHandle,
    stream_channel: Option<tauri::ipc::Channel<ChatStreamEvent>>,
) -> Result<ChatResponse, IpcError> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(IpcError::new("chat.message-empty"));
    }

    let agent = state
        .agent
        .read()
        .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?
        .clone();
    let agent = match agent {
        Some(agent) => agent,
        None => return Err(IpcError::new("chat.ai-not-configured")),
    };

    let (current_phase, context_snapshot, history_snapshot) = {
        let session = state
            .session
            .lock()
            .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?;
        (
            session.phase,
            session.context.clone(),
            session.llm_history.clone(),
        )
    };

    // M5：主回合（含校验修复轮）挂载流式观察者，增量实时转发；
    // 守卫确保 process_turn 提前失败也会摘除；观察者仅捕获 Channel 克隆。
    let _observer_guard = stream_channel.map(|ch| {
        agent.set_progress_observer(Some(Box::new(move |delta| {
            if delta == STREAM_RESET_SENTINEL {
                let _ = ch.send(ChatStreamEvent::Reset);
            } else {
                let _ = ch.send(ChatStreamEvent::Delta {
                    text: delta.to_string(),
                });
            }
        })));
        ObserverGuard(&agent)
    });

    let mut working_history = history_snapshot;
    let validator = pipeline::default_validator();
    let renderer = pipeline::default_renderer();
    let pipeline::TurnOutput {
        mut response,
        parse_ok,
        reply_display,
        mut notices,
        final_phase,
        validation,
        final_code,
    } = pipeline::process_turn(
        &agent,
        current_phase,
        &message,
        &context_snapshot,
        &mut working_history,
        &validator,
        &renderer,
    )
    .await
    .map_err(|detail| IpcError::raw("chat.request-failed", detail))?;

    // M5：文档轮输出为结构化 JSON，不宜逐字直播——先摘除观察者再衔接。
    drop(_observer_guard);

    // —— M4：验证通过 / Complete 双路自动衔接文档轮（§十 数据流）——
    // 门控三条件：本轮未自带文档 + 非用户主动处于文档阶段 + 阶段确实推进到了 Documentation；
    // 产物并入同一条回复，失败仅记录日志降级，不阻断主流程。
    if response.documentation.is_none()
        && current_phase != Phase::Documentation
        && final_phase == Phase::Documentation
    {
        // Complete 路径 response.code 为 None，回退到会话已提交的当前代码。
        // 锁不可跨 await：先克隆再释放守卫。
        let doc_source: Option<ShaderCode> = match final_code.clone() {
            Some(code) => Some(code),
            None => {
                let session = state.session.lock().map_err(|error| {
                    IpcError::raw("chat.state-unavailable", error.to_string())
                })?;
                session.context.current_code.clone()
            }
        };
        match doc_source {
            Some(code) => {
                match pipeline::document_turn(
                    &agent,
                    &code,
                    &context_snapshot,
                    &mut working_history,
                )
                .await
                {
                    Ok(Some(doc)) => {
                        log::info!(
                            "自动文档轮完成：算法说明 {} 字、参数 {} 项",
                            doc.algorithm_explanation.chars().count(),
                            doc.parameters.len()
                        );
                        response.documentation = Some(doc);
                        notices.push(ProductNotice::new("chat.notice.auto-documentation"));
                    }
                    Ok(None) => log::warn!("自动文档轮未产出有效文档，已降级跳过"),
                    Err(e) => log::warn!("自动文档轮失败（不阻断主流程）：{e}"),
                }
            }
            None => log::warn!("阶段推进到文档但无可用代码，跳过自动文档轮"),
        }
    }

    let has_code = final_code.is_some();
    let code_payload = final_code
        .as_ref()
        .map(|c| serde_json::json!({ "fragment": c.fragment, "vertex": c.vertex }));

    {
        let mut session = state
            .session
            .lock()
            .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?;
        session
            .context
            .confirmed_requirements
            .get_or_insert_with(|| message.clone());
        if matches!(response.intent, Intent::Generate) && final_code.is_some() {
            session.context.current_code = final_code.clone();
            if validation.is_none() {
                session.context.validation_status = ValidationStatus::NotStarted;
            }
        }
        match &validation {
            Some(view) => {
                session.context.validation_status = pipeline::validation_status_for(view);
                session.context.fix_attempts = pipeline::context_fix_attempts_for(view);
            }
            None => {
                if matches!(response.intent, Intent::ReportError) {
                    session.context.fix_attempts += 1;
                    let fb = response.error_feedback.clone().unwrap_or_default();
                    session.context.validation_status = if fb.phase == "render" {
                        ValidationStatus::RenderFailed {
                            reason: fb.message.clone(),
                        }
                    } else {
                        ValidationStatus::CompileFailed { errors: vec![] }
                    };
                }
                if matches!(response.intent, Intent::Complete) {
                    session.context.validation_status = ValidationStatus::Passed;
                }
            }
        }
        session.phase = final_phase;
        session.history.push(ChatMessage {
            role: "user".to_string(),
            text: message.clone(),
        });
        session.history.push(ChatMessage {
            role: "assistant".to_string(),
            text: reply_display.clone(),
        });
        session.llm_history = working_history;
    }

    if let Some(payload) = code_payload {
        let _ = app.emit("shader-updated", payload);
    }
    if !response.suggestions.is_empty() {
        let _ = app.emit("templates-suggested", &response.suggestions);
    }

    Ok(ChatResponse {
        text: reply_display,
        notices,
        phase_id: final_phase.id().to_string(),
        phase: final_phase.name().to_string(),
        intent: response.intent.id().to_string(),
        parse_ok,
        has_code,
        code_fragment: final_code.as_ref().map(|c| c.fragment.clone()),
        vertex_shader: final_code.as_ref().and_then(|c| c.vertex.clone()),
        suggestions: response.suggestions,
        clarification: response.clarification,
        documentation: response.documentation,
        error_feedback: response.error_feedback,
        validation,
    })
}

/// M3：确定性选型桥接——前端「用此方案」直接命中，不走 LLM 轮次；
/// 模板代码原样落库为当前代码，会话标记 selected_template 并推进到实现阶段。
#[tauri::command]
pub async fn select_template(
    name: String,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<TemplateAdoptResponse, IpcError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(IpcError::new("chat.template-name-empty"));
    }
    let dir = data_dir(&app)?;
    let user_pool = list_user_entries(&dir);
    let entry = TemplateRegistry::global()
        .resolve_with_user(&name, &user_pool)
        .ok_or_else(|| {
            IpcError::new("chat.template-not-found").with_param("name", name.as_str())
        })?;

    let adopted = entry.name.clone();
    let category = entry.category.clone();
    let notice_code = if category == USER_CATEGORY {
        "chat.notice.template-adopted-user"
    } else {
        "chat.notice.template-adopted-builtin"
    };
    let notices = vec![ProductNotice::new(notice_code).with_param("name", adopted.as_str())];

    let code = ShaderCode {
        fragment: entry.code.clone(),
        ..ShaderCode::default()
    };
    let code_payload = serde_json::json!({
        "fragment": code.fragment,
        "vertex": code.vertex,
    });
    let fragment_for_response = code.fragment.clone();

    {
        let mut session = state
            .session
            .lock()
            .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?;
        session.context.selected_template = Some(adopted.clone());
        session
            .context
            .confirmed_requirements
            .get_or_insert_with(|| format!("采用模板「{}」", adopted));
        session.context.current_code = Some(code);
        session.context.validation_status = ValidationStatus::NotStarted;
        session.phase = Phase::Coding;
        session.history.push(ChatMessage {
            role: "user".to_string(),
            text: format!("我选择方案「{}」。", adopted),
        });
        session.history.push(ChatMessage {
            role: "assistant".to_string(),
            text: String::new(),
        });
    }

    let _ = app.emit("shader-updated", code_payload);

    Ok(TemplateAdoptResponse {
        text: String::new(),
        notices,
        template_name: adopted,
        category,
        phase_id: Phase::Coding.id().to_string(),
        phase: Phase::Coding.name().to_string(),
        intent: "generate".to_string(),
        has_code: true,
        code_fragment: Some(fragment_for_response),
    })
}

// ==================== M6b：自定义模板 CRUD ====================

#[derive(Debug, Serialize)]
pub struct UserTemplateView {
    pub slug: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub tags: Vec<String>,
    pub difficulty: String,
    pub code: String,
}

impl UserTemplateView {
    fn from_entry(entry: TemplateEntry) -> Self {
        UserTemplateView {
            slug: entry.slug,
            name: entry.name,
            category: entry.category,
            description: entry.description,
            tags: entry.tags,
            difficulty: entry.difficulty,
            code: entry.code,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SaveUserTemplateArgs {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub difficulty: String,
    #[serde(default)]
    pub uniforms: Vec<String>,
    pub code: String,
}

/// 保存用户模板（同名覆盖 = 更新）。
/// 落盘前用 glslangValidator 做编译预检并回映行号，工具缺失时优雅放行。
#[tauri::command]
pub async fn save_user_template(
    args: SaveUserTemplateArgs,
    app: AppHandle,
) -> Result<UserTemplateView, IpcError> {
    if args.name.trim().is_empty() {
        return Err(IpcError::new("chat.template-name-empty"));
    }
    let report = crate::agent::tools::compile_glsl::validate_shader(&args.code, None);
    if !report.errors.is_empty() {
        let detail = report
            .errors
            .iter()
            .map(|error| format!("{}:{}: {}", error.line, error.column, error.message))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(IpcError::raw("chat.template-preflight-failed", detail));
    }
    let dir = data_dir(&app)?;
    let entry = save_user_entry(
        &dir,
        UserTemplateRecord {
            name: args.name,
            description: args.description,
            tags: args.tags,
            difficulty: args.difficulty,
            uniforms: args.uniforms,
            code: args.code,
        },
    )
    .map_err(IpcError::from)?;
    let _ = app.emit("user-templates-changed", ());
    Ok(UserTemplateView::from_entry(entry))
}

/// 列出全部用户模板（每次直读盘，无缓存）
#[tauri::command]
pub async fn list_user_templates(
    app: AppHandle,
) -> Result<Vec<UserTemplateView>, IpcError> {
    let dir = data_dir(&app)?;
    Ok(list_user_entries(&dir)
        .into_iter()
        .map(UserTemplateView::from_entry)
        .collect())
}

/// 删除指定 slug 的用户模板
#[tauri::command]
pub async fn delete_user_template(slug: String, app: AppHandle) -> Result<(), IpcError> {
    let dir = data_dir(&app)?;
    delete_user_entry(&dir, &slug).map_err(IpcError::from)?;
    let _ = app.emit("user-templates-changed", ());
    Ok(())
}

// ==================== 内置特效模板（30 个 .glsl，供模板库分组浏览）====================

/// 列出全部内置特效模板的元数据（不含源码）
#[tauri::command]
pub async fn list_builtin_templates() -> Result<Vec<TemplateMeta>, IpcError> {
    Ok(TemplateRegistry::global().list_meta())
}

/// 按 slug 取内置模板源码（访问失败返回 IpcError -> chat.template-not-found）
#[tauri::command]
pub async fn get_builtin_template_source(slug: String) -> Result<String, IpcError> {
    TemplateRegistry::global()
        .source_by_slug(&slug)
        .ok_or_else(|| IpcError::new("chat.template-not-found"))
}

#[tauri::command]
pub async fn get_phase(state: tauri::State<'_, AppState>) -> Result<PhaseView, IpcError> {
    let session = state
        .session
        .lock()
        .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?;
    Ok(PhaseView {
        id: session.phase.id().to_string(),
        name: session.phase.name().to_string(),
    })
}

#[tauri::command]
pub async fn reset_session(state: tauri::State<'_, AppState>) -> Result<(), IpcError> {
    let mut session = state
        .session
        .lock()
        .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?;
    *session = Session::new();
    Ok(())
}

#[tauri::command]
pub async fn get_agent_config(
    state: tauri::State<'_, AppState>,
) -> Result<AgentConfigView, IpcError> {
    let cfg = state
        .config
        .lock()
        .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?
        .clone();
    Ok(config_view(&cfg))
}

#[tauri::command]
pub async fn set_agent_config(
    args: SetAgentConfigArgs,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<AgentConfigView, IpcError> {
    let dir = data_dir(&app)?;
    let merged = {
        let mut cfg = state
            .config
            .lock()
            .map_err(|error| IpcError::raw("chat.state-unavailable", error.to_string()))?;
        if let Some(value) = args.api_key {
            cfg.api_key = value.trim().to_string();
        }
        if let Some(value) = args.base_url {
            let value = value.trim().to_string();
            if !value.is_empty() {
                cfg.base_url = value;
            }
        }
        if let Some(value) = args.model {
            cfg.model = value.trim().to_string();
        }
        if let Some(value) = args.temperature {
            cfg.temperature = value.clamp(0.0, 2.0);
        }
        if let Some(value) = args.max_tokens {
            cfg.max_tokens = value.clamp(64, 32768);
        }
        cfg.save(&dir)
            .map_err(|detail| IpcError::raw("chat.config-save-failed", detail))?;
        cfg.clone()
    };
    rebuild_agent(&state, &merged)?;
    Ok(config_view(&merged))
}
