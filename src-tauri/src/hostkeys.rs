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
        let path = dirs::config_dir()
            .map(|d| d.join("TermAI").join("known_hosts.json"))
            .unwrap_or_else(|| "known_hosts.json".into());
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            map: Mutex::new(map),
        }
    }

    fn persist(&self, map: &HashMap<String, String>) {
        if let Ok(json) = serde_json::to_string_pretty(map) {
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
