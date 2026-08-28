//! M2 渲染验证（Rig agent.md §5.3）。
//!
//! 使用 wgpu 离屏渲染 Shadertoy 风格 fragment：
//! 通过 → 分析首帧亮度/覆盖率并产出缩略图；
//! 失败 → 把 naga/wgpu 错误回传，供管线注入修复提示；
//! GPU 缺失 → 与 glslang 同构的「不可用」优雅降级。
//!
//! GLSL 前端由 naga 提供（wgpu "glsl" 特性）。为保证绑定确定性，
//! 包装器使用 #version 450 + 显式 layout(binding=N)，并传入显式
//! BindGroupLayout——完全不依赖 naga 的自动资源分配顺序。

use std::borrow::Cow;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::Engine as _;
use image::{ImageBuffer, Rgba};
use wgpu::util::DeviceExt;

use super::compile_glsl::{declares_uniform, split_version};

/// 核心块绑定槽位（与包装序言一一对应）
const BIND_RESOLUTION: u32 = 0;
const BIND_SCALARS: u32 = 1;
const BIND_MOUSE: u32 = 2;
const BIND_CHANNEL_BASE: u32 = 3; // 3..7 共 4 个 combined sampler
const BIND_EXTRA_BASE: u32 = 10;

/// 缩略图最长边像素；黑/白帧判定阈值沿用规格书
const THUMB_MAX_SIDE: u32 = 256;
const BLACK_FRAME_LUMA: f32 = 0.01;
const WHITE_FRAME_LUMA: f32 = 0.99;

/// 渲染结果报告——与 CompileReport 对偶：
/// unavailable_reason 表示环境层面无法渲染（非代码问题）；
/// errors 收集 shader 编译期错误，可回流给修复循环。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RenderReport {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    pub is_black_frame: bool,
    pub is_white_frame: bool,
    pub avg_brightness: f32,
    pub coverage: f32,
    pub render_time_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_base64: Option<String>,
}

impl RenderReport {
    fn unavailable(reason: String, elapsed_ms: f64) -> Self {
        Self {
            success: false,
            unavailable_reason: Some(reason),
            errors: vec![],
            is_black_frame: false,
            is_white_frame: false,
            avg_brightness: 0.0,
            coverage: 0.0,
            render_time_ms: elapsed_ms,
            thumbnail_base64: None,
        }
    }

    fn failure(errors: Vec<String>, elapsed_ms: f64) -> Self {
        Self {
            success: false,
            unavailable_reason: None,
            errors,
            is_black_frame: false,
            is_white_frame: false,
            avg_brightness: 0.0,
            coverage: 0.0,
            render_time_ms: elapsed_ms,
            thumbnail_base64: None,
        }
    }
}

/// 从用户主体中扫描「未被核心集覆盖」的 uniform 声明。
/// 仅支持标量/向量与 sampler2D；其他类型返回 Err 提示暂不支持。
fn scan_extra_uniforms(body: &str) -> Result<Vec<(String, u64, bool)>, String> {
    const CORE: [&str; 9] = [
        "iResolution",
        "iTime",
        "iTimeDelta",
        "iFrame",
        "iMouse",
        "iChannel0",
        "iChannel1",
        "iChannel2",
        "iChannel3",
    ];
    let mut out: Vec<(String, u64, bool)> = Vec::new();
    for raw in body.lines() {
        let t = raw.trim_start();
        if !t.starts_with("uniform") || !t.trim_end().ends_with(';') {
            continue;
        }
        let toks: Vec<&str> = t
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .filter(|s| !s.is_empty())
            .collect();
        // 形如 uniform <ty> <name>;
        let Some(ty) = toks.get(1) else { continue };
        let Some(name) = toks.get(2) else { continue };
        if CORE.contains(name) {
            continue;
        }
        let spec: Option<(u64, bool)> = match *ty {
            "float" | "int" | "uint" | "bool" => Some((16, false)),
            "vec2" | "ivec2" | "uvec2" | "bvec2" => Some((16, false)),
            "vec3" | "ivec3" | "uvec3" | "bvec3" => Some((16, false)),
            "vec4" | "ivec4" | "uvec4" | "bvec4" => Some((16, false)),
            "sampler2D" | "samplerCube" => Some((0, true)),
            _ => None,
        };
        let Some((sz, samp)) = spec else {
            return Err(format!("暂不支持的 uniform 类型以进行渲染验证：uniform {ty} {name};"));
        };
        if !out.iter().any(|(n, _, _)| n == name) {
            out.push((name.to_string(), sz, samp));
        }
    }
    Ok(out)
}

