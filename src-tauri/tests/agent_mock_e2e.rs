use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use app_lib::agent::{
    Intent, Phase, ShaderAgent, ShaderResponse, SessionContext, extract_shader_response,
};
use app_lib::agent::extractor::ShaderCode;
use app_lib::agent::context::CompileError;
use app_lib::agent::pipeline;
use app_lib::agent::tools::RenderReport;
use app_lib::agent::{CompileReport, MAX_FIX_ATTEMPTS};
use app_lib::config::AgentConfig;
use rig_core::message::Message;

const VALID_KEY: &str = "test-key";

/// 「正确」的 generate 响应体：uSpeed 已声明且被正确引用
const GEN_GOOD: &str = r#"{"intent":"generate","code":{"fragment":"void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    vec2 uv = fragCoord / iResolution.xy;\n    float wave = sin(uv.x * 20.0 + iTime * uSpeed);\n    fragColor = vec4(0.0, 0.3 + 0.2 * wave, 1.0, 1.0);\n}","vertex":null,"uniforms":[{"name":"uSpeed","glsl_type":"float","description":"speed"}],"shadertoy_inputs":["iTime","iResolution"]}}"#;

/// 「带编译缺陷」的 generate 响应体：误拼 uSpeeed 且未在 uniforms 中声明
const GEN_BROKEN: &str = r#"{"intent":"generate","code":{"fragment":"void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    vec2 uv = fragCoord / iResolution.xy;\n    float wave = sin(uv.x * 20.0 + iTime * uSpeeed);\n    fragColor = vec4(0.0, 0.3 + 0.2 * wave, 1.0, 1.0);\n}","vertex":null,"uniforms":[{"name":"uSpeed","glsl_type":"float","description":"speed"}],"shadertoy_inputs":["iTime","iResolution"]}}"#;

/// 修复轮「AI 放弃」响应体：report_error 携带原因与替代方案
const FIX_SURRENDER: &str = r#"{"intent":"report_error","error_feedback":{"phase":"compile","message":"多轮尝试后仍存在未声明标识符，该效果依赖外部纹理数据","line":null,"suggestion":"建议改用纯数学噪声替代纹理采样"}}"#;

/// M4 文档轮主剧本：四字段结构化产出，inline_comments 填充以覆盖前端新渲染位
const DOC_M4: &str = r#"{"intent":"document","documentation":{"inline_comments":"// —— 波形区：正弦驱动颜色振荡\nfloat wave = sin(uv.x * 20.0 + iTime * uSpeed);","algorithm_explanation":"使用正弦波扰动采样坐标，形成随时间流动的水波纹条纹","parameters":[{"name":"uSpeed","range":"0.0~5.0","effect":"波动速度","default":"1.0"}],"performance_notes":"单次 sin 采样，性能开销极低"}}"#;

fn spawn_mock() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("mock bind");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut s) => handle_conn(&mut s),
                Err(_) => break,
            }
        }
    });
    port
}

fn find_slice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// M3「抓包」通道：mock 服务端把每次收到的完整提示词存档，供测试侧断言注入内容。
/// 写入发生在响应之前，因此客户端收到响应时对应条目必然已落盘。
fn captures() -> &'static std::sync::Mutex<Vec<String>> {
    static C: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn last_captured(sentinel: &str) -> String {
    captures()
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|p| p.contains(sentinel))
        .cloned()
        .unwrap_or_else(|| panic!("应能抓到含哨兵 {sentinel} 的提示词"))
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end;
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = find_slice(&buf, b"\r\n\r\n") {
            header_end = p + 4;
            break;
        }
    }
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
    let mut content_len = 0usize;
    for line in headers.lines() {
        if let Some(v) = line.strip_prefix("content-length:") {
            content_len = v.trim().parse().unwrap_or(0);
        }
    }
    let end = header_end + content_len;
    while buf.len() < end && buf.len() >= header_end {
        let want = end.min(header_end + content_len);
        if buf.len() >= want {
            break;
        }
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body_end = header_end + content_len.min(buf.len().saturating_sub(header_end));
    let body = String::from_utf8_lossy(&buf[header_end..body_end]).to_string();
    Some((headers, body))
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        _ => "Error",
    };
    let payload = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

/// 同步/流式两路共用的「围栏回复」正文：内部剧本统一包上 markdown 围栏
fn fenced_reply(prompt: &str) -> String {
    let inner: String = if let Some(v) = m3_dynamic_inner(prompt) {
        v
    } else {
        legacy_static_inner(prompt).to_string()
    };
    format!("好的，以下是结构化响应：\n\n```json\n{}\n```\n", inner)
}

fn scripted_content(prompt: &str) -> String {
    let fenced = fenced_reply(prompt);
    serde_json::json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": 1_700_000_000u64,
        "model": "mock-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": fenced },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20 }
    })
    .to_string()
}

/// 把完整文本按字符切成 target 段（字符边界安全，UTF-8 友好）
fn split_chunks(text: &str, target: usize) -> Vec<String> {
    if text.is_empty() || target == 0 {
        return vec![text.to_string()];
    }
    let chars: Vec<char> = text.chars().collect();
    let step = ((chars.len() + target - 1) / target).max(1);
    chars.chunks(step).map(|c| c.iter().collect()).collect()
}

