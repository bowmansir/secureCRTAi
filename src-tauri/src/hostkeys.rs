//! SSH 主机密钥库（known_hosts）：首次连接记录公钥，之后必须一致，否则拒绝。
//! 够用即可，不做交互式指纹确认。

use parking_lot::Mutex;
use std::collections::HashMap;

#[derive(Default)]
pub struct HostKeyStore {
    path: std::path::PathBuf,
    /// "host:port" -> OpenSSH 公钥串
    map: Mutex<HashMap<String, String>>,
}

fn key_of(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

impl HostKeyStore {
    pub fn load() -> Self {
        let Some(config_root) = dirs::config_dir() else {
            return Self::load_from_paths("known_hosts.json".into(), None);
        };
        Self::load_from_paths(
            config_root.join("Termexa").join("known_hosts.json"),
            Some(config_root.join("TermAI").join("known_hosts.json")),
        )
    }

    fn load_from_paths(path: std::path::PathBuf, legacy_path: Option<std::path::PathBuf>) -> Self {
        let current = std::fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok());
        let migrated = if current.is_none() && !path.exists() {
            legacy_path
                .as_ref()
                .and_then(|legacy| std::fs::read_to_string(legacy).ok())
                .and_then(|content| {
                    serde_json::from_str::<HashMap<String, String>>(&content)
                        .ok()
                        .map(|map| (content, map))
                })
        } else {
            None
        };
        let map = current
            .or_else(|| migrated.as_ref().map(|(_, map)| map.clone()))
            .unwrap_or_default();
        if let Some((content, _)) = migrated {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&path, content);
        }
        Self {
            path,
            map: Mutex::new(map),
        }
    }

    fn persist(&self, map: &HashMap<String, String>) {
        if let Ok(json) = serde_json::to_string_pretty(map) {
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&self.path, json);
        }
    }

    pub fn get(&self, host: &str, port: u16) -> Option<String> {
        self.map.lock().get(&key_of(host, port)).cloned()
    }

    pub fn save(&self, host: &str, port: u16, openssh_key: &str) {
        let mut map = self.map.lock();
        map.insert(key_of(host, port), openssh_key.to_string());
        self.persist(&map);
    }
}

#[cfg(test)]
mod tests {
    use super::HostKeyStore;
    use uuid::Uuid;

    #[test]
    fn legacy_host_keys_are_migrated_to_the_current_brand_directory() {
        let root = std::env::temp_dir().join(format!("termexa-hostkeys-{}", Uuid::new_v4()));
        let legacy = root.join("TermAI").join("known_hosts.json");
        let current = root.join("Termexa").join("known_hosts.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, r#"{"server.example:22":"ssh-ed25519 legacy-key"}"#).unwrap();

        let store = HostKeyStore::load_from_paths(current.clone(), Some(legacy));
        assert_eq!(
            store.get("server.example", 22).as_deref(),
            Some("ssh-ed25519 legacy-key")
        );
        assert!(current.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_host_keys_take_precedence_over_legacy_data() {
        let root =
            std::env::temp_dir().join(format!("termexa-hostkeys-current-{}", Uuid::new_v4()));
        let legacy = root.join("TermAI").join("known_hosts.json");
        let current = root.join("Termexa").join("known_hosts.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&legacy, r#"{"server.example:22":"legacy"}"#).unwrap();
        std::fs::write(&current, r#"{"server.example:22":"current"}"#).unwrap();

        let store = HostKeyStore::load_from_paths(current, Some(legacy));
        assert_eq!(store.get("server.example", 22).as_deref(), Some("current"));

        std::fs::remove_dir_all(root).unwrap();
    }
}
