use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MANIFEST_JSON: &str = include_str!("data/manifest.json");

/// 用户模板统一归类，「我的模板」分组据此过滤
pub const USER_CATEGORY: &str = "custom";
pub const USER_SLUG_PREFIX: &str = "user/";

const SCORE_THRESHOLD: f32 = 0.1;
const MAX_NAME_CHARS: usize = 32;
const MAX_CODE_BYTES: usize = 256 * 1024;
const MAIN_IMAGE_SIGNATURE: &str = "void mainImage(out vec4 fragColor, in vec2 fragCoord)";

#[derive(Debug)]
pub enum UserTemplateError {
    NameEmpty,
    NameTooLong { max: usize },
    CodeEmpty,
    CodeTooLarge { max_kb: usize },
    EntryMissing { signature: &'static str },
    UniformDeclared,
    DirectoryCreate(String),
    NameInvalid,
    NameCollision,
    Serialize(String),
    Write(String),
    SlugInvalid { slug: String },
    NotFound,
    Delete(String),
}

/// Persist only locale-neutral difficulty IDs while accepting historical localized values.
pub fn normalize_difficulty_id(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "intermediate" | "进阶" => "intermediate",
        "advanced" | "高级" => "advanced",
        "beginner" | "入门" => "beginner",
        _ => "beginner",
    }
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    slug: String,
    name: String,
    category: String,
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    difficulty: String,
    #[serde(default)]
    uniforms: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    templates: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TemplateMatch {
    pub name: String,
    pub description: String,
    pub category: String,
    pub code: String,
    pub relevance_score: f32,
}

#[derive(Debug, Clone)]
pub struct TemplateEntry {
    pub slug: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub tags: Vec<String>,
    pub difficulty: String,
    pub uniforms: Vec<String>,
    pub code: String,
}

/// 用户模板的落盘 / IPC 载荷结构（slug 与 category 由后端从文件名与固定常量派生）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserTemplateRecord {
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

impl UserTemplateRecord {
    fn into_entry(self, stem: &str) -> TemplateEntry {
        let mut uniforms = self.uniforms;
        if uniforms.is_empty() {
            uniforms = vec!["iTime".to_string(), "iResolution".to_string()];
        }
        TemplateEntry {
            slug: format!("{}{}", USER_SLUG_PREFIX, stem),
            name: self.name,
            category: USER_CATEGORY.to_string(),
            description: self.description,
            tags: self.tags,
            difficulty: normalize_difficulty_id(&self.difficulty).to_string(),
            uniforms,
            code: self.code,
        }
    }
}

pub struct TemplateRegistry {
    templates: Vec<TemplateEntry>,
}

fn embedded_source(slug: &str) -> Option<&'static str> {
    match slug {
        "particles/starfield" => Some(include_str!("data/particles/starfield.glsl")),
        "particles/particle_flame" => Some(include_str!("data/particles/particle_flame.glsl")),
        "particles/blizzard" => Some(include_str!("data/particles/blizzard.glsl")),
        "particles/fireflies" => Some(include_str!("data/particles/fireflies.glsl")),
        "particles/meteor_shower" => Some(include_str!("data/particles/meteor_shower.glsl")),
        "particles/swarm" => Some(include_str!("data/particles/swarm.glsl")),
        "geometry/bouncing_ball" => Some(include_str!("data/geometry/bouncing_ball.glsl")),
        "geometry/sdf_torus" => Some(include_str!("data/geometry/sdf_torus.glsl")),
        "geometry/raymarch_terrain" => Some(include_str!("data/geometry/raymarch_terrain.glsl")),
        "geometry/kaleidoscope" => Some(include_str!("data/geometry/kaleidoscope.glsl")),
        "geometry/mobius_ring" => Some(include_str!("data/geometry/mobius_ring.glsl")),
        "geometry/crystal_cluster" => Some(include_str!("data/geometry/crystal_cluster.glsl")),
        "materials/water_waves" => Some(include_str!("data/materials/water_waves.glsl")),
        "materials/brushed_metal" => Some(include_str!("data/materials/brushed_metal.glsl")),
        "materials/lava_flow" => Some(include_str!("data/materials/lava_flow.glsl")),
        "materials/noise_flame" => Some(include_str!("data/materials/noise_flame.glsl")),
        "materials/silk" => Some(include_str!("data/materials/silk.glsl")),
        "materials/liquid_metal" => Some(include_str!("data/materials/liquid_metal.glsl")),
        "postprocess/vignette" => Some(include_str!("data/postprocess/vignette.glsl")),
        "postprocess/chromatic_aberration" => {
            Some(include_str!("data/postprocess/chromatic_aberration.glsl"))
        }
        "postprocess/scanlines" => Some(include_str!("data/postprocess/scanlines.glsl")),
        "postprocess/pixelate" => Some(include_str!("data/postprocess/pixelate.glsl")),
        "postprocess/film_grain" => Some(include_str!("data/postprocess/film_grain.glsl")),
        "postprocess/fisheye" => Some(include_str!("data/postprocess/fisheye.glsl")),
        "scenes/rainy_street" => Some(include_str!("data/scenes/rainy_street.glsl")),
        "scenes/nebula" => Some(include_str!("data/scenes/nebula.glsl")),
        "scenes/underwater" => Some(include_str!("data/scenes/underwater.glsl")),
        "scenes/sunset_hills" => Some(include_str!("data/scenes/sunset_hills.glsl")),
        "scenes/aurora" => Some(include_str!("data/scenes/aurora.glsl")),
        "scenes/city_night" => Some(include_str!("data/scenes/city_night.glsl")),
        _ => None,
    }
}