/// M5 流式剧本：与同步剧本同源的回复文本被拆成若干 chat.completion.chunk 帧，
/// 以 finish_reason=stop 收束并附 usage 尾帧；最后必须有 data: [DONE]——
/// rig 在缺少 [DONE] 时不会合成终止记录，FinalResponse 将无从产生。
fn scripted_sse_body(prompt: &str) -> String {
    let full = fenced_reply(prompt);
    let mut body = String::new();
    for piece in split_chunks(&full, 6) {
        body.push_str(&format!(
            "data: {}\n\n",
            serde_json::json!({
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "created": 1_700_000_000u64,
                "model": "mock-model",
                "choices": [{
                    "index": 0,
                    "delta": { "content": piece },
                    "finish_reason": null
                }]
            })
        ));
    }
    body.push_str(&format!(
        "data: {}\n\n",
        serde_json::json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "model": "mock-model",
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
        })
    ));
    body.push_str(&format!(
        "data: {}\n\n",
        serde_json::json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "model": "mock-model",
            "choices": [],
            "usage": { "prompt_tokens": 10, "completion_tokens": 12, "total_tokens": 22 }
        })
    ));
    body.push_str("data: [DONE]\n\n");
    body
}

fn respond_sse(stream: &mut TcpStream, body: &str) {
    // rig 的 SSE 传输层不校验 Content-Type，定长回包即可（无需 chunked 编码）
    let payload = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

/// M3 动态剧本：命中哨兵时用注册表数据现拼响应体（多行 GLSL 经 json! 宏自动转义）
fn m3_dynamic_inner(prompt: &str) -> Option<String> {
    if prompt.contains("[AI_TEST_M3_SUGGEST]") {
        // 剧本①：规划轮「建议」——直接引用检索第一名（星空粒子），验证 LLM 能原样回带模板
        let hit = app_lib::templates::TemplateRegistry::global()
            .search("星空", None, 1)
            .into_iter()
            .next();
        Some(match hit {
            Some(m) => serde_json::json!({
                "intent": "suggest",
                "suggestions": [{
                    "name": m.name,
                    "description": m.description,
                    "category": m.category,
                    "preview_thumbnail": "",
                    "code": m.code,
                }]
            })
            .to_string(),
            None => r#"{"intent":"clarify","clarification":"模板库为空，请直接描述需求"}"#
                .to_string(),
        })
    } else if prompt.contains("[AI_TEST_M3_VERBATIM_GEN]") {
        // 剧本②：交接生成轮——按上下文选定模板回带同一段代码
        let code = app_lib::templates::TemplateRegistry::global()
            .find_by_name("星空粒子")
            .map(|e| e.code.to_string())
            .unwrap_or_default();
        Some(
            serde_json::json!({
                "intent": "generate",
                "code": {
                    "fragment": code,
                    "vertex": null,
                    "uniforms": [],
                    "shadertoy_inputs": ["iTime", "iResolution"]
                }
            })
            .to_string(),
        )
    } else {
        None
    }
}

/// M1/M2 静态剧本：哨兵路由的常量响应体，返回类型统一为 &'static str
fn legacy_static_inner(prompt: &str) -> &'static str {
    if prompt.contains("[AI_TEST_REPORT_ERROR]") {
        r#"{"intent":"report_error","error_feedback":{"phase":"compile","message":"ERROR: 0:3: 'fragColr' : undeclared identifier","line":3,"suggestion":"变量名拼写错误，应为 fragColor"}}"#
    } else if prompt.contains("[AI_TEST_COMPLETE]") {
        r#"{"intent":"complete"}"#
    } else if prompt.contains("[AI_TEST_DOC]") {
        r#"{"intent":"document","documentation":{"inline_comments":"","algorithm_explanation":"使用正弦波扰动 UV 采样形成水波纹","parameters":[{"name":"uSpeed","range":"0.0~5.0","effect":"波动速度","default":"1.0"}],"performance_notes":"单次 sin 采样，性能开销极低"}}"#
    } else if prompt.contains("[自动文档]") && prompt.contains("DOC_DEGRADE_TOKEN") {
        // M4 降级剧本：文档轮收到非 JSON 自由文本 → document_turn 须以 Ok(None) 收场
        "（纯文本）这个效果没什么可写进文档的。"
    } else if prompt.contains("[自动文档]") {
        // M4 文档轮主剧本：结构化四字段产出
        DOC_M4
    } else if prompt.contains("[AI_TEST_SUGGEST]") {
        r#"{"intent":"suggest","suggestions":[{"name":"流动波纹","description":"蓝色渐变水波","category":"背景","preview_thumbnail":"","code":""}]}"#
    } else if prompt.contains("[自动验证]") && prompt.contains("SCENE_C_GIVE_UP") {
        // 管线场景 C：修复轮 LLM 明确放弃（report_error）
        FIX_SURRENDER
    } else if prompt.contains("SCENE_B_STILL_BROKEN") || prompt.contains("[AI_TEST_GENERATE]") {
        // 管线场景 B：始终返回缺陷代码（标记经错误信息回流到修复轮提示中）
        // 首次生成也刻意带错——这正是触发自动验证循环的入口
        GEN_BROKEN
    } else if prompt.contains("[自动验证]") {
        // 管线默认修复剧本：一次修复即通过
        GEN_GOOD
    } else {
        r#"{"intent":"clarify","clarification":"需要确认：想要的颜色主题与波动速度偏好是什么？"}"#
    }
}

