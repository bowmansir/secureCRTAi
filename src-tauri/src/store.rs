//! 会话配置与 AI Provider 配置的持久化。密码/API Key 只存 vault 加密后的密文。

use crate::vault;
use anyhow::Context;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------- 数据模型 ----------

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key"
    pub auth_type: String,
    #[serde(default)]
    pub password_enc: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub key_passphrase_enc: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub name: String,
    /// "anthropic" | "openai" | "ollama"
    pub kind: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_enc: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemePreferences {
    pub color_theme: String,
    #[serde(default)]
    pub background_theme_id: Option<String>,
}

impl Default for ThemePreferences {
    fn default() -> Self {
        Self {
            color_theme: "dark".to_string(),
            background_theme_id: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    #[serde(default)]
    sessions: Vec<SessionProfile>,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    snippets: Vec<Snippet>,
    #[serde(default)]
    ai_providers: Vec<AiProviderConfig>,
    #[serde(default)]
    active_provider: Option<String>,
    #[serde(default)]
    theme_preferences: Option<ThemePreferences>,
}

// ---------- 存储实现 ----------

pub struct Store {
    path: PathBuf,
    data: Mutex<StoreFile>,
}

impl Store {
    pub fn load() -> anyhow::Result<Self> {
        let config_root = dirs::config_dir().context("无法定位配置目录")?;
        Self::load_from_config_root(&config_root)
    }

    fn load_from_config_root(config_root: &std::path::Path) -> anyhow::Result<Self> {
        let dir = config_root.join("Termexa");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("store.json");
        let data = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default()
        } else {
            let legacy_path = config_root.join("TermAI").join("store.json");
            match std::fs::read_to_string(&legacy_path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(data) => {
                        std::fs::write(&path, content).context("迁移旧版配置到 Termexa 失败")?;
                        data
                    }
                    Err(_) => StoreFile::default(),
                },
                Err(_) => StoreFile::default(),
            }
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    fn persist(&self, data: &StoreFile) -> anyhow::Result<()> {
        let json = serde_json::to_string_pretty(data)?;
        std::fs::write(&self.path, json).context("写入配置文件失败")?;
        Ok(())
    }

    // ----- 会话 -----

    pub fn sessions(&self) -> Vec<SessionProfile> {
        self.data.lock().sessions.clone()
    }

    pub fn get_session(&self, id: &str) -> Option<SessionProfile> {
        self.data
            .lock()
            .sessions
            .iter()
            .find(|s| s.id == id)
            .cloned()
    }

    pub fn upsert_session(&self, profile: SessionProfile) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        match data.sessions.iter_mut().find(|s| s.id == profile.id) {
            Some(slot) => *slot = profile,
            None => data.sessions.push(profile),
        }
        self.persist(&data)
    }

    pub fn delete_session(&self, id: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        data.sessions.retain(|s| s.id != id);
        self.persist(&data)
    }

    // ----- 命令片段 -----

    pub fn snippets(&self) -> Vec<Snippet> {
        self.data.lock().snippets.clone()
    }

    pub fn upsert_snippet(&self, s: Snippet) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        match data.snippets.iter_mut().find(|x| x.id == s.id) {
            Some(slot) => *slot = s,
            None => data.snippets.push(s),
        }
        self.persist(&data)
    }

    pub fn delete_snippet(&self, id: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        data.snippets.retain(|x| x.id != id);
        self.persist(&data)
    }

    // ----- 分组 -----

    /// 已保存分组与会话上出现过的分组的并集
    pub fn groups(&self) -> Vec<String> {
        let data = self.data.lock();
        let mut out: Vec<String> = data.groups.clone();
        for s in &data.sessions {
            if !s.group.is_empty() && !out.contains(&s.group) {
                out.push(s.group.clone());
            }
        }
        out.sort();
        out
    }

    pub fn group_add(&self, name: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        if !data.groups.contains(&name.to_string()) {
            data.groups.push(name.to_string());
        }
        self.persist(&data)
    }