// ==================== 用户模板池（app_data_dir/user_templates/*.json）====================
// 写极少读偶发，不设缓存：每次 IPC 直读盘，写完即生效。

pub fn user_templates_dir(base: &Path) -> PathBuf {
    base.join("user_templates")
}

fn is_han(c: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&c)
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || is_han(c) || matches!(c, '-' | '_')
}

/// 名称 → 文件名主干（合法字符保留，其余丢弃/替换；保证跨平台可作文件名）
fn sanitize_file_stem(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if is_name_char(ch) {
            out.push(if ch.is_ascii() {
                ch.to_ascii_lowercase()
            } else {
                ch
            });
        } else if ch.is_whitespace() {
            out.push('-');
        } else if !ch.is_ascii() && !ch.is_control() {
            out.push(ch);
        }
    }
    out.chars().take(MAX_NAME_CHARS).collect()
}

fn validate_user_record(record: &UserTemplateRecord) -> Result<(), UserTemplateError> {
    let name = record.name.trim();
    if name.is_empty() {
        return Err(UserTemplateError::NameEmpty);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(UserTemplateError::NameTooLong {
            max: MAX_NAME_CHARS,
        });
    }
    if record.code.trim().is_empty() {
        return Err(UserTemplateError::CodeEmpty);
    }
    if record.code.len() > MAX_CODE_BYTES {
        return Err(UserTemplateError::CodeTooLarge {
            max_kb: MAX_CODE_BYTES / 1024,
        });
    }
    if !record.code.contains(MAIN_IMAGE_SIGNATURE) {
        return Err(UserTemplateError::EntryMissing {
            signature: MAIN_IMAGE_SIGNATURE,
        });
    }
    // 与内置模板同规：核心 uniform 由预览包装器注入，自声明会引发重定义冲突
    if record.code.contains("uniform ") {
        return Err(UserTemplateError::UniformDeclared);
    }
    Ok(())
}

fn read_entry(path: &Path) -> Option<TemplateEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let record: UserTemplateRecord = serde_json::from_str(&text).ok()?;
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    Some(record.into_entry(&stem))
}

pub fn list_user_entries(base: &Path) -> Vec<TemplateEntry> {
    let dir = user_templates_dir(base);
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<TemplateEntry> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |x| x == "json"))
        .filter_map(|e| read_entry(&e.path()))
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/// 按名称保存（同名覆盖 = 更新，不同名但清洗后同名则追加序号避让）
pub fn save_user_entry(
    base: &Path,
    record: UserTemplateRecord,
) -> Result<TemplateEntry, UserTemplateError> {
    validate_user_record(&record)?;
    let dir = user_templates_dir(base);
    std::fs::create_dir_all(&dir)
        .map_err(|error| UserTemplateError::DirectoryCreate(error.to_string()))?;

    let stem_base = sanitize_file_stem(&record.name);
    if stem_base.is_empty() {
        return Err(UserTemplateError::NameInvalid);
    }

    let name_trimmed = record.name.trim().to_string();
    let mut candidate = stem_base.clone();
    let mut seq = 0u32;
    loop {
        let path = dir.join(format!("{}.json", candidate));
        match std::fs::read_to_string(&path) {
            Ok(existing) => {
                let existing: Option<UserTemplateRecord> = serde_json::from_str(&existing).ok();
                match existing {
                    Some(rec) if rec.name.trim() == name_trimmed => break,
                    _ => {
                        seq += 1;
                        candidate = format!("{}_{}", stem_base, seq);
                    }
                }
            }
            Err(_) => break,
        }
        if seq > 99 {
            return Err(UserTemplateError::NameCollision);
        }
    }

    let entry = record.into_entry(&candidate);
    let path = dir.join(format!("{}.json", candidate));
    let json = serde_json::to_string_pretty(&UserTemplateRecord {
        name: name_trimmed,
        description: entry.description.clone(),
        tags: entry.tags.clone(),
        difficulty: entry.difficulty.clone(),
        uniforms: entry.uniforms.clone(),
        code: entry.code.clone(),
    })
    .map_err(|error| UserTemplateError::Serialize(error.to_string()))?;
    std::fs::write(&path, json)
        .map_err(|error| UserTemplateError::Write(error.to_string()))?;
    Ok(entry)
}