fn handle_conn(stream: &mut TcpStream) {
    let (headers, body) = match read_request(stream) {
        Some(v) => v,
        None => return,
    };
    let auth_ok = headers.contains(&format!("authorization: bearer {}", VALID_KEY));
    if !auth_ok {
        respond(
            stream,
            401,
            r#"{"error":{"message":"Invalid API key","type":"invalid_request_error"}}"#,
        );
        return;
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let prompt = parsed["messages"]
        .as_array()
        .and_then(|msgs| {
            msgs.iter()
                .rev()
                .find(|m| m["role"] == "user")
                .and_then(|m| m["content"].as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    captures().lock().unwrap().push(prompt.clone());
    // rig 的 raw_stream 会把 {"stream": true} 合并进请求体——据此判定走 SSE 还是整包 JSON
    if parsed["stream"].as_bool() == Some(true) {
        respond_sse(stream, &scripted_sse_body(&prompt));
    } else {
        respond(stream, 200, &scripted_content(&prompt));
    }
}

async fn drive(
    agent: &ShaderAgent,
    phase: Phase,
    msg: &str,
    hist: &mut Vec<Message>,
    ctx: &SessionContext,
) -> (ShaderResponse, bool) {
    let raw = agent
        .send_turn(phase, msg, ctx, hist)
        .await
        .expect("send_turn should succeed against mock");
    let (resp, ok) = extract_shader_response(&raw);
    (resp, ok)
}

#[tokio::test]
async fn full_state_machine_roundtrip_against_mock_openai() {
    let port = spawn_mock();
    let cfg = AgentConfig {
        api_key: VALID_KEY.to_string(),
        base_url: format!("http://127.0.0.1:{}/v1", port),
        model: "mock-model".to_string(),
        ..AgentConfig::default()
    };
    let agent = ShaderAgent::new(&cfg).expect("agent init ok");
    let ctx = SessionContext::default();
    let mut hist: Vec<Message> = Vec::new();

    let (resp, ok) = drive(&agent, Phase::Planning, "[AI_TEST_CLARIFY]", &mut hist, &ctx).await;
    assert!(ok);
    assert_eq!(resp.intent, Intent::Clarify);
    assert!(resp.clarification.as_deref().unwrap_or_default().contains("颜色"));
    assert_eq!(Phase::Planning.next(&resp), Phase::Planning);

    let (resp, ok) = drive(&agent, Phase::Planning, "[AI_TEST_GENERATE]", &mut hist, &ctx).await;
    assert!(ok);
    assert_eq!(resp.intent, Intent::Generate);
    let code = resp.code.as_ref().expect("code present");
    assert!(code.fragment.contains("mainImage"));
    assert_eq!(code.uniforms.len(), 1);
    assert_eq!(code.uniforms[0].name, "uSpeed");
    assert!(code.shadertoy_inputs.iter().any(|s| s == "iTime"));
    assert_eq!(Phase::Planning.next(&resp), Phase::Coding);

    let (resp, _) = drive(&agent, Phase::Coding, "[AI_TEST_GENERATE]", &mut hist, &ctx).await;
    assert_eq!(resp.intent, Intent::Generate);
    assert_eq!(Phase::Coding.next(&resp), Phase::Testing);

    let (resp, ok) = drive(&agent, Phase::Testing, "[AI_TEST_REPORT_ERROR]", &mut hist, &ctx).await;
    assert!(ok);
    assert_eq!(resp.intent, Intent::ReportError);
    let fb = resp.error_feedback.as_ref().expect("feedback present");
    assert_eq!(fb.line, Some(3));
    assert_eq!(fb.phase, "compile");
    assert!(!fb.suggestion.is_empty());
    assert_eq!(Phase::Testing.next(&resp), Phase::Coding);

    let (resp, _) = drive(&agent, Phase::Coding, "[AI_TEST_GENERATE]", &mut hist, &ctx).await;
    assert_eq!(Phase::Coding.next(&resp), Phase::Testing);

    let (resp, ok) = drive(&agent, Phase::Testing, "[AI_TEST_COMPLETE]", &mut hist, &ctx).await;
    assert!(ok);
    assert_eq!(resp.intent, Intent::Complete);
    assert_eq!(Phase::Testing.next(&resp), Phase::Documentation);

    let (resp, ok) = drive(
        &agent,
        Phase::Documentation,
        "[AI_TEST_DOC]",
        &mut hist,
        &ctx,
    )
    .await;
    assert!(ok);
    assert_eq!(resp.intent, Intent::Document);
    let doc = resp.documentation.as_ref().expect("doc present");
    assert!(doc.algorithm_explanation.contains("水波纹") || !doc.algorithm_explanation.is_empty());
    assert_eq!(doc.parameters.len(), 1);
    assert_eq!(doc.parameters[0].name, "uSpeed");
    assert_eq!(Phase::Documentation.next(&resp), Phase::Planning);

    let (resp, _) = drive(&agent, Phase::Planning, "[AI_TEST_SUGGEST]", &mut hist, &ctx).await;
    assert_eq!(resp.intent, Intent::Suggest);
    assert_eq!(resp.suggestions.len(), 1);
    assert_eq!(resp.suggestions[0].name, "流动波纹");

    assert_eq!(hist.len(), 16, "rig chat 应为每轮追加 user+assistant 两条消息");
}

#[tokio::test]
async fn agent_rejects_blank_api_key_at_build_time() {
    let cfg = AgentConfig {
        api_key: "   ".to_string(),
        ..AgentConfig::default()
    };
    assert!(ShaderAgent::new(&cfg).is_err());
}

#[tokio::test]
async fn mock_returns_401_and_send_turn_fails_on_wrong_key() {
    let port = spawn_mock();
    let cfg = AgentConfig {
        api_key: "wrong-key".to_string(),
        base_url: format!("http://127.0.0.1:{}/v1", port),
        model: "mock-model".to_string(),
        ..AgentConfig::default()
    };
    let agent = ShaderAgent::new(&cfg).expect("agent init ok");
    let ctx = SessionContext::default();
    let mut hist: Vec<Message> = Vec::new();
    let out = agent
        .send_turn(Phase::Planning, "hello", &ctx, &mut hist)
        .await;
    assert!(out.is_err(), "错误 Key 应导致调用失败");
}

#[tokio::test]
async fn extractor_falls_back_to_clarify_on_plain_text() {
    let (resp, ok) = extract_shader_response("这是一段没有任何 JSON 的自由回答。");
    assert!(!ok);
    assert_eq!(resp.intent, Intent::Clarify);
    assert_eq!(
        resp.clarification.as_deref(),
        Some("这是一段没有任何 JSON 的自由回答。")
    );
}

// ========== M1 自动验证与修复循环：注入式 validator 的确定性 E2E ==========

fn pass_report() -> CompileReport {
    CompileReport {
        success: true,
        unavailable_reason: None,
        errors: vec![],
        warnings: vec![],
    }
}

fn fail_report(line: u32, msg: &str) -> CompileReport {
    CompileReport {
        success: false,
        unavailable_reason: None,
        errors: vec![CompileError {
            line,
            column: 30,
            message: msg.to_string(),
        }],
        warnings: vec![],
    }
}

/// 场景 A：按代码内容判别——模拟真实 glslang，误拼标识符消失即通过
fn scene_a_validator(fragment: &str, _vertex: Option<&str>) -> CompileReport {
    if fragment.contains("uSpeeed") {
        fail_report(3, "'uSpeeed' : undeclared identifier")
    } else {
        pass_report()
    }
}

/// 场景 B：无论喂什么都失败；哨兵经错误信息回流到修复轮提示，mock 始终回坏码
fn scene_b_always_fail_validator(_fragment: &str, _vertex: Option<&str>) -> CompileReport {
    fail_report(5, "SCENE_B_STILL_BROKEN: 'uSpeeed' : undeclared identifier")
}

/// 场景 C：与 B 同构，哨兵切换为「AI 放弃」剧本
fn scene_c_surrender_marker_validator(_fragment: &str, _vertex: Option<&str>) -> CompileReport {
    fail_report(4, "SCENE_C_GIVE_UP: 'uSpeeed' : undeclared identifier")
}

/// 场景 D：glslang 缺失 → 本次验证直接 skipped，绝不进入修复循环
fn scene_d_unavailable_validator(_fragment: &str, _vertex: Option<&str>) -> CompileReport {
    CompileReport {
        success: true,
        unavailable_reason: Some("glslangValidator 未安装（测试模拟）".to_string()),
        errors: vec![],
        warnings: vec![],
    }
}

/// 渲染桩：总是成功且非黑帧（既有 M1 场景不应触发渲染修复轮）
fn always_render_ok_renderer() -> pipeline::RendererFn {
    std::sync::Arc::new(|_fragment: String| {
        Box::pin(async move {
            RenderReport {
                success: true,
                unavailable_reason: None,
                errors: vec![],
                is_black_frame: false,
                is_white_frame: false,
                avg_brightness: 0.42,
                coverage: 0.87,
                render_time_ms: 1.0,
                thumbnail_base64: Some("data:image/png;base64,AAAA".to_string()),
            }
        })
    })
}

fn pipeline_fixture(port: u16) -> (ShaderAgent, SessionContext, Vec<Message>) {
    let cfg = AgentConfig {
        api_key: VALID_KEY.to_string(),
        base_url: format!("http://127.0.0.1:{}/v1", port),
        model: "mock-model".to_string(),
        ..AgentConfig::default()
    };
    (
        ShaderAgent::new(&cfg).expect("agent init ok"),
        SessionContext::default(),
        Vec::new(),
    )
}

#[tokio::test]
async fn pipeline_fix_once_then_pass_promotes_to_documentation() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 首轮生成命中 [AI_TEST_GENERATE] 返回 GEN_BROKEN；
    // 修复轮提示以 [自动验证] 开头且无哨兵 → 路由到 GEN_GOOD
    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "passed");
    assert_eq!(v.fix_attempts, 1);
    assert!(v.errors.is_empty());

    assert_eq!(out.final_phase, Phase::Documentation);
    assert!(out.reply_display.is_empty());
    assert!(out.notices.iter().any(|notice| notice.code == "chat.notice.compile-passed"));
    assert!(out.notices.iter().any(|notice| notice.code == "chat.notice.render-passed"));

    let code = out.final_code.as_ref().expect("final code present");
    assert!(code.fragment.contains("iTime * uSpeed"), "应为修复后的代码");
    assert!(!code.fragment.contains("uSpeeed"), "不应残留误拼标识符");
    assert_eq!(hist.len(), 4, "首轮生成 + 一次修复 = 2 次调用 × 2 条消息");
}

#[tokio::test]
async fn pipeline_exhausted_retries_fall_back_to_coding_with_standard_suggestion() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_b_always_fail_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "failed");
    assert_eq!(v.fix_attempts, MAX_FIX_ATTEMPTS);
    assert_eq!(v.errors.len(), 1);
    assert!(v.errors[0].message.contains("SCENE_B_STILL_BROKEN"));
    assert!(v.note.is_none());

    assert_eq!(out.final_phase, Phase::Coding);

    let fb = out
        .response
        .error_feedback
        .as_ref()
        .expect("预算耗尽后必须自动补全错误反馈");
    assert_eq!(fb.phase, "compile");
    assert_eq!(fb.line, Some(5));
    assert!(fb.message.contains("SCENE_B_STILL_BROKEN"));
    assert!(
        fb.suggestion.is_empty(),
        "无模型替代建议时不应注入固定产品文案，实际：{}",
        fb.suggestion
    );

    let code = out.final_code.as_ref().expect("final code present");
    assert!(code.fragment.contains("uSpeeed"), "始终保留最后一次的坏码");
    assert_eq!(hist.len(), 8, "首轮 + 3 次修复 = 4 次调用 × 2 条消息");
}