    /// 重命名分组，并同步更新其中会话
    pub fn group_rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        data.groups.retain(|g| g != from);
        if !data.groups.contains(&to.to_string()) {
            data.groups.push(to.to_string());
        }
        for s in data.sessions.iter_mut() {
            if s.group == from {
                s.group = to.to_string();
            }
        }
        self.persist(&data)
    }

    /// 删除分组，其中会话移回未分组
    pub fn group_delete(&self, name: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        data.groups.retain(|g| g != name);
        for s in data.sessions.iter_mut() {
            if s.group == name {
                s.group = String::new();
            }
        }
        self.persist(&data)
    }

    /// 移动会话到分组（不触碰凭据字段）
    pub fn session_set_group(&self, id: &str, group: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        if !group.is_empty() && !data.groups.contains(&group.to_string()) {
            data.groups.push(group.to_string());
        }
        if let Some(s) = data.sessions.iter_mut().find(|s| s.id == id) {
            s.group = group.to_string();
        }
        self.persist(&data)
    }

    // ----- AI Provider -----

    pub fn providers(&self) -> (Vec<AiProviderConfig>, Option<String>) {
        let data = self.data.lock();
        (data.ai_providers.clone(), data.active_provider.clone())
    }

    pub fn get_provider(&self, id: &str) -> Option<AiProviderConfig> {
        self.data
            .lock()
            .ai_providers
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    pub fn upsert_provider(&self, cfg: AiProviderConfig) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        match data.ai_providers.iter_mut().find(|p| p.id == cfg.id) {
            Some(slot) => *slot = cfg,
            None => data.ai_providers.push(cfg),
        }
        if data.active_provider.is_none() {
            data.active_provider = data.ai_providers.first().map(|p| p.id.clone());
        }
        self.persist(&data)
    }

    pub fn delete_provider(&self, id: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        data.ai_providers.retain(|p| p.id != id);
        if data.active_provider.as_deref() == Some(id) {
            data.active_provider = data.ai_providers.first().map(|p| p.id.clone());
        }
        self.persist(&data)
    }

    pub fn set_active_provider(&self, id: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock();
        data.active_provider = Some(id.to_string());
        self.persist(&data)
    }

    pub fn active_provider(&self) -> Option<AiProviderConfig> {
        let data = self.data.lock();
        let id = data.active_provider.clone()?;
        data.ai_providers.iter().find(|p| p.id == id).cloned()
    }

    // ----- 主题偏好 -----

    pub fn theme_preferences(&self) -> Option<ThemePreferences> {
        self.data.lock().theme_preferences.clone()
    }

    pub fn set_color_theme(&self, color_theme: &str) -> anyhow::Result<ThemePreferences> {
        if !matches!(color_theme, "dark" | "midnight" | "light") {
            anyhow::bail!("未知的颜色主题");
        }
        let mut data = self.data.lock();
        let preferences = data
            .theme_preferences
            .get_or_insert_with(ThemePreferences::default);
        preferences.color_theme = color_theme.to_string();
        let result = preferences.clone();
        self.persist(&data)?;
        Ok(result)
    }

    pub fn set_background_theme(
        &self,
        background_theme_id: Option<String>,
    ) -> anyhow::Result<ThemePreferences> {
        if background_theme_id
            .as_deref()
            .is_some_and(|theme_id| theme_id.trim().is_empty() || theme_id.len() > 256)
        {
            anyhow::bail!("图片主题 ID 无效");
        }
        let mut data = self.data.lock();
        let preferences = data
            .theme_preferences
            .get_or_insert_with(ThemePreferences::default);
        preferences.background_theme_id = background_theme_id;
        let result = preferences.clone();
        self.persist(&data)?;
        Ok(result)
    }
}

/// 把会话中的加密密码解出来（仅在建立连接的瞬间使用，不回传前端）。
pub fn decrypt_optional(enc: &Option<String>) -> anyhow::Result<Option<String>> {
    match enc {
        Some(e) if !e.is_empty() => Ok(Some(vault::decrypt(e)?)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{Store, StoreFile};
    use parking_lot::Mutex;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn test_store() -> (Store, PathBuf) {
        let path = std::env::temp_dir().join(format!("termexa-store-{}.json", Uuid::new_v4()));
        (
            Store {
                path: path.clone(),
                data: Mutex::new(StoreFile::default()),
            },
            path,
        )
    }

    #[test]
    fn theme_preferences_are_written_to_and_restored_from_the_config_file() {
        let (store, path) = test_store();
        store.set_color_theme("midnight").unwrap();
        store
            .set_background_theme(Some("published-theme".to_string()))
            .unwrap();

        let saved: StoreFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let restored = Store {
            path: path.clone(),
            data: Mutex::new(saved),
        };
        let preferences = restored.theme_preferences().unwrap();
        assert_eq!(preferences.color_theme, "midnight");
        assert_eq!(
            preferences.background_theme_id.as_deref(),
            Some("published-theme")
        );

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn theme_preference_updates_preserve_the_other_selection() {
        let (store, path) = test_store();
        store
            .set_background_theme(Some("dark-art".to_string()))
            .unwrap();
        let preferences = store.set_color_theme("light").unwrap();
        assert_eq!(preferences.color_theme, "light");
        assert_eq!(preferences.background_theme_id.as_deref(), Some("dark-art"));

        let preferences = store.set_background_theme(None).unwrap();
        assert_eq!(preferences.color_theme, "light");
        assert_eq!(preferences.background_theme_id, None);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_theme_preferences_are_rejected_without_creating_a_config_file() {
        let (store, path) = test_store();
        assert!(store.set_color_theme("unknown").is_err());
        assert!(store.set_background_theme(Some(String::new())).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn legacy_brand_config_is_migrated_without_losing_preferences() {
        let root = std::env::temp_dir().join(format!("termexa-migrate-{}", Uuid::new_v4()));
        let legacy_dir = root.join("TermAI");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("store.json"),
            r#"{"groups":["production"],"themePreferences":{"colorTheme":"midnight","backgroundThemeId":"theme-1"}}"#,
        )
        .unwrap();

        let store = Store::load_from_config_root(&root).unwrap();
        assert_eq!(store.data.lock().groups, vec!["production"]);
        assert_eq!(
            store
                .theme_preferences()
                .and_then(|preferences| preferences.background_theme_id),
            Some("theme-1".to_string())
        );
        assert!(root.join("Termexa").join("store.json").exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_brand_config_is_never_overwritten_by_legacy_data() {
        let root = std::env::temp_dir().join(format!("termexa-current-{}", Uuid::new_v4()));
        let legacy_dir = root.join("TermAI");
        let current_dir = root.join("Termexa");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::create_dir_all(&current_dir).unwrap();
        std::fs::write(legacy_dir.join("store.json"), r#"{"groups":["legacy"]}"#).unwrap();
        std::fs::write(current_dir.join("store.json"), r#"{"groups":["current"]}"#).unwrap();

        let store = Store::load_from_config_root(&root).unwrap();
        assert_eq!(store.data.lock().groups, vec!["current"]);

        std::fs::remove_dir_all(root).unwrap();
    }
}
