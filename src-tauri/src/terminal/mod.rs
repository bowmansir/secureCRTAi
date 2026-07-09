pub mod local;
pub mod ssh;

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 推送给前端某个终端标签页的事件流。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    Data { bytes: Vec<u8> },
    Connected,
    Exit { message: Option<String> },
}

/// 终端会话的统一控制句柄，本地 PTY 与 SSH 各自实现。
pub trait TermSession: Send + Sync {
    fn write(&self, data: &[u8]) -> anyhow::Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()>;
    fn close(&self);
}

#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, Arc<dyn TermSession>>>,
}

impl TerminalRegistry {
    pub fn insert(&self, id: String, session: Arc<dyn TermSession>) {
        self.sessions.lock().insert(id, session);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn TermSession>> {
        self.sessions.lock().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<dyn TermSession>> {
        self.sessions.lock().remove(id)
    }
}
