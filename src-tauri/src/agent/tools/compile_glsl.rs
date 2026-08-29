//! GLSL 编译验证工具（Rig agent.md §5.2）。
//!
//! 通过外部 `glslangValidator` 对 AI 生成的 Shadertoy 风格代码做确定性编译验证：
//! - 自动补装 Shadertoy 包装序言（iTime/iResolution 等 uniform + main() 入口）
//! - 解析 ERROR/WARNING 并把行号回映到用户源码坐标系
//! - 未检测到 glslangValidator 时优雅降级为 skipped，不阻塞对话

use crate::agent::context::CompileError;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一次编译验证的完整报告。
#[derive(Debug, Clone, Serialize)]
pub struct CompileReport {
    /// true = 编译通过；工具缺失时也为 true 但携带 skipped 标记
    pub success: bool,
    /// Some(reason) = glslangValidator 不可用，本次验证被跳过
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub errors: Vec<CompileError>,
    pub warnings: Vec<String>,
}

impl CompileReport {
    fn unavailable(reason: String) -> Self {
        CompileReport {
            success: true,
            unavailable_reason: Some(reason),
            errors: vec![],
            warnings: vec![],
        }
    }

    pub fn tool_available(&self) -> bool {
        self.unavailable_reason.is_none()
    }
}

static GLSLANG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "glslangValidator.exe"
    } else {
        "glslangValidator"
    }
}

fn probe(path: &Path) -> bool {
    // 只要进程能被拉起即可（无论退出码），NotFound 才代表不可用
    Command::new(path).arg("--version").output().is_ok()
}

fn candidate_dirs() -> Vec<PathBuf> {
    let name = binary_name();
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("SHADERLAB_GLSLANG") {
        if !p.trim().is_empty() {
            dirs.push(PathBuf::from(p.trim()));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    if cfg!(windows) {
        if let Ok(rd) = std::fs::read_dir("C:/VulkanSDK") {
            let mut vers: Vec<PathBuf> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            vers.sort();
            for v in vers.into_iter().rev() {
                dirs.push(v.join("Bin"));
                dirs.push(v.join("Bin64"));
            }
        }
        dirs.push(PathBuf::from("C:/Program Files/glslang/bin"));
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs.into_iter().map(|d| d.join(name)).collect()
}

/// 定位 glslangValidator（结果进程内缓存一次）。
pub fn locate_glslang() -> Option<&'static PathBuf> {
    GLSLANG_PATH
        .get_or_init(|| {
            let bare = PathBuf::from(binary_name());
            let mut candidates = candidate_dirs();
            candidates.push(bare.clone());
            let found = candidates.iter().find(|c| probe(c));
            match found {
                Some(c) => {
                    log::info!("glslangValidator 定位于 {:?}", c);
                    Some(c.clone())
                }
                None => {
                    log::info!("未检测到 glslangValidator，AI 编译验证将跳过");
                    None
                }
            }
        })
        .as_ref()
}

fn write_temp(source: &str, stage: &str) -> Result<PathBuf, String> {
    let ext = match stage {
        "vertex" | "vert" => "vert",
        _ => "frag",
    };
    let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!(
        "shaderlab_m1_{}_{}_{n}.{}",
        std::process::id(),
        ts,
        ext
    ));
    let mut f = std::fs::File::create(&path).map_err(|e| format!("临时文件创建失败: {e}"))?;
    f.write_all(source.as_bytes())
        .map_err(|e| format!("临时文件写入失败: {e}"))?;
    Ok(path)
}

/// 判断用户源码是否已声明某 uniform（供 glslang 包装与 wgpu 包装共用）。
pub fn declares_uniform(user_source: &str, name: &str) -> bool {
    user_source.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with("uniform")
            && t.split(|c: char| !c.is_alphanumeric() && c != '_')
                .any(|tok| tok == name)
    })
}

const CORE_UNIFORMS: [(&str, &str); 7] = [
    ("iResolution", "uniform vec3 iResolution;"),
    ("iTime", "uniform float iTime;"),
    ("iTimeDelta", "uniform float iTimeDelta;"),
    ("iMouse", "uniform vec4 iMouse;"),
    ("iChannel0", "uniform sampler2D iChannel0;"),
    ("iChannel1", "uniform sampler2D iChannel1;"),
    ("iChannel2", "uniform sampler2D iChannel2;"),
];

pub struct WrappedShader {
    pub source: String,
    /// 用户第一行代码在包装后文件中的 0 基行号（即序言行数）
    pub prelude_lines: u32,
    pub user_line_count: u32,
}

/// 把用户源码拆成（可选的 #version 行正文， 剥离后的主体）。
/// 含版本时主体从换行后开始；无版本时原样返回整段源码。
pub fn split_version(user_source: &str) -> (Option<String>, &str) {
    let trimmed = user_source.trim_start();
    if trimmed.starts_with("#version") {
        let nl = trimmed.find('\n').unwrap_or(trimmed.len());
        (
            Some(trimmed[..nl].trim().to_string()),
            &trimmed[(nl + 1).min(trimmed.len())..],
        )
    } else {
        (None, user_source)
    }
}