/// 标量块 SLScalars 的候选成员注入决定：用户源中已自行声明的不再重复提供。
/// 返回三元组顺序即 std140 声明顺序，渲染端据此同步填充 uniform 数据。
fn scalar_block_members(user_body: &str) -> (bool, bool, bool) {
    (
        !declares_uniform(user_body, "iTime"),
        !declares_uniform(user_body, "iTimeDelta"),
        !declares_uniform(user_body, "iFrame"),
    )
}

/// WGPU 路径专用包装：统一 #version 450 + 显式绑定，并接入 main() shim。
/// 返回错误仅发生在用户使用了暂不支持的外部依赖形态时。
pub fn wrap_fragment_wgpu(user_source: &str) -> Result<String, String> {
    let (_, body_src) = split_version(user_source);

    let mut lines: Vec<String> = Vec::new();
    lines.push("#version 450".to_string());
    lines.push(String::new());
    lines.push("layout(location = 0) out vec4 slOut;".to_string());
    lines.push(String::new());

    // —— 核心接口块：仅注入用户未自行声明的部分，避免重复定义 ——
    let has = |n: &str| declares_uniform(body_src, n);
    if !has("iResolution") {
        lines.push(
            "layout(std140, set = 0, binding = 0) uniform SLResolution { vec3 iResolution; };"
                .to_string(),
        );
    }
    let (inject_time, inject_delta, inject_frame) = scalar_block_members(body_src);
    if inject_time || inject_delta || inject_frame {
        let mut blk =
            String::from("layout(std140, set = 0, binding = 1) uniform SLScalars {\n");
        if inject_time {
            blk.push_str("    float iTime;\n");
        }
        if inject_delta {
            blk.push_str("    float iTimeDelta;\n");
        }
        if inject_frame {
            blk.push_str("    uint iFrame;\n");
        }
        blk.push_str("};");
        lines.push(blk);
    }
    if !has("iMouse") {
        lines.push(
            "layout(std140, set = 0, binding = 2) uniform SLMouse { vec4 iMouse; };".to_string(),
        );
    }

    for ch in 0..4u32 {
        let name = format!("iChannel{ch}");
        if !declares_uniform(body_src, &name) {
            lines.push(format!(
                "layout(set = 0, binding = {}) uniform sampler2D {name};",
                BIND_CHANNEL_BASE + ch
            ));
        }
    }

    // —— 用户额外 uniform：分配后续槽位，零值兜底 ——
    let extras = scan_extra_uniforms(body_src)?;
    let mut binding_cursor = BIND_EXTRA_BASE;
    // 所有顶层 uniform …; 声明都已在上方以外层绑定形式重建，
    // 统一替换为注释占位避免重复声明，并维持行号大致对应。
    let stripped_body: Vec<String> = body_src
        .lines()
        .map(|l| {
            let t = l.trim_start();
            if t.starts_with("uniform") && t.trim_end().ends_with(';') {
                "// [渲染包装] uniform 声明由外层供给".to_string()
            } else {
                l.to_string()
            }
        })
        .collect();

    for (name, sz, is_sampler) in &extras {
        if *is_sampler {
            lines.push(format!(
                "layout(set = 0, binding = {binding_cursor}) uniform sampler2D {name};"
            ));
        } else {
            lines.push(format!(
                "layout(std140, set = 0, binding = {binding_cursor}) uniform SLE{binding_cursor} {{ float {name}[{}]; }};",
                (sz / 16).max(1)
            ));
        }
        binding_cursor += 1;
    }

    lines.push(String::new());
    lines.extend(stripped_body);
    lines.push(String::new());
    lines.push(
        "void main() {\n    vec4 c = vec4(0.0);\n    mainImage(c, gl_FragCoord.xy);\n    slOut = c;\n}"
            .to_string(),
    );

    Ok(lines.join("\n"))
}

