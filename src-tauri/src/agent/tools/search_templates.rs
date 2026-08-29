//! M3 模板库检索工具（Rig agent.md §5.1）。
//!
//! 确定性包装层：规划轮由 pipeline 自动调用并注入 prompt，
//! 不走 LLM 工具调用协议。无命中时返回 None 跳过注入。

use crate::templates::registry::{TemplateMatch, TemplateRegistry};
use serde::Serialize;

const PLANNING_LIMIT: usize = 3;

#[derive(Debug, Serialize)]
pub struct SearchOutput {
    pub query: String,
    pub results: Vec<TemplateMatch>,
}

pub fn search_templates(query: &str, category: Option<&str>, limit: usize) -> SearchOutput {
    let results = TemplateRegistry::global().search(query, category, limit);
    SearchOutput {
        query: query.to_string(),
        results,
    }
}

pub fn planning_injection(query: &str) -> Option<String> {
    let out = search_templates(query, None, PLANNING_LIMIT);
    if out.results.is_empty() {
        return None;
    }
    let mut buf =
        String::from("【模板库检索结果】以下是与当前需求关键词匹配的内置模板（按相关度排序）：\n引用到 suggestions 时必须原样保留 name 与 code 字段内容，不要改写或摘要代码。\n");
    for (i, m) in out.results.iter().enumerate() {
        buf.push_str(&format!(
            "\n[{}] {}（分类：{}｜相关度 {:.2}）\n描述：{}\n完整代码：\n```glsl\n{}\n```\n",
            i + 1,
            m.name,
            m.category,
            m.relevance_score,
            m.description,
            m.code
        ));
    }
    Some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injection_contains_full_template_for_known_query() {
        let block =
            planning_injection("\u{661f}\u{7a7a}\u{7c92}\u{5b50}").expect("已知模板名必须命中");
        assert!(block.contains("\u{661f}\u{7a7a}\u{7c92}\u{5b50}"));
        assert!(block.contains("void mainImage(out vec4 fragColor, in vec2 fragCoord)"));
        assert!(block.contains("glsl"));
    }

    #[test]
    fn injection_none_for_gibberish() {
        assert!(planning_injection("zzzqqq111").is_none());
        assert!(planning_injection("").is_none());
    }
}