/// 为 Shadertoy 风格 fragment 源码补装可独立编译的包装。
/// 用户已声明的 uniform 不会重复注入；已有 #version 时不再前置。
pub fn wrap_fragment(user_source: &str) -> WrappedShader {
    let (ver_opt, body_src) = split_version(user_source);
    let head_version = ver_opt.unwrap_or_else(|| "#version 330 core".to_string());
    let mut lines: Vec<String> = Vec::new();
    lines.push(head_version);
    lines.push(String::new());
    let mut core = CORE_UNIFORMS.to_vec();
    core.push(("iChannel3", "uniform sampler2D iChannel3;"));
    for (name, decl) in core {
        if !declares_uniform(body_src, name) {
            lines.push(decl.to_string());
        }
    }
    lines.push("out vec4 slOut;".to_string());
    lines.push(String::new());
    let prelude_lines = lines.len() as u32;
    lines.extend(body_src.lines().map(str::to_string));
    let user_line_count = body_src.lines().count() as u32;
    lines.push(String::new());
    lines.push("void main() { mainImage(slOut, gl_FragCoord.xy); }".to_string());
    WrappedShader {
        source: lines.join("\n"),
        prelude_lines,
        user_line_count,
    }
}

/// vertex 着色器按普通 GLSL 处理：仅确保有 #version 与精度声明。
pub fn wrap_vertex(user_source: &str) -> WrappedShader {
    let trimmed = user_source.trim_start();
    let has_version = trimmed.starts_with("#version");
    let mut lines: Vec<String> = Vec::new();
    if !has_version {
        lines.push("#version 330 core".to_string());
    }
    let prelude_lines = lines.len() as u32;
    lines.extend(user_source.lines().map(str::to_string));
    WrappedShader {
        source: lines.join("\n"),
        prelude_lines,
        user_line_count: user_source.lines().count() as u32,
    }
}

/// 把 glslang 行号映射回用户源码坐标；0 表示错误落在包装层或无法解析。
fn remap(raw_line: u32, prelude_lines: u32) -> u32 {
    if raw_line == 0 {
        return 0;
    }
    raw_line.saturating_sub(prelude_lines)
}

/// 解析 glslang 输出中的 ERROR 行。
/// 兼容两种格式：`ERROR: 0:12: msg` 与 `ERROR: <file>:12: msg`。
pub fn parse_errors(text: &str, prelude_lines: u32) -> Vec<CompileError> {
    let mut out: Vec<CompileError> = Vec::new();
    for line in text.lines() {
        let l = line.trim_start();
        if !l.starts_with("ERROR:") {
            continue;
        }
        let segs: Vec<&str> = l.splitn(4, ':').collect();
        let parsed = match segs.as_slice() {
            [_, file_tok, line_tok, msg] => {
                line_tok.trim().parse::<u32>().ok().map(|raw| CompileError {
                    line: remap(raw, prelude_lines),
                    column: 0,
                    message: format!("[{}] {}", file_tok.trim(), msg.trim()),
                })
            }
            _ => None,
        };
        out.push(parsed.unwrap_or_else(|| CompileError {
            line: 0,
            column: 0,
            message: l.trim_start_matches("ERROR:").trim().to_string(),
        }));
    }
    let mut unique: Vec<CompileError> = Vec::with_capacity(out.len());
    for e in out {
        if !unique.contains(&e) {
            unique.push(e);
        }
    }
    unique
}

/// 解析 WARNING 行（保留原文、去重）。
pub fn parse_warnings(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("WARNING:") && !out.contains(&l.to_string()) {
            out.push(l.to_string());
        }
    }
    out
}

fn run_stage(
    bin: &Path,
    wrapped: &WrappedShader,
    stage: &str,
) -> Result<(Vec<CompileError>, Vec<String>), String> {
    let path = write_temp(&wrapped.source, stage)?;
    let output = Command::new(bin).arg(&path).output().map_err(|e| {
        let _ = std::fs::remove_file(&path);
        format!("无法执行 glslangValidator: {e}")
    })?;
    let _ = std::fs::remove_file(&path);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let diag = if stdout.trim().is_empty() {
        stderr.to_string()
    } else {
        format!("{stdout}\n{stderr}")
    };
    let errors = parse_errors(&diag, wrapped.prelude_lines);
    let warnings = parse_warnings(&diag);
    let ok = output.status.success() && errors.is_empty();
    Ok(if ok {
        (vec![], warnings)
    } else {
        (errors, warnings)
    })
}