#[tokio::test]
async fn pipeline_llm_surrender_surfaces_alternative_suggestion() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 三轮修复全部命中 FIX_SURRENDER（report_error）→ 记录 unfixable_reason 并耗尽预算
    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_c_surrender_marker_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "failed");
    assert_eq!(v.fix_attempts, MAX_FIX_ATTEMPTS);
    assert_eq!(out.final_phase, Phase::Coding);

    let fb = out.response.error_feedback.as_ref().expect("放弃路径必须产出反馈");
    assert!(fb.suggestion.contains("该效果依赖外部纹理数据"), "须携带 LLM 报告的原因");
    assert!(fb.suggestion.contains("纯数学噪声替代纹理采样"), "须携带 LLM 给出的替代方案");

    assert!(
        out.final_code
            .as_ref()
            .expect("final code present")
            .fragment
            .contains("uSpeeed"),
        "放弃轮不改写代码"
    );
}

#[tokio::test]
async fn pipeline_tool_unavailable_marks_validation_skipped() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_d_unavailable_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "skipped");
    assert_eq!(v.fix_attempts, 0);
    assert!(v.errors.is_empty());
    assert_eq!(
        v.note.as_deref(),
        Some("glslangValidator 未安装（测试模拟）")
    );

    // 跳过验证时不改写状态机：Coding --generate--> Testing
    assert_eq!(out.final_phase, Phase::Testing);
    assert!(!out.reply_display.contains("✅"));
    assert!(out.response.error_feedback.is_none());
    assert_eq!(hist.len(), 2, "工具不可用时仅一轮调用，不进入循环");
    assert!(
        out.final_code
            .expect("final code present")
            .fragment
            .contains("uSpeeed"),
        "跳过验证时原样透传 LLM 代码"
    );
}