pub fn delete_user_entry(base: &Path, slug: &str) -> Result<(), UserTemplateError> {
    let stem = slug
        .strip_prefix(USER_SLUG_PREFIX)
        .ok_or_else(|| UserTemplateError::SlugInvalid {
            slug: slug.to_string(),
        })?;
    if stem.contains('/') || stem.contains('\\') || stem.contains("..") || stem.trim().is_empty() {
        return Err(UserTemplateError::SlugInvalid {
            slug: slug.to_string(),
        });
    }
    let path = user_templates_dir(base).join(format!("{}.json", stem));
    if !path.exists() {
        return Err(UserTemplateError::NotFound);
    }
    std::fs::remove_file(&path)
        .map_err(|error| UserTemplateError::Delete(error.to_string()))?;
    Ok(())
}

// ==================== 打分与检索 ====================

fn query_units(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut units: Vec<String> = Vec::new();
    let mut word = String::new();

    let flush_word = |w: &mut String, out: &mut Vec<String>| {
        if !w.is_empty() {
            out.push(w.clone());
            w.clear();
        }
    };

    let mut idx = 0;
    while idx < chars.len() {
        let c = chars[idx];
        if c.is_ascii_alphanumeric() {
            word.push(c);
            idx += 1;
        } else if is_han(c) {
            flush_word(&mut word, &mut units);
            let mut run_end = idx;
            while run_end < chars.len() && is_han(chars[run_end]) {
                run_end += 1;
            }
            let run_len = run_end - idx;
            if run_len == 1 {
                units.push(chars[idx].to_string());
            } else {
                for w in idx..run_end - 1 {
                    let mut bg = String::new();
                    bg.push(chars[w]);
                    bg.push(chars[w + 1]);
                    units.push(bg);
                }
            }
            idx = run_end;
        } else {
            flush_word(&mut word, &mut units);
            idx += 1;
        }
    }
    flush_word(&mut word, &mut units);
    // 过短 ASCII 片段（如 ai/m3）极易成为其他英文词的子串（rain ⊃ ai），参与匹配会产生大量伪命中
    units.retain(|u| !(u.is_ascii() && u.chars().count() < 3));
    units
}

/// 命中率分母封顶：长句中的有效关键词不应被口语噪声稀释到阈值之下
const HIT_RATIO_DENOM_CAP: usize = 6;

fn hit_ratio(units: &[String], haystack: &str) -> f32 {
    if units.is_empty() || haystack.is_empty() {
        return 0.0;
    }
    let hay_lower = haystack.to_lowercase();
    let hits = units
        .iter()
        .filter(|u| hay_lower.contains(u.as_str()))
        .count();
    hits as f32 / units.len().min(HIT_RATIO_DENOM_CAP).max(1) as f32
}

fn name_loose_match(t: &TemplateEntry, needle: &str) -> bool {
    needle.contains(t.name.as_str()) || t.name.contains(needle)
}

impl TemplateRegistry {
    fn load() -> Self {
        let manifest: Manifest =
            serde_json::from_str(MANIFEST_JSON).expect("templates manifest.json 解析失败");
        let mut templates = Vec::with_capacity(manifest.templates.len());
        for raw in manifest.templates {
            let code = embedded_source(&raw.slug)
                .unwrap_or_else(|| panic!("模板 glsl 缺失: {}", raw.slug))
                .to_string();
            templates.push(TemplateEntry {
                slug: raw.slug,
                name: raw.name,
                category: raw.category,
                description: raw.description,
                tags: raw.tags,
                difficulty: normalize_difficulty_id(&raw.difficulty).to_string(),
                uniforms: raw.uniforms,
                code,
            });
        }
        Self { templates }
    }