/// 首帧分析纯函数（独立便于测试）
pub fn analyze_frame(pixels: &[u8], width: u32, height: u32) -> (f32, f32, bool, bool) {
    debug_assert_eq!(pixels.len(), (width as usize) * (height as usize) * 4);
    let px = pixels.len() / 4;
    let mut sum_luma = 0f64;
    let mut active = 0usize;
    for p in pixels.chunks_exact(4) {
        let r = p[0] as f64 / 255.0;
        let g = p[1] as f64 / 255.0;
        let b = p[2] as f64 / 255.0;
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum_luma += luma;
        if luma * 255.0 > 8.0 || p[3] > 8 {
            active += 1;
        }
    }
    let avg = if px == 0 { 0.0 } else { (sum_luma / px as f64) as f32 };
    let cov = if px == 0 { 0.0 } else { active as f32 / px as f32 };
    (avg, cov, avg < BLACK_FRAME_LUMA, avg > WHITE_FRAME_LUMA)
}

/// 盒滤波降采样到最长边 ≤ THUMB_MAX_SIDE，再编码为 PNG data URL
fn encode_thumbnail(pixels: &[u8], width: u32, height: u32) -> Result<String, String> {
    let scale = (THUMB_MAX_SIDE as f32 / width.max(height) as f32).min(1.0);
    let tw = ((width as f32 * scale).round() as u32).max(1);
    let th = ((height as f32 * scale).round() as u32).max(1);

    let mut down = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        let sy = (y as f32 / th as f32 * height as f32) as u32;
        for x in 0..tw {
            let sx = (x as f32 / tw as f32 * width as f32) as u32;
            let src = ((sy * width + sx) * 4) as usize;
            let dst = ((y * tw + x) * 4) as usize;
            down[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
        }
    }

    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(tw, th, down).ok_or("缩略图缓冲尺寸不匹配")?;
    let mut png = Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png.get_ref());
    Ok(format!("data:image/png;base64,{b64}"))
}

fn round_up_align(v: u32, align: u32) -> u32 {
    ((v + align - 1) / align) * align
}

/// 离屏渲染一次 Shadertoy 风格 fragment 并返回首帧报告。
async fn request_adapter_and_device(
) -> Result<(Arc<Mutex<Vec<String>>>, wgpu::Device, wgpu::Queue), (bool, String)> {
    let dyn_errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = match instance.request_adapter(&wgpu::RequestAdapterOptions::default()).await {
        Ok(a) => a,
        Err(_) => {
            return Err((true, "无法获取 GPU 适配器，离屏渲染已跳过".to_string()));
        }
    };
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .map_err(|e| (true, format!("GPU 设备创建失败：{e}")))?;
    let sink = dyn_errors.clone();
    device.on_uncaptured_error(Box::new(move |e| {
        if let Ok(mut g) = sink.lock() {
            g.push(e.to_string());
        }
    }));
    Ok((dyn_errors, device, queue))
}