// ========== M2 渲染验证链路：优雅降级 / 黑帧修复回路 / 预算耗尽 ==========

/// 渲染桩：报告 GPU 不可用——应触发优雅降级而非失败循环
fn unavailable_gpu_renderer() -> pipeline::RendererFn {
    std::sync::Arc::new(|_fragment: String| {
        Box::pin(async move {
            RenderReport {
                success: false,
                unavailable_reason: Some("测试模拟：无可用 GPU 适配器".to_string()),
                errors: vec![],
                is_black_frame: false,
                is_white_frame: false,
                avg_brightness: 0.0,
                coverage: 0.0,
                render_time_ms: 0.5,
                thumbnail_base64: None,
            }
        })
    })
}

fn good_render_report() -> RenderReport {
    RenderReport {
        success: true,
        unavailable_reason: None,
        errors: vec![],
        is_black_frame: false,
        is_white_frame: false,
        avg_brightness: 0.42,
        coverage: 0.87,
        render_time_ms: 1.0,
        thumbnail_base64: Some("data:image/png;base64,AAAA".to_string()),
    }
}

/// 渲染桩：永远黑帧且 success=true——预算耗尽后必须判失败，禁止「黑帧假通过」
fn always_black_renderer() -> pipeline::RendererFn {
    std::sync::Arc::new(|_fragment: String| {
        Box::pin(async move {
            RenderReport {
                success: true,
                unavailable_reason: None,
                errors: vec![],
                is_black_frame: true,
                is_white_frame: false,
                avg_brightness: 0.0,
                coverage: 0.0,
                render_time_ms: 1.0,
                thumbnail_base64: None,
            }
        })
    })
}

/// 渲染桩：首次黑帧、此后正常——验证 §八 黑帧驱动的修复回路可以收敛
fn black_once_then_good_renderer() -> pipeline::RendererFn {
    let calls = std::sync::atomic::AtomicUsize::new(0);
    std::sync::Arc::new(move |_fragment: String| {
        let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if n == 0 {
                RenderReport {
                    success: true,
                    unavailable_reason: None,
                    errors: vec![],
                    is_black_frame: true,
                    is_white_frame: false,
                    avg_brightness: 0.0,
                    coverage: 0.0,
                    render_time_ms: 1.0,
                    thumbnail_base64: None,
                }
            } else {
                good_render_report()
            }
        })
    })
}

