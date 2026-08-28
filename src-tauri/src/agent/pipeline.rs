//! M1 核心生成管线（Rig agent.md §四/§八）。
//!
//! 在 LLM 产出代码后自动执行确定性编译验证：
//! 通过 → 直接推进到文档阶段；
//! 失败 → 把 glslang 错误注入同一上下文驱动修复，最多 3 次；
//! 仍未通过 → 回到 Coding 阶段并附带替代方案建议。
//!
//! validator 以闭包注入：生产路径走 glslang（tools::compile_glsl），
//! 测试路径可注入假实现做确定性断言。

use super::context::{CompileError, SessionContext, ValidationStatus};
use super::extractor::{
    ErrorFeedback, Intent, ShaderCode, ShaderDoc, ShaderResponse, extract_shader_response,
};
use super::phase::Phase;
use super::tools::{CompileReport, RenderReport, validate_shader};
use super::ShaderAgent;
use rig_core::message::Message;
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub const MAX_FIX_ATTEMPTS: u32 = 3;

/// 默认离屏渲染分辨率（§5.3 default_resolution）
const DEFAULT_RENDER_SIZE: u32 = 512;

/// 渲染器的 boxed-Future 返回值，规避异步闭包 HRTB 推导问题。
pub type RendererFuture = Pin<Box<dyn Future<Output = RenderReport> + Send>>;
/// 渲染验证闭包：生产路径走 wgpu（tools::render_glsl），测试可注入假实现。
pub type RendererFn = Arc<dyn Fn(String) -> RendererFuture + Send + Sync>;

/// 前端可见的验证结果视图（随 ChatResponse 返回）。
#[derive(Debug, Clone, Serialize)]
pub struct ValidationView {
    /// "passed" | "failed" | "skipped"
    pub status: String,
    pub errors: Vec<CompileError>,
    pub warnings: Vec<String>,
    pub fix_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 编译通过后的首帧渲染报告（§八：编译 ──► 渲染）。
    /// 环境不可用时仍存在但带 unavailable_reason，前端据此弱化展示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render: Option<RenderReport>,
}

/// 一次 chat 轮次在管线处理后的完整产出。
pub struct TurnOutput {
    pub response: ShaderResponse,
    pub parse_ok: bool,
    pub reply_display: String,
    pub final_phase: Phase,
    pub validation: Option<ValidationView>,
    /// 最终生效的代码（修复循环可能多次改写）
    pub final_code: Option<ShaderCode>,
}

