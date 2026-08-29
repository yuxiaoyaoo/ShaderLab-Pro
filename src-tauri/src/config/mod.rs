use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const CONFIG_FILE_NAME: &str = "shaderlab_agent_config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        AgentConfig {
            api_key: String::new(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            temperature: 0.7,
            max_tokens: 4096,
        }
    }
}

impl AgentConfig {
    pub fn is_configured(&self) -> bool {
        !self.api_key.trim().is_empty() && !self.model.trim().is_empty()
    }

    pub fn api_key_hint(&self) -> Option<String> {
        let key = self.api_key.trim();
        if key.len() <= 8 {
            return None;
        }
        Some(format!("{}****{}", &key[..4], &key[key.len() - 4..]))
    }

    fn path(dir: &Path) -> PathBuf {
        dir.join(CONFIG_FILE_NAME)
    }

    pub fn load(dir: &Path) -> Option<AgentConfig> {
        let text = std::fs::read_to_string(Self::path(dir)).ok()?;
        let mut cfg = serde_json::from_str::<AgentConfig>(&text).ok()?;
        if cfg.base_url.trim().is_empty() {
            cfg.base_url = AgentConfig::default().base_url;
        }
        Some(cfg)
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(Self::path(dir), json).map_err(|e| format!("写入配置失败: {}", e))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentConfigView {
    pub configured: bool,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub api_key_hint: Option<String>,
    /// M6d：服务商预设清单随视图下发，前端下拉联动 base_url 与模型推荐列表
    pub presets: Vec<ProviderPreset>,
}

/// M6d：多模型服务商预设——全部为编译期常量，`models[0]` 即该服务商默认模型。
/// 兼容 OpenAI Chat Completions 协议；`local` 服务商仅作提示用（Key 填任意占位符即可通过校验）。
#[derive(Debug, Clone, Serialize)]
pub struct ProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub models: &'static [&'static str],
    pub local: bool,
}

pub const PROVIDER_PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "openai",
        label: "OpenAI",
        base_url: "https://api.openai.com/v1",
        models: &[
            "gpt-4o-mini",
            "gpt-4o",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano",
            "o4-mini",
        ],
        local: false,
    },
    ProviderPreset {
        id: "deepseek",
        label: "DeepSeek（深度求索）",
        base_url: "https://api.deepseek.com/v1",
        models: &["deepseek-chat", "deepseek-reasoner"],
        local: false,
    },
    ProviderPreset {
        id: "dashscope",
        label: "通义千问（兼容模式）",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: &["qwen-max", "qwen-plus", "qwen-turbo", "qwen-coder-plus"],
        local: false,
    },
    ProviderPreset {
        id: "moonshot",
        label: "Kimi（月之暗面）",
        base_url: "https://api.moonshot.cn/v1",
        models: &[
            "moonshot-v1-8k",
            "moonshot-v1-32k",
            "moonshot-v1-128k",
            "kimi-latest",
        ],
        local: false,
    },
    ProviderPreset {
        id: "ollama",
        label: "Ollama（本地）",
        base_url: "http://127.0.0.1:11434/v1",
        models: &["qwen2.5", "llama3.1", "deepseek-r1", "phi4"],
        local: true,
    },
    ProviderPreset {
        id: "lmstudio",
        label: "LM Studio（本地）",
        base_url: "http://127.0.0.1:1234/v1",
        models: &["local-model"],
        local: true,
    },
];

impl AgentConfig {
    /// M6d：按 base_url 反查匹配的服务商预设（忽略末尾斜杠差异）
    pub fn match_preset<'a>(&self, presets: &'a [ProviderPreset]) -> Option<&'a ProviderPreset> {
        let cur = self.base_url.trim().trim_end_matches('/');
        presets.iter().find(|p| p.base_url == cur)
    }
}

#[cfg(test)]
mod preset_tests {
    use super::*;

    #[test]
    fn presets_are_unique_and_well_formed() {
        let mut ids = std::collections::HashSet::new();
        for p in PROVIDER_PRESETS {
            assert!(!ids.contains(&p.id), "重复的预设 id：{}", p.id);
            ids.insert(p.id);
            assert!(
                p.base_url.starts_with("http"),
                "非法 base_url：{}",
                p.base_url
            );
            assert_eq!(
                p.base_url.trim_end_matches('/'),
                p.base_url,
                "base_url 不应以斜杠结尾：{}",
                p.base_url
            );
            assert!(!p.models.is_empty(), "{} 缺少模型推荐列表", p.id);
        }
        assert!(
            PROVIDER_PRESETS.iter().filter(|p| p.local).count() >= 2,
            "至少应包含两个本地服务商"
        );
    }

    #[test]
    fn match_preset_ignores_trailing_slash() {
        let cfg = AgentConfig::default();
        assert_eq!(
            cfg.match_preset(PROVIDER_PRESETS).map(|p| p.id),
            Some("openai")
        );

        let deepseek = AgentConfig {
            base_url: "https://api.deepseek.com/v1/".to_string(),
            ..AgentConfig::default()
        };
        assert_eq!(
            deepseek.match_preset(PROVIDER_PRESETS).map(|p| p.id),
            Some("deepseek")
        );

        let unknown = AgentConfig {
            base_url: "https://example.com/api".to_string(),
            ..AgentConfig::default()
        };
        assert!(unknown.match_preset(PROVIDER_PRESETS).is_none());
    }

    #[test]
    fn view_carries_presets() {
        let cfg = AgentConfig::default();
        let view = AgentConfigView {
            configured: cfg.is_configured(),
            base_url: cfg.base_url.clone(),
            model: cfg.model.clone(),
            temperature: cfg.temperature,
            max_tokens: cfg.max_tokens,
            api_key_hint: cfg.api_key_hint(),
            presets: PROVIDER_PRESETS.to_vec(),
        };
        let json = serde_json::to_value(&view).expect("序列化视图");
        let arr = json
            .get("presets")
            .and_then(|v| v.as_array())
            .expect("presets 数组");
        assert_eq!(arr.len(), PROVIDER_PRESETS.len());
        let first = &arr[0];
        assert!(first.get("id").and_then(|v| v.as_str()).is_some());
        assert!(first.get("models").and_then(|v| v.as_array()).is_some());
    }
}