#[tokio::test]
async fn pipeline_render_unavailable_degrades_to_passed_with_note() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // GEN_BROKEN 先挂一次编译 → 修复轮得 GEN_GOOD；渲染器报 GPU 缺失：
    // 不进入修复循环、不改判失败，仅附注弱化提示（环境问题 ≠ 代码缺陷）
    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &unavailable_gpu_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "passed", "GPU 缺失不得连坐编译通过的代码");
    assert_eq!(v.fix_attempts, 1);
    assert!(v.errors.is_empty());

    let rr = v.render.as_ref().expect("编译通过时渲染报告必存在");
    assert!(rr.unavailable_reason.is_some());
    assert!(rr.thumbnail_base64.is_none());
    assert_eq!(
        v.note.as_deref(),
        Some("测试模拟：无可用 GPU 适配器")
    );

    assert_eq!(out.final_phase, Phase::Documentation);
    assert!(out.reply_display.is_empty());
    assert!(out.notices.iter().any(|notice| notice.code == "chat.notice.compile-passed"));
    assert!(out.notices.iter().any(|notice| notice.code == "chat.notice.render-skipped"));
    assert_eq!(hist.len(), 4, "渲染不可用不应追加任何 LLM 调用");
}

#[tokio::test]
async fn pipeline_black_frame_triggers_render_fix_then_passes() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 轮 1 GEN_BROKEN → 编译修复得 GEN_GOOD；首次渲染黑帧 → 渲染修复轮
    // 再次得到可编译代码 → 二次渲染正常 → 通过并产出缩略图统计
    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &black_once_then_good_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "passed");
    assert_eq!(
        v.fix_attempts, 2,
        "计数应为编译修复 1 次 + 渲染修复 1 次之和"
    );
    assert!(v.errors.is_empty());

    let rr = v.render.as_ref().expect("成功路径必带渲染报告");
    assert!(rr.success);
    assert!(!rr.is_black_frame, "收敛后的最终帧不得仍是黑帧");
    assert!((rr.avg_brightness - 0.42).abs() < 1e-6);
    assert!(rr.thumbnail_base64.is_some());

    assert_eq!(out.final_phase, Phase::Documentation);
    assert!(out.reply_display.is_empty());
    assert!(out.notices.iter().any(|notice| notice.code == "chat.notice.render-passed"));
    assert_eq!(hist.len(), 6, "生成 + 编译修复 + 渲染修复 = 3 次调用 × 2 条");
}

#[tokio::test]
async fn pipeline_black_frame_budget_exhaustion_fails_with_render_feedback() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 渲染桩恒为黑帧：预算耗尽后绝不允许以「passed + 黑图缩略图」蒙混过关，
    // 必须落在失败分支并给出 phase="render" 的结构化反馈
    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_black_renderer(),
    )
    .await
    .expect("turn should succeed");

    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "failed", "持续黑帧必须判失败而非假通过");
    assert_eq!(
        v.fix_attempts, 4,
        "编译修复 1 次 + 渲染修复 3 次（预算上限）"
    );
    assert!(v.errors.is_empty(), "黑帧无 GPU 端错误行，errors 应为空");
    assert!(v.note.is_none());

    assert_eq!(out.final_phase, Phase::Coding);
    assert!(out.reply_display.is_empty());
    assert!(out.notices.iter().any(|notice| notice.code == "chat.notice.render-failed"));
    assert!(out.response.error_feedback.is_none(), "产品摘要由 notice 表达，黑帧无外部错误文本");

    let rr = v.render.as_ref().expect("最终渲染报告仍须回传供前端展示");
    assert!(rr.success && rr.is_black_frame);
    let code = out.final_code.as_ref().expect("final code present");
    assert!(!code.fragment.contains("uSpeeed"), "最终码应为最后一次可编译版本");

    assert_eq!(
        hist.len(),
        10,
        "生成 + 编译修复 + 3 次渲染修复 = 5 次调用 × 2 条"
    );
}

// ========== M3 规划阶段：模板注入 / 追问答复闭环 / 确定性模板交接 ==========

#[tokio::test]
async fn m3_planning_turn_injects_matching_template_into_captured_prompt() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    let out = pipeline::process_turn(
        &agent,
        Phase::Planning,
        "[AI_TEST_M3_SUGGEST] 我想要一个星空背景效果",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("planning turn should succeed");

    // LLM 看到注入区块后按剧本回带注册表第一名
    assert!(out.parse_ok);
    assert_eq!(out.response.intent, Intent::Suggest);
    assert_eq!(out.response.suggestions.len(), 1);
    assert_eq!(out.response.suggestions[0].name, "星空粒子");
    assert!(!out.response.suggestions[0].code.trim().is_empty());
    assert_eq!(hist.len(), 2, "单轮规划 = 一次调用 × 2 条消息");

    // 抓包断言：提示词必须携带完整检索区块与逐字代码
    let shot = last_captured("[AI_TEST_M3_SUGGEST]");
    assert!(shot.contains("【模板库检索结果】"), "实际提示词：{shot}");
    assert!(shot.contains("按相关度排序"));
    assert!(shot.contains("星空粒子"), "命中模板名必须出现在提示词中");
    assert!(shot.contains("三层视差滚动的哈希星空"), "描述须原样进入");
    assert!(shot.contains("float hash21(vec2 p)"), "GLSL 源码必须逐字注入");
    assert!(shot.contains("```glsl"));
}