fn fmt_errors_for_prompt(report: &CompileReport) -> String {
    report
        .errors
        .iter()
        .take(8)
        .map(|e| {
            if e.line > 0 {
                format!("  - 第 {} 行: {}", e.line, e.message)
            } else {
                format!("  - {0}", e.message)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn first_error_line(report: &CompileReport) -> Option<u32> {
    report.errors.iter().find(|e| e.line > 0).map(|e| e.line)
}

/// 生产环境默认 validator：调用本地 glslangValidator。
pub fn default_validator() -> impl Fn(&str, Option<&str>) -> CompileReport + Send + Sync {
    |fragment: &str, vertex: Option<&str>| validate_shader(fragment, vertex)
}

/// 生产环境默认 renderer：wgpu 离屏渲染 512×512 首帧（time=0）。
pub fn default_renderer() -> RendererFn {
    Arc::new(|fragment: String| {
        // async move 将源码所有权移入 Future 自身状态，
        // 避免返回的 Future 借用闭包栈上局部变量（E0597）。
        Box::pin(async move {
            super::tools::render_fragment(
                &fragment,
                DEFAULT_RENDER_SIZE,
                DEFAULT_RENDER_SIZE,
                0.0,
            )
            .await
        }) as RendererFuture
    })
}

/// 渲染失败原因的简述文本（用于注入修复提示与错误反馈）。
fn describe_render_issue(r: &RenderReport) -> String {
    if !r.errors.is_empty() {
        let head = r
            .errors
            .iter()
            .take(4)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        return format!("GPU 端 shader 编译失败：\n{head}");
    }
    if r.is_black_frame {
        return "首帧输出为全黑（可能除零、未初始化变量或坐标错误导致）".to_string();
    }
    "渲染输出异常".to_string()
}

pub async fn process_turn<V>(
    agent: &ShaderAgent,
    start_phase: Phase,
    message: &str,
    context_snapshot: &SessionContext,
    history: &mut Vec<Message>,
    validator: &V,
    renderer: &RendererFn,
) -> Result<TurnOutput, String>
where
    V: Fn(&str, Option<&str>) -> CompileReport + Send + Sync,
{
    // —— M3：规划轮自动检索模板库并注入结果（§5.1 / §M3）——
    let planning_block = if start_phase == Phase::Planning {
        super::tools::search_templates::planning_injection(message)
    } else {
        None
    };
    let effective_message = match planning_block {
        Some(block) => format!("{message}\n\n{block}"),
        None => message.to_string(),
    };

    let raw_reply = agent
        .send_turn(start_phase, &effective_message, context_snapshot, history)
        .await?;
    let (mut response, mut parse_ok) = extract_shader_response(&raw_reply);
    let mut reply_display = response.display_text();

    // —— 非「生成代码」路径：完全保持 M0 状态机语义 ——
    if !matches!(response.intent, Intent::Generate) || response.code.is_none() {
        let next = start_phase.next(&response);
        return Ok(TurnOutput {
            final_code: response.code.clone(),
            response,
            parse_ok,
            reply_display,
            final_phase: next,
            validation: None,
        });
    }

    // —— 自动验证与修复循环（§八 test_with_retry 的确定性落地）——
    let first_code = response.code.clone().unwrap_or_default();
    let mut current_fragment = first_code.fragment.clone();
    let mut current_vertex = first_code.vertex.clone();

    let mut report = validator(&current_fragment, current_vertex.as_deref());
    let mut attempts: u32 = 0;
    let mut unfixable_reason: Option<String> = None;

    while report.tool_available() && !report.success && attempts < MAX_FIX_ATTEMPTS {
        attempts += 1;
        log::warn!(
            "编译失败（第 {attempts}/{MAX_FIX_ATTEMPTS} 次修复尝试），{} 个错误",
            report.errors.len()
        );
        let synth = format!(
            "[自动验证] 第 {attempts}/{MAX_FIX_ATTEMPTS} 次编译失败，glslang 报告如下：\n{}\n\n请遵循【测试阶段】规则：分析错误原因，只修复出错部分；输出符合 JSON 协议的完整可编译代码（intent=\"generate\"）。若确实无法修复，请改用 intent=\"report_error\" 说明原因与替代方案。",
            fmt_errors_for_prompt(&report),
        );
        let raw_fix = agent
            .send_turn(Phase::Testing, &synth, context_snapshot, history)
            .await?;
        let (fix_resp, fix_parse_ok) = extract_shader_response(&raw_fix);
        parse_ok = parse_ok && fix_parse_ok;
        match fix_resp.intent {
            Intent::Generate if fix_resp.code.is_some() => {
                let c = fix_resp.code.as_ref().expect("code checked above");
                current_fragment = c.fragment.clone();
                current_vertex = c.vertex.clone();
                unfixable_reason = None;
            }
            _ => {
                unfixable_reason = Some(match &fix_resp.error_feedback {
                    Some(fb) => {
                        if fb.suggestion.is_empty() {
                            fb.message.clone()
                        } else {
                            format!("{}（{}）", fb.message, fb.suggestion)
                        }
                    }
                    None => fix_resp.display_text(),
                });
            }
        }
        report = validator(&current_fragment, current_vertex.as_deref());
    }

    // —— §八：编译通过后自动渲染；黑帧/GPU 端报错继续消耗修复预算 ——
    let mut render: Option<RenderReport> = None;
    let mut render_unfixable: Option<String> = None;
    let mut render_attempts: u32 = 0;

    fn needs_render_fix(r: &RenderReport) -> bool {
        // 环境不可用（无 GPU）不算代码缺陷，交由优雅降级处理
        (!r.success && r.unavailable_reason.is_none()) || (r.success && r.is_black_frame)
    }

    if report.success {
        let mut rr = renderer(current_fragment.clone()).await;
        while needs_render_fix(&rr) && render_attempts < MAX_FIX_ATTEMPTS {
            render_attempts += 1;
            log::warn!(
                "渲染验证失败（第 {render_attempts}/{MAX_FIX_ATTEMPTS} 次修复尝试）：{}",
                describe_render_issue(&rr)
            );
            let synth = format!(
                "[自动验证] 第 {render_attempts}/{MAX_FIX_ATTEMPTS} 次渲染验证未通过，{}\n\n请遵循【测试阶段】规则：分析问题原因（除零、未初始化变量、坐标错误、时间依赖初值等），输出符合 JSON 协议的完整可编译代码（intent=\"generate\"）。若确实无法修复，请改用 intent=\"report_error\" 说明原因与替代方案。",
                describe_render_issue(&rr),
            );
            let raw_rfix = agent
                .send_turn(Phase::Testing, &synth, context_snapshot, history)
                .await?;
            let (rfix_resp, rfix_parse_ok) = extract_shader_response(&raw_rfix);
            parse_ok = parse_ok && rfix_parse_ok;
            match rfix_resp.intent {
                Intent::Generate if rfix_resp.code.is_some() => {
                    let c = rfix_resp.code.as_ref().expect("code checked above");
                    current_fragment = c.fragment.clone();
                    current_vertex = c.vertex.clone();
                    // 渲染修复可能引入编译回归 → 重新过编译闸门
                    report = validator(&current_fragment, current_vertex.as_deref());
                    if !report.success {
                        break;
                    }
                    rr = renderer(current_fragment.clone()).await;
                }
                _ => {
                    render_unfixable = Some(match &rfix_resp.error_feedback {
                        Some(fb) => {
                            if fb.suggestion.is_empty() {
                                fb.message.clone()
                            } else {
                                format!("{}（{}）", fb.message, fb.suggestion)
                            }
                        }
                        None => rfix_resp.display_text(),
                    });
                    break;
                }
            }
        }
        render = Some(rr);
    }

    let render_fail_line = |msgs: &[String]| -> Option<u32> {
        msgs.iter().find_map(|m| {
            m.split('行').next().and_then(|head| {
                head.trim_start_matches(|c: char| !c.is_ascii_digit())
                    .split(|c: char| !c.is_ascii_digit())
                    .find(|s| !s.is_empty())
                    .and_then(|s| s.parse::<u32>().ok())
            })
        })
    };

    let validation = if !report.tool_available() {
        ValidationView {
            status: "skipped".to_string(),
            errors: vec![],
            warnings: vec![],
            fix_attempts: 0,
            note: report.unavailable_reason.clone(),
            render: None,
        }
    } else if !report.success {
        // 重试预算耗尽仍失败（或渲染修复引发编译回归）→ 回到 Coding
        if response.error_feedback.is_none() {
            let message = report
                .errors
                .first()
                .map(|e| e.message.clone())
                .unwrap_or_else(|| "编译失败".to_string());
            let suggestion = match &unfixable_reason {
                Some(r) => format!("AI 无法自行修复：{r}。建议换一种实现思路、简化效果，或点击 ⟲ 新会话重新描述需求。"),
                None => "已重试 3 次仍未通过。建议换一种实现思路、减少复杂度，或点击 ⟲ 新会话重新描述需求。".to_string(),
            };
            response.error_feedback = Some(ErrorFeedback {
                phase: "compile".to_string(),
                message,
                line: first_error_line(&report),
                suggestion,
            });
        }
        ValidationView {
            status: "failed".to_string(),
            errors: report.errors.clone(),
            warnings: vec![],
            fix_attempts: attempts + render_attempts,
            note: Some(
                if render_attempts > 0 {
                    format!("渲染修复引入编译回归（本轮修复 {render_attempts} 次）")
                } else {
                    format!("已自动尝试修复 {attempts}/{MAX_FIX_ATTEMPTS} 次")
                },
            ),
            render,
        }
    } else {
        // 编译通过 → 结合渲染报告分级呈现
        let rr = render.expect("编译通过时渲染报告必已生成");
        if let Some(reason) = &rr.unavailable_reason {
            // 优雅降级：无 GPU 时保留编译结论，前端弱化渲染展示
            reply_display.push_str("\n\nℹ️ 本机未检测到可用 GPU，已跳过渲染预览，仅完成静态编译验证。");
            ValidationView {
                status: "passed".to_string(),
                errors: vec![],
                warnings: report.warnings.clone(),
                fix_attempts: attempts,
                note: Some(format!("渲染预览不可用：{reason}")),
                render: Some(rr),
            }
        // 黑帧即使 success 也属于缺陷；预算耗尽仍黑 → 走下方失败分支
        } else if rr.success && !rr.is_black_frame {
            reply_display.push_str("\n\n✅ glslang 编译验证通过");
            if !report.warnings.is_empty() {
                reply_display.push_str(&format!("（{} 个警告）", report.warnings.len()));
            }
            reply_display.push_str("，已进入文档阶段——可以说“解释一下算法”或直接提出新需求。");
            reply_display.push_str(&format!(
                "\n🖼️ 首帧渲染验证通过——亮度 {:.2}、覆盖率 {:.0}%，预览图已随消息返回",
                rr.avg_brightness,
                rr.coverage * 100.0
            ));
            ValidationView {
                status: "passed".to_string(),
                errors: vec![],
                warnings: report.warnings.clone(),
                // 用户视角：自动修复总轮次 = 编译修复 + 渲染修复
                fix_attempts: attempts + render_attempts,
                note: None,
                render: Some(rr),
            }
        } else {
            // 渲染端问题未被修复 → 整体判失败，phase=render 反馈给前端红块
            if response.error_feedback.is_none() {
                let message = rr.errors.first().cloned().unwrap_or_else(|| {
                    if rr.is_black_frame {
                        "输出为全黑帧".to_string()
                    } else {
                        "渲染验证未通过".to_string()
                    }
                });
                let suggestion = match &render_unfixable {
                    Some(r) => format!("AI 无法自行修复渲染问题：{r}。建议换一种实现思路、简化效果，或点击 ⟲ 新会话重新描述需求。"),
                    None => format!("渲染问题已重试 {render_attempts}/{MAX_FIX_ATTEMPTS} 次仍未解决。建议检查时间依赖初值与坐标计算，或点击 ⟲ 新会话重新描述需求。"),
                };
                response.error_feedback = Some(ErrorFeedback {
                    phase: "render".to_string(),
                    message,
                    line: render_fail_line(&rr.errors),
                    suggestion,
                });
            }
            let errors: Vec<CompileError> = rr
                .errors
                .iter()
                .map(|m| CompileError {
                    line: render_fail_line(std::slice::from_ref(m)).unwrap_or(0),
                    column: 0,
                    message: m.clone(),
                })
                .collect();
            ValidationView {
                status: "failed".to_string(),
                errors,
                warnings: vec![],
                fix_attempts: attempts + render_attempts,
                note: Some(format!(
                    "渲染验证未通过（已重试 {render_attempts}/{MAX_FIX_ATTEMPTS} 次）"
                )),
                render: Some(rr),
            }
        }
    };

    let final_phase = match validation.status.as_str() {
        "passed" => Phase::Documentation,
        "failed" => Phase::Coding,
        _ => start_phase.next(&response),
    };

    response.code = Some(ShaderCode {
        fragment: current_fragment,
        vertex: current_vertex,
        ..first_code
    });

    Ok(TurnOutput {
        final_code: response.code.clone(),
        response,
        parse_ok,
        reply_display,
        final_phase,
        validation: Some(validation),
    })
}

/// M4：文档轮（§十 数据流）——验证通过或 Complete 推进到文档阶段后自动发起。
///
/// 携带最终生效代码，以【文档阶段】指令驱动 LLM 产出结构化 ShaderDoc；
/// 不走 process_turn 状态机（文档轮不推进阶段、不参与验证），
/// 由 chat.rs 在编排层决定是否调用并合并产物。
///
/// 返回值约定：`Ok(None)` = 解析失败或缺失 documentation 字段，
/// `Err` = LLM 通信失败；两者均由调用方降级处理，不阻断主流程。
pub async fn document_turn(
    agent: &ShaderAgent,
    final_code: &ShaderCode,
    context_snapshot: &SessionContext,
    history: &mut Vec<Message>,
) -> Result<Option<ShaderDoc>, String> {
    let vertex_note = final_code
        .vertex
        .as_deref()
        .unwrap_or("（未提供自定义顶点着色器，使用内置默认版本）");
    let prompt = format!(
        "[自动文档] 编译与渲染验证均已通过，请依据【文档阶段】规则为以下最终代码产出文档。\n\n\
         [fragment 源码]\n{}\n\n[vertex 源码]\n{}",
        final_code.fragment, vertex_note,
    );
    let raw_reply = agent
        .send_turn(Phase::Documentation, &prompt, context_snapshot, history)
        .await?;
    let (response, parse_ok) = extract_shader_response(&raw_reply);
    if !parse_ok {
        log::warn!("文档轮回复未通过 JSON 协议解析，降级为无文档");
        return Ok(None);
    }
    Ok(response.documentation)
}

/// 供 chat.rs 落库用的验证状态推断。
pub fn validation_status_for(view: &ValidationView) -> ValidationStatus {
    match view.status.as_str() {
        "passed" => ValidationStatus::Passed,
        "failed" => ValidationStatus::CompileFailed {
            errors: view.errors.clone(),
        },
        _ => ValidationStatus::NotStarted,
    }
}

/// 会话上下文中 fix_attempts 的落库规则：
/// 失败时保留计数（供下一轮 prompt 感知），通过/跳过则清零。
pub fn context_fix_attempts_for(view: &ValidationView) -> u32 {
    if view.status == "failed" {
        view.fix_attempts
    } else {
        0
    }
}