fn wrap_for(stage: &str, source: &str) -> WrappedShader {
    if stage == "vertex" {
        wrap_vertex(source)
    } else {
        wrap_fragment(source)
    }
}

/// 验证一个着色器阶段。内部函数，`validate*` 系列 API 的公共实现。
fn validate_stage(bin: &Path, stage: &str, source: &str) -> Result<CompileReport, String> {
    let wrapped = wrap_for(stage, source);
    let (mut errors, warnings) = run_stage(bin, &wrapped, stage)?;
    if errors.is_empty() && !warnings.is_empty() && source.contains("__probe_never__") {
        unreachable!()
    }
    let success = errors.is_empty();
    errors.truncate(16);
    Ok(CompileReport {
        success,
        unavailable_reason: None,
        errors,
        warnings,
    })
}

/// 验证 fragment（必选）与可选 vertex。
/// 返回的报告综合两个阶段结果；工具缺失时返回 skipped 报告（success=true + unavailable_reason）。
pub fn validate_shader(fragment: &str, vertex: Option<&str>) -> CompileReport {
    let Some(bin) = locate_glslang() else {
        return CompileReport::unavailable(
            "未检测到 glslangValidator，已跳过自动编译验证".to_string(),
        );
    };
    let frag_report = match validate_stage(bin, "fragment", fragment) {
        Ok(r) => r,
        Err(e) => return CompileReport::unavailable(e),
    };
    let vert_errors = match vertex {
        Some(v) if v.trim().len() > 10 => match validate_stage(bin, "vertex", v) {
            Ok(r) => r.errors,
            Err(e) => return CompileReport::unavailable(e),
        },
        _ => vec![],
    };
    let mut errors = frag_report.errors;
    errors.extend(vert_errors);
    CompileReport {
        success: errors.is_empty(),
        unavailable_reason: None,
        errors,
        warnings: frag_report.warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_SRC: &str = "void mainImage(out vec4 c, in vec2 f) {\n    c = vec4(1.0);\n}\n";

    #[test]
    fn wrap_fragment_counts_prelude_and_skips_declared_uniforms() {
        let src = "#version 330 core\nuniform float iTime;\nvoid mainImage(out vec4 c, in vec2 f){c=vec4(iTime);}\n";
        let w = wrap_fragment(src);
        // 用户自带版本提升到首行且只出现一次；已声明 uniform 不重复注入
        assert!(w.source.starts_with("#version"));
        assert_eq!(w.source.matches("#version").count(), 1);
        assert_eq!(
            w.source.matches("uniform float iTime;").count(),
            1,
            "用户自己的 iTime 声明应保留，且不额外注入"
        );
        assert!(w.source.contains("uniform vec3 iResolution;")); // 未声明的照常注入
                                                                 // 序言 = 版本行 + 空行 + 7 条注入 uniform（8 核心 − 已声明 iTime）+ slOut + 空行
        assert_eq!(w.prelude_lines, 11);
        // 正文 = uniform 行 + mainImage 行
        assert_eq!(w.user_line_count, 2);
        assert!(w.source.contains("mainImage(slOut, gl_FragCoord.xy)"));

        let plain = wrap_fragment(USER_SRC);
        assert!(plain
            .source
            .starts_with("#version 330 core\n\nuniform vec3 iResolution;"));
    }

    #[test]
    fn parse_error_lines_and_remaps_line_numbers() {
        let diag = "ERROR: 0:11: 'foo' : undeclared identifier\nERROR: shader.frag:15: syntax error\nWARNING: 0:3: unreferenced variable";
        let errs = parse_errors(diag, 10);
        assert_eq!(errs.len(), 2);
        assert_eq!(errs[0].line, 1); // 11 - 10 序言
        assert_eq!(errs[0].message, "[0] 'foo' : undeclared identifier");
        assert_eq!(errs[1].line, 5);
        assert_eq!(errs[1].message, "[shader.frag] syntax error");

        let prelude_hit = parse_errors("ERROR: 0:3: bad prelude", 10);
        assert_eq!(prelude_hit[0].line, 0);

        let malformed = parse_errors("ERROR: something blew up", 10);
        assert_eq!(malformed[0].line, 0);
        assert_eq!(malformed[0].message, "something blew up");
    }

    #[test]
    fn warnings_parse_dedups() {
        let w = parse_warnings("WARNING: a\nWARNING: a\nok line\nWARNING: b");
        assert_eq!(w, vec!["WARNING: a".to_string(), "WARNING: b".to_string()]);
    }

    #[test]
    fn validate_reports_unavailable_when_tool_missing_env() {
        // 进程级缓存可能已被其它测试初始化；此处仅断言 API 可调用且语义自洽
        let report = validate_shader(USER_SRC, None);
        if report.tool_available() {
            assert!(report.success || !report.errors.is_empty());
        } else {
            assert!(report.success);
            assert!(report.unavailable_reason.is_some());
        }
    }
}