#[tokio::test]
async fn m3_clarify_loop_stays_planning_and_injection_only_on_hits() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 轮 1：模糊表述——零命中时不得注入任何检索区块
    let out1 = pipeline::process_turn(
        &agent,
        Phase::Planning,
        "[AI_TEST_M3_AMBIGUOUS] 给我整点酷炫的玩意儿 zzzqqq111",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");
    assert_eq!(out1.response.intent, Intent::Clarify);
    assert_eq!(Phase::Planning.next(&out1.response), Phase::Planning);

    let shot1 = last_captured("[AI_TEST_M3_AMBIGUOUS]");
    assert!(
        !shot1.contains("按相关度排序"),
        "无命中的查询严禁注入空区块（规则 #6 教学文案本身含区块标题，故以注入独有短语为准），实际提示词：{shot1}"
    );

    // 轮 2：用户答复收敛到「星空」——同会话续问，注入出现且仍停留规划阶段
    let out2 = pipeline::process_turn(
        &agent,
        Phase::Planning,
        "[AI_TEST_M3_ANSWER] 想了想，做星空就好，蓝紫色调",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");
    assert_eq!(out2.response.intent, Intent::Clarify);
    assert_eq!(Phase::Planning.next(&out2.response), Phase::Planning);
    assert_eq!(hist.len(), 4, "两轮规划 = 两次调用 × 各 2 条消息");

    let shot2 = last_captured("[AI_TEST_M3_ANSWER]");
    assert!(shot2.contains("【模板库检索结果】"));
    assert!(shot2.contains("星空粒子"));
}

#[tokio::test]
async fn m3_template_handoff_verbatim_code_reaches_coding_phase() {
    let port = spawn_mock();
    let (agent, _fresh, mut hist) = pipeline_fixture(port);

    // 第一步：复刻 ipc::chat::select_template 的核心桥接语义（去掉 Tauri 壳）——
    // 注册表逐字取出模板 → 写入 selected_template
    let entry = app_lib::templates::TemplateRegistry::global()
        .find_by_name("星空粒子")
        .expect("注册表必须包含 starfield 模板");
    let verbatim = entry.code.to_string();

    let ctx = SessionContext {
        selected_template: Some(entry.name.clone()),
        ..SessionContext::default()
    };

    // 第二步：交接后的下一轮对话——上下文回灌选定模板，LLM 按剧本原样交还代码
    let out = pipeline::process_turn(
        &agent,
        Phase::Planning,
        "[AI_TEST_M3_VERBATIM_GEN] 就按选定的模板来",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("handoff turn should succeed");

    // 抓包确认：selected_template 经上下文快照回流到提示词
    let shot = last_captured("[AI_TEST_M3_VERBATIM_GEN]");
    assert!(
        shot.contains("用户选择的模板: 星空粒子"),
        "上下文必须回灌已选模板，实际提示词：{shot}"
    );

    // 路由断言：generate 意图验证通过后，管线统一推进至 Documentation（与起点无关）
    assert!(out.parse_ok);
    assert_eq!(out.response.intent, Intent::Generate);
    assert_eq!(
        out.final_phase,
        Phase::Documentation,
        "管线规则：validation.status == passed ⇒ Documentation"
    );
    let v = out.validation.expect("generate 轮次必带验证视图");
    assert_eq!(v.status, "passed");
    assert_eq!(v.fix_attempts, 0);

    // 「原样保留」硬保证：管线吐出的代码与注册表源码逐字节一致
    let final_code = out.final_code.expect("final code present");
    assert_eq!(
        final_code.fragment, verbatim,
        "交接后的代码绝不允许被改写或摘要"
    );
    assert_eq!(hist.len(), 2);
}

// ========== M4 文档阶段：自动文档轮的材料注入 / 结构化产出 / 降级收敛 ==========

#[tokio::test]
async fn m4_document_turn_injects_final_code_and_loops_phase_back() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 铺垫：generate→验证通过（GEN_BROKEN 经一轮修复得 GEN_GOOD），阶段推进至文档
    let out = pipeline::process_turn(
        &agent,
        Phase::Coding,
        "[AI_TEST_GENERATE]",
        &ctx,
        &mut hist,
        &scene_a_validator,
        &always_render_ok_renderer(),
    )
    .await
    .expect("turn should succeed");
    assert_eq!(out.final_phase, Phase::Documentation);
    let final_code = out.final_code.expect("final code present");
    assert_eq!(hist.len(), 4, "生成 + 修复 = 2 次调用 × 2 条消息");

    // 文档轮：独立函数直呼，不走状态机、不触发验证
    let doc = pipeline::document_turn(&agent, &final_code, &ctx, &mut hist)
        .await
        .expect("LLM 正常响应时通信不应失败")
        .expect("剧本应产出结构化文档");
    assert!(doc.inline_comments.contains("波形区"), "实际：{}", doc.inline_comments);
    assert!(doc.algorithm_explanation.contains("水波纹"));
    assert_eq!(doc.parameters.len(), 1);
    assert_eq!(doc.parameters[0].name, "uSpeed");
    assert_eq!(
        doc.performance_notes.as_deref(),
        Some("单次 sin 采样，性能开销极低")
    );

    // 抓包断言：材料注入三要素——统一提示词格式、[自动文档] 标记、最终（修复后）代码
    let shot = last_captured("[自动文档]");
    assert!(shot.contains("当前阶段: 文档"), "须经 send_turn 的阶段指令包装，实际提示词：{shot}");
    assert!(shot.contains("逐块注释"), "【文档阶段】规则必须随行注入");
    assert!(shot.contains("[自动文档]"));
    assert!(shot.contains("iTime * uSpeed"), "必须携带修复后的最终代码");
    assert!(!shot.contains("uSpeeed"), "严禁注入已被打回的旧代码");
    assert!(shot.contains("未提供自定义顶点着色器"), "vertex 缺省时须附说明而非空白");

    // 阶段回环契约：文档产物若走状态机，Documentation --document--> Planning
    let doc_resp = ShaderResponse {
        intent: Intent::Document,
        documentation: Some(doc),
        ..Default::default()
    };
    assert_eq!(Phase::Documentation.next(&doc_resp), Phase::Planning);

    assert_eq!(hist.len(), 6, "生成 + 修复 + 文档轮 = 3 次调用 × 2 条消息");
}

#[tokio::test]
async fn m4_document_turn_degrades_to_none_on_plain_text_reply() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 手搓含降级哨兵的代码，直呼 document_turn——无需先过验证管线
    let code = ShaderCode {
        fragment: "void mainImage(out vec4 c, in vec2 p) { float x = 0.0; } // DOC_DEGRADE_TOKEN"
            .to_string(),
        vertex: None,
        uniforms: vec![],
        shadertoy_inputs: vec![],
    };

    let doc = pipeline::document_turn(&agent, &code, &ctx, &mut hist)
        .await
        .expect("LLM 正常响应（HTTP 200）时通信不应失败");
    assert!(doc.is_none(), "非 JSON 回复必须降级为 None 而非向上抛错");

    // 即便降级：源码仍须完整注入（对话材料完整性独立于回复质量）
    let shot = last_captured("[自动文档]");
    assert!(shot.contains("DOC_DEGRADE_TOKEN"), "实际提示词：{shot}");
    assert_eq!(hist.len(), 2, "失败降级同样留存对话记录供后续追问");
}