    pub fn global() -> &'static Self {
        static REGISTRY: OnceLock<TemplateRegistry> = OnceLock::new();
        REGISTRY.get_or_init(Self::load)
    }

    pub fn len(&self) -> usize {
        self.templates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }

    /// 仅内置池按名解析（引用返回，零拷贝路径保留给旧调用方）
    pub fn find_by_name(&self, name: &str) -> Option<&TemplateEntry> {
        let needle = name.trim();
        self.templates
            .iter()
            .find(|t| t.name == needle)
            .or_else(|| self.templates.iter().find(|t| name_loose_match(t, needle)))
    }

    /// 双池合并按名解析：精确匹配优先于宽松包含，内置池优先于用户池。
    /// 因可能命中用户池条目（生命周期在磁盘），返回克隆体。
    pub fn resolve_with_user(
        &self,
        name: &str,
        user_pool: &[TemplateEntry],
    ) -> Option<TemplateEntry> {
        let needle = name.trim();
        if needle.is_empty() {
            return None;
        }
        self.templates
            .iter()
            .find(|t| t.name == needle)
            .or_else(|| user_pool.iter().find(|t| t.name == needle))
            .or_else(|| self.templates.iter().find(|t| name_loose_match(t, needle)))
            .or_else(|| user_pool.iter().find(|t| name_loose_match(t, needle)))
            .cloned()
    }

    /// 兼容旧签名的单池检索
    pub fn search(&self, query: &str, category: Option<&str>, limit: usize) -> Vec<TemplateMatch> {
        self.search_in_pools(query, category, limit, &[])
    }

    /// 双池合并语义检索（category = "custom" 时天然只命用户池）
    pub fn search_in_pools(
        &self,
        query: &str,
        category: Option<&str>,
        limit: usize,
        user_pool: &[TemplateEntry],
    ) -> Vec<TemplateMatch> {
        let limit = limit.max(1);
        let units = query_units(query);
        if units.is_empty() {
            return Vec::new();
        }

        let mut scored: Vec<(f32, &TemplateEntry)> = self
            .templates
            .iter()
            .chain(user_pool.iter())
            .filter(|t| category.map_or(true, |cat| t.category == cat))
            .filter_map(|t| {
                let whole_q = query.trim().to_lowercase();
                let name_hit = hit_ratio(&units, &t.name);
                let tag_hit = hit_ratio(&units, &t.tags.join(" "));
                let desc_hit = hit_ratio(&units, &t.description);

                let mut score = name_hit.max(tag_hit * 0.9).max(desc_hit * 0.7);
                if !whole_q.is_empty() && t.name.to_lowercase().contains(&whole_q) {
                    score = 1.0;
                }
                if score > SCORE_THRESHOLD {
                    Some((score.min(1.0), t))
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.name.cmp(&b.1.name))
        });

        scored
            .into_iter()
            .take(limit)
            .map(|(relevance_score, t)| TemplateMatch {
                name: t.name.clone(),
                description: t.description.clone(),
                category: t.category.clone(),
                code: t.code.clone(),
                relevance_score,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_MAIN: &str =
        "void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n    fragColor = vec4(0.5);\n}";

    fn utest_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl_utest_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("创建临时目录失败");
        d
    }

    fn sample_record(name: &str) -> UserTemplateRecord {
        UserTemplateRecord {
            name: name.to_string(),
            description: "测试用模板".to_string(),
            tags: vec!["测试".to_string()],
            difficulty: "beginner".to_string(),
            uniforms: Vec::new(),
            code: SAMPLE_MAIN.to_string(),
        }
    }

    #[test]
    fn loads_all_templates() {
        let reg = TemplateRegistry::global();
        assert_eq!(reg.len(), 30);
        for t in &reg.templates {
            assert!(
                t.code
                    .contains("void mainImage(out vec4 fragColor, in vec2 fragCoord)"),
                "{} 缺少入口签名",
                t.slug
            );
            assert!(
                !t.code.contains("uniform "),
                "{} 自声明了 uniform: {:?}",
                t.slug,
                t.uniforms
            );
        }
    }

    #[test]
    fn all_templates_pass_glslang_validation() {
        let reg = TemplateRegistry::global();
        for t in &reg.templates {
            let report = crate::agent::tools::compile_glsl::validate_shader(&t.code, None);
            assert!(
                report.success,
                "{} glslang 校验未通过: {:?}",
                t.slug, report.errors
            );
        }
    }

    #[test]
    fn chinese_query_hits_starfield_first() {
        let reg = TemplateRegistry::global();
        let hits = reg.search("星空", None, 3);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].name, "星空粒子");
        assert_eq!(hits[0].category, "particles");
        assert_eq!(hits[0].relevance_score, 1.0);
    }

    #[test]
    fn english_tag_and_case_insensitive() {
        let reg = TemplateRegistry::global();
        let hits = reg.search("Flame", None, 3);
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert!(
            names.contains(&"粒子火焰") || names.contains(&"噪声火舌"),
            "english 'flame' miss: {:?}",
            names
        );
    }

    #[test]
    fn category_filter_restricts_pool() {
        let reg = TemplateRegistry::global();
        let hits = reg.search("扫描线", Some("postprocess"), 10);
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h.category == "postprocess"));
    }

    #[test]
    fn empty_query_returns_nothing() {
        let reg = TemplateRegistry::global();
        assert!(reg.search("", None, 3).is_empty());
        assert!(reg.search("   ", None, 3).is_empty());
    }

    #[test]
    fn limit_caps_results() {
        let reg = TemplateRegistry::global();
        let hits = reg.search("复古", None, 2);
        assert!(hits.len() <= 2);
    }

    #[test]
    fn find_by_name_resolves_selection() {
        let reg = TemplateRegistry::global();
        assert!(reg.find_by_name("星空粒子").is_some());
        assert!(reg.find_by_name("我想用星空粒子那个").is_some());
        assert!(reg.find_by_name("不存在的！").is_none());
    }

    #[test]
    fn user_pool_save_list_update_delete_roundtrip() {
        let base = utest_dir("roundtrip");
        let saved = save_user_entry(&base, sample_record("测试霓虹")).unwrap();
        assert_eq!(saved.slug, "user/测试霓虹");
        assert_eq!(saved.category, USER_CATEGORY);

        let pool = list_user_entries(&base);
        assert_eq!(pool.len(), 1);
        assert_eq!(pool[0].name, "测试霓虹");
        assert_eq!(pool[0].slug, "user/测试霓虹");
        assert_eq!(pool[0].uniforms, vec!["iTime", "iResolution"]);

        let updated = save_user_entry(&base, sample_record("测试霓虹")).unwrap();
        assert_eq!(updated.slug, "user/测试霓虹");
        assert_eq!(list_user_entries(&base).len(), 1);

        delete_user_entry(&base, "user/测试霓虹").unwrap();
        assert!(list_user_entries(&base).is_empty());
        assert!(delete_user_entry(&base, "user/测试霓虹").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn user_pool_rejects_invalid_records() {
        let base = utest_dir("invalid");
        let mut rec = sample_record("非法 uniform");
        rec.code = "uniform float t;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n    fragColor = vec4(0.5);\n}".to_string();
        assert!(save_user_entry(&base, rec).is_err());

        let mut rec = sample_record("缺入口");
        rec.code = "void notMain()\n{\n}".to_string();
        assert!(save_user_entry(&base, rec).is_err());

        let rec = sample_record("   ");
        assert!(save_user_entry(&base, rec).is_err());

        assert!(list_user_entries(&base).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn merged_resolve_prefers_exact_and_builtin_first() {
        let reg = TemplateRegistry::global();
        let base = utest_dir("resolve");

        let user_starfield = sample_record("星空定制");
        save_user_entry(&base, user_starfield).unwrap();
        let pool = list_user_entries(&base);

        let hit = reg.resolve_with_user("星空定制", &pool).unwrap();
        assert_eq!(hit.slug, "user/星空定制");
        assert_eq!(hit.category, USER_CATEGORY);

        let builtin = reg.resolve_with_user("星空粒子", &pool).unwrap();
        assert_eq!(builtin.slug, "particles/starfield");

        assert!(reg.resolve_with_user("", &pool).is_none());
        assert!(reg.resolve_with_user("彻底不存在", &pool).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn merged_search_hits_custom_category() {
        let reg = TemplateRegistry::global();
        let base = utest_dir("search");

        save_user_entry(&base, sample_record("霓虹隧道")).unwrap();
        let pool = list_user_entries(&base);

        let hits = reg.search_in_pools("霓虹", None, 10, &pool);
        assert!(hits
            .iter()
            .any(|h| h.name == "霓虹隧道" && h.category == USER_CATEGORY));

        let customs = reg.search_in_pools("隧道", Some(USER_CATEGORY), 10, &pool);
        assert_eq!(customs.len(), 1);
        assert_eq!(customs[0].code, SAMPLE_MAIN);

        let builtin_only = reg.search_in_pools("霓虹", None, 30, &[]);
        assert!(builtin_only.iter().all(|h| h.category != USER_CATEGORY));

        let _ = std::fs::remove_dir_all(&base);
    }
}