/// 供管线调用的入口：渲染并分析一帧。
pub async fn render_fragment(fragment_source: &str, width: u32, height: u32, time: f32) -> RenderReport {
    let start = Instant::now();
    let elapsed = |s: Instant| s.elapsed().as_secs_f64() * 1000.0;

    // 输入净化：钳制到合理分辨率区间
    let width = width.clamp(16, 1024);
    let height = height.clamp(16, 1024);

    let source = match wrap_fragment_wgpu(fragment_source) {
        Ok(s) => s,
        Err(msg) => return RenderReport::unavailable(format!("渲染被跳过：{msg}"), elapsed(start)),
    };

    let (dyn_errors, device, queue) = match request_adapter_and_device().await {
        Ok(v) => v,
        Err((unavail, msg)) => {
            return if unavail {
                RenderReport::unavailable(msg, elapsed(start))
            } else {
                RenderReport::failure(vec![msg], elapsed(start))
            }
        }
    };

    // —— 离屏纹理 ——
    let extent = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    // —— uniform 数据 ——
    let aspect = height.max(1) as f32 / width.max(1) as f32;
    let mut res_data = [0u8; 16];
    res_data[0..4].copy_from_slice(&(width as f32).to_le_bytes());
    res_data[4..8].copy_from_slice(&(height as f32).to_le_bytes());
    res_data[8..12].copy_from_slice(&aspect.to_le_bytes());

    // 标量数据按包装器决定注入的成员子集依序紧凑写入（std140 同序）
    let (inj_time, inj_delta, inj_frame) =
        scalar_block_members(split_version(fragment_source).1);
    let mut scl_data = [0u8; 16];
    let mut off = 0usize;
    if inj_time {
        scl_data[off..off + 4].copy_from_slice(&time.to_le_bytes());
        off += 4;
    }
    if inj_delta {
        scl_data[off..off + 4].copy_from_slice(&(1.0f32 / 60.0).to_le_bytes());
        off += 4;
    }
    if inj_frame {
        scl_data[off..off + 4].copy_from_slice(&1u32.to_le_bytes());
    }
    let mouse_data = [0u8; 16];

    let res_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("res"),
        contents: &res_data,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let scl_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("scalars"),
        contents: &scl_data,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let mouse_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("mouse"),
        contents: &mouse_data,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    // 1×1 黑色贴图 ×4 + 最近采样器（通道未真正采样内容即可保证绑定齐全）
    let black = [[0u8, 0, 0, 255]];
    let chan_extent = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 };
    let mut chan_views: Vec<wgpu::TextureView> = Vec::new();
    for i in 0..4u32 {
        let t = device.create_texture_with_data(
            &queue,
            &wgpu::TextureDescriptor {
                label: Some(&format!("channel-black-{i}")),
                size: chan_extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            black.as_flattened(),
        );
        chan_views.push(t.create_view(&wgpu::TextureViewDescriptor::default()));
    }
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("chan"),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        address_mode_w: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Nearest,
        min_filter: wgpu::FilterMode::Nearest,
        mipmap_filter: wgpu::FilterMode::Nearest,
        ..wgpu::SamplerDescriptor::default()
    });

    // —— 显式绑定组布局 ——
    let buf_entry = |b: u32| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(16),
        },
        count: None,
    };
    let mut entries: Vec<wgpu::BindGroupLayoutEntry> = vec![
        buf_entry(BIND_RESOLUTION),
        buf_entry(BIND_SCALARS),
        buf_entry(BIND_MOUSE),
    ];
    for ch in 0..4u32 {
        let b = BIND_CHANNEL_BASE + ch;
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: b,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: b,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        });
    }

    let extras = scan_extra_uniforms(split_version(fragment_source).1)
        .unwrap_or_default();
    for (idx, (_, _, is_sampler)) in extras.iter().enumerate() {
        let b = BIND_EXTRA_BASE + idx as u32;
        entries.push(if *is_sampler {
            wgpu::BindGroupLayoutEntry {
                binding: b,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }
        } else {
            buf_entry(b)
        });
        if *is_sampler {
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: b,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            });
        }
    }

    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("render-bgl"),
        entries: &entries,
    });

    let mut bg_entries: Vec<wgpu::BindGroupEntry> = vec![
        wgpu::BindGroupEntry {
            binding: BIND_RESOLUTION,
            resource: res_buf.as_entire_binding(),
        },
        wgpu::BindGroupEntry {
            binding: BIND_SCALARS,
            resource: scl_buf.as_entire_binding(),
        },
        wgpu::BindGroupEntry {
            binding: BIND_MOUSE,
            resource: mouse_buf.as_entire_binding(),
        },
    ];
    for ch in 0..4u32 {
        let b = BIND_CHANNEL_BASE + ch;
        bg_entries.push(wgpu::BindGroupEntry {
            binding: b,
            resource: wgpu::BindingResource::TextureView(&chan_views[ch as usize]),
        });
        bg_entries.push(wgpu::BindGroupEntry {
            binding: b,
            resource: wgpu::BindingResource::Sampler(&sampler),
        });
    }
    for (idx, (_, _, is_sampler)) in extras.iter().enumerate() {
        let b = BIND_EXTRA_BASE + idx as u32;
        if *is_sampler {
            bg_entries.push(wgpu::BindGroupEntry {
                binding: b,
                resource: wgpu::BindingResource::TextureView(&chan_views[idx % 4]),
            });
            bg_entries.push(wgpu::BindGroupEntry {
                binding: b,
                resource: wgpu::BindingResource::Sampler(&sampler),
            });
        } else {
            bg_entries.push(wgpu::BindGroupEntry {
                binding: b,
                resource: res_buf.as_entire_binding(), // 占位：内容无关紧要
            });
        }
    }
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("render-bg"),
        layout: &bgl,
        entries: &bg_entries,
    });

    // —— shader 模块 ——
    let vert_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("fullscreen-triangle-vs"),
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(
            "@vertex\nfn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {\n    var pos = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));\n    return vec4<f32>(pos[vi], 0.0, 1.0);\n}",
        )),
    });
    let frag_mod = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("user-fragment-glsl"),
        source: wgpu::ShaderSource::Glsl {
            shader: Cow::Owned(source),
            stage: wgpu::naga::ShaderStage::Fragment,
            defines: &[],
        },
    });

    let info = frag_mod.get_compilation_info().await;
    let mut cerrs: Vec<String> = info
        .messages
        .iter()
        .filter(|m| matches!(m.message_type, wgpu::CompilationMessageType::Error))
        .map(|m| match &m.location {
            Some(loc) => format!("第 {} 行第 {} 列: {}", loc.line_number, loc.line_position, m.message),
            None => m.message.clone(),
        })
        .collect();
    cerrs.extend(dyn_errors.lock().map(|g| g.clone()).unwrap_or_default());
    if !cerrs.is_empty() {
        return RenderReport::failure(cerrs, elapsed(start));
    }

    let pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("render-pl"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });

    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("render-pl-line"),
        layout: Some(&pl_layout),
        vertex: wgpu::VertexState {
            module: &vert_mod,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &frag_mod,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    // —— 编码渲染 + 回读 ——
    let bytes_per_row = round_up_align(width * 4, 256);
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: (bytes_per_row * height) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("render-enc"),
    });
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("offscreen-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        extent,
    );
    queue.submit([enc.finish()]);

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), wgpu::BufferAsyncError>>();
    readback.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    if let Err(e) = device.poll(wgpu::PollType::Wait) {
        return RenderReport::failure(vec![format!("GPU 轮询失败：{e}")], elapsed(start));
    }
    let map_ok = rx.recv().map(|r| r.is_ok()).unwrap_or(false);

    if let Ok(mut g) = dyn_errors.lock() {
        cerrs.extend(g.drain(..));
    }
    if !cerrs.is_empty() {
        return RenderReport::failure(cerrs, elapsed(start));
    }
    if !map_ok {
        return RenderReport::failure(vec!["readback 映射失败".to_string()], elapsed(start));
    }

    let (analysis_ok, pixels) = {
        let slice_guard = readback.slice(..).get_mapped_range();
        let mut dense = vec![0u8; (width * height * 4) as usize];
        for row in 0..height {
            let src_off = (row * bytes_per_row) as usize;
            let dst_off = (row * width * 4) as usize;
            dense[dst_off..dst_off + (width * 4) as usize]
                .copy_from_slice(&slice_guard[src_off..src_off + (width * 4) as usize]);
        }
        (true, dense)
    };
    let _ = readback.unmap();

    if !analysis_ok {
        return RenderReport::failure(vec!["帧回读失败".to_string()], elapsed(start));
    }

    let (avg, cov, black, white) = analyze_frame(&pixels, width, height);
    let thumb = encode_thumbnail(&pixels, width, height).ok();

    RenderReport {
        success: true,
        unavailable_reason: None,
        errors: vec![],
        is_black_frame: black,
        is_white_frame: white,
        avg_brightness: avg,
        coverage: cov,
        render_time_ms: elapsed(start),
        thumbnail_base64: thumb,
    }
}