// ========== M5 流式体验：mock SSE 分支 + 观察者增量回调 + 历史奇偶配平 ==========

#[tokio::test]
async fn m5_streaming_send_turn_feeds_observer_and_keeps_history_parity() {
    let port = spawn_mock();
    let (agent, ctx, mut hist) = pipeline_fixture(port);

    // 挂载观察者后 send_turn 自动改走流式路径（与生产 chat_stream 同一开关）
    let deltas: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let sink = Arc::clone(&deltas);
        agent.set_progress_observer(Some(Box::new(move |chunk| {
            sink.lock().unwrap().push(chunk.to_string());
        })));
    }

    let raw = agent
        .send_turn(Phase::Planning, "[AI_TEST_GENERATE]", &ctx, &mut hist)
        .await
        .expect("流式轮次不应失败");

    // 回复语义与同步路径完全一致：GEN_BROKEN → intent=generate 且代码在列
    let (resp, ok) = extract_shader_response(&raw);
    assert!(ok);
    assert_eq!(resp.intent, Intent::Generate);
    assert!(resp
        .code
        .as_ref()
        .expect("code present")
        .fragment
        .contains("mainImage"));

    // 观察者收到 ≥2 个非空增量，且拼回复现最终全文（打字气泡的正确性根基）
    let got = deltas.lock().unwrap();
    assert!(
        !got.iter().any(|c| c == "\u{1}[reset]"),
        "成功流不应混入重置哨兵"
    );
    assert!(!got.is_empty(), "流式路径必须至少回调一次进度观察者");
    assert!(got.len() >= 2, "期望多个增量分片，实际 {} 个", got.len());
    assert!(got.iter().all(|c| !c.is_empty()), "空串增量为噪声回调");
    let replayed: String = got.concat();
    assert_eq!(replayed, raw, "增量拼接必须逐字节还原最终回复");
    drop(got);

    // 历史奇偶配平：一次 LLM 调用 ⇒ user 提示词 + assistant 全文各一条
    assert_eq!(hist.len(), 2);
    let user = serde_json::to_string(&hist[0]).expect("user 序列化");
    assert!(
        user.contains("[AI_TEST_GENERATE]") && user.contains("当前阶段"),
        "user 应保存组装后的完整提示词，实际：{user}"
    );
    let asst = serde_json::to_string(&hist[1]).expect("assistant 序列化");
    assert!(
        asst.contains("uSpeed") && asst.contains("```json"),
        "assistant 应保存未经裁剪的原始全文，实际：{asst}"
    );

    // 抓包侧证：该轮请求体带 stream:true（由 mock 走 SSE 分支间接触发）
    assert!(
        last_captured("[AI_TEST_GENERATE]").contains("[AI_TEST_GENERATE]"),
        "提示词抓包通道对流式请求同样生效"
    );
}