// ===== 模块内单元测试 =====

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyze_flags_black_white_and_coverage() {
        let w = 2u32;
        let h = 2u32;
        let mut px = vec![0u8; 16];

        // 全黑
        assert_eq!(analyze_frame(&px, w, h), (0.0, 0.0, true, false));

        // 半屏白色 → 覆盖率 0.5，均值约 0.5
        for y in 0..h {
            for x in 0..w {
                let off = (((y * w) + x) * 4) as usize;
                if x == 0 {
                    px[off..off + 3].fill(255);
                }
            }
        }
        let (avg, cov, black, white) = analyze_frame(&px, w, h);
        assert!(!black);
        assert!(!white);
        assert!((cov - 0.5).abs() < 1e-6, "cov={cov}");
        assert!((avg - 0.5).abs() < 1e-6, "avg={avg}");

        // 全白
        let allwhite = vec![255u8; 16];
        assert_eq!(analyze_frame(&allwhite, w, h).3, true);
    }

    #[test]
    fn wgpu_wrapper_emits_explicit_bindings_and_dedupes_core() {
        let src = "#version 300 es\nprecision highp float;\nvoid mainImage(out vec4 c, in vec2 fc) {\n    c = vec4(iTime);\n}";
        let w = wrap_fragment_wgpu(src).expect("wrap ok");
        assert!(w.contains("#version 450"));
        assert!(w.contains("binding = 0"));
        assert!(w.contains("float iTime;"), "块成员应保留");
        assert!(w.contains("void main()"));
        assert!(w.contains("mainImage(c, gl_FragCoord.xy)"));

        // 用户自声明的成员不再注入，缺失成员照常补齐
        let own = "uniform float iTime;\nvoid mainImage(out vec4 c, in vec2 fc) { c = vec4(iTime); }";
        let w2 = wrap_fragment_wgpu(own).expect("wrap ok");
        assert!(w2.contains("SLScalars"));
        assert!(!w2.contains("float iTime;\n"), "自供的 iTime 不应再次注入");
        assert!(w2.contains("float iTimeDelta;"), "缺省成员应补齐");
        assert!(w2.contains("SLResolution"), "其余块不受影响");

        // 不支持的类型直接报错而非静默渲染
        let bad = "uniform mat4 mvp;\nvoid mainImage(out vec4 c, in vec2 fc){c=vec4(1);}";
        assert!(wrap_fragment_wgpu(bad).is_err());
    }

    #[test]
    fn thumbnail_respects_max_side() {
        let px = vec![128u8; 512 * 512 * 4];
        let url = encode_thumbnail(&px, 512, 512).expect("encode ok");
        assert!(url.starts_with("data:image/png;base64,"));
        let (_, payload) = url.split_once(',').unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(payload).unwrap();
        let img = image::load_from_memory(&decoded).unwrap();
        assert_eq!(img.width().max(img.height()), THUMB_MAX_SIDE);
    }
}
