//! Agent A+ 执行通道：一条常驻 SSH shell，程序化发命令、sentinel 精确捕获输出。
//! 打开时清空 PS1、关闭回显，让输出只含命令实际结果，状态（cd/环境）跨命令保留。

use crate::hostkeys::HostKeyStore;
use crate::terminal::ssh::{connect_and_auth, SshParams};
use anyhow::anyhow;
use parking_lot::Mutex;
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep, Duration};

const AGENT_RUN_TIMEOUT: Duration = Duration::from_secs(30);
const AGENT_INTERRUPT_GRACE: Duration = Duration::from_secs(3);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub output: String,
    pub exit_code: Option<i32>,
}

enum AgentCmd {
    Run {
        command: String,
        reply: oneshot::Sender<anyhow::Result<AgentRunResult>>,
    },
    Close,
}

pub struct AgentSession {
    tx: mpsc::UnboundedSender<AgentCmd>,
}

impl AgentSession {
    pub async fn run(&self, command: String) -> anyhow::Result<AgentRunResult> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(AgentCmd::Run { command, reply })
            .map_err(|_| anyhow!("Agent 通道已关闭"))?;
        rx.await.map_err(|_| anyhow!("Agent 执行无响应"))?
    }

    pub fn close(&self) {
        let _ = self.tx.send(AgentCmd::Close);
    }
}

#[derive(Default)]
pub struct AgentRegistry {
    sessions: Mutex<HashMap<String, Arc<AgentSession>>>,
}

impl AgentRegistry {
    pub fn insert(&self, id: String, s: Arc<AgentSession>) {
        self.sessions.lock().insert(id, s);
    }
    pub fn get(&self, id: &str) -> Option<Arc<AgentSession>> {
        self.sessions.lock().get(id).cloned()
    }
    pub fn remove(&self, id: &str) -> Option<Arc<AgentSession>> {
        self.sessions.lock().remove(id)
    }
}

/// 去除 ANSI 转义序列（按字节，保留 UTF-8）
fn strip_ansi(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0x1b {
            if i + 1 < data.len() && data[i + 1] == b'[' {
                // CSI: ESC [ ... 字母
                i += 2;
                while i < data.len() && !(data[i] as char).is_ascii_alphabetic() {
                    i += 1;
                }
                if i < data.len() {
                    i += 1;
                }
                continue;
            }
            if i + 1 < data.len() && data[i + 1] == b']' {
                // OSC: ESC ] ... (BEL 或 ESC \) —— 如设置终端标题
                i += 2;
                while i < data.len() && data[i] != 0x07 {
                    if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'\\' {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                if i < data.len() {
                    i += 1;
                }
                continue;
            }
            i += 1;
            continue;
        }
        // 丢弃回车与孤立 BEL 等控制符，保留 \n \t
        if data[i] == b'\r' || data[i] == 0x07 {
            i += 1;
            continue;
        }
        out.push(data[i]);
        i += 1;
    }
    out
}

/// 在文本里查找 `marker<数字>`（数字后须为行尾/换行，排除命令回显行），返回 (位置, 退出码)
fn find_marker(s: &str, marker: &str) -> Option<(usize, i32)> {
    let mut start = 0;
    while let Some(pos) = s[start..].find(marker) {
        let abs = start + pos;
        let after = &s[abs + marker.len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        let rest = &after[digits.len()..];
        if !digits.is_empty() && (rest.is_empty() || rest.starts_with('\n')) {
            return Some((abs, digits.parse().unwrap_or(-1)));
        }
        start = abs + marker.len();
    }
    None
}

fn gen_marker(tag: &str) -> String {
    format!("__TERMAI_{tag}_{}__", uuid::Uuid::new_v4().simple())
}

fn append_agent_note(output: String, note: &str) -> String {
    if output.trim().is_empty() {
        note.to_string()
    } else {
        format!("{}\n\n{}", output.trim(), note)
    }
}

pub async fn open(
    store: Arc<HostKeyStore>,
    params: SshParams,
) -> anyhow::Result<Arc<AgentSession>> {
    let handle = connect_and_auth(store, &params).await?;
    let mut channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", 240, 60, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<AgentCmd>();

    tauri::async_runtime::spawn(async move {
        let _handle = handle;

        // 初始化：清空提示符、关闭回显，读到 init marker 丢弃登录 banner
        let init = gen_marker("INIT");
        // 末尾 $? 让 find_marker（要求 marker 后跟数字）能匹配到真正的输出行，
        // 而命令回显行里的 "{init}$?" 因 $? 非数字不会误匹配
        let init_cmd =
            format!("export PS1=''; unset PROMPT_COMMAND; stty -echo 2>/dev/null; echo {init}$?\n");
        if channel.data(init_cmd.as_bytes()).await.is_err() {
            return;
        }
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    buf.extend_from_slice(&data);
                    let stripped = strip_ansi(&buf);
                    let s = String::from_utf8_lossy(&stripped);
                    if find_marker(&s, &init).is_some() {
                        break;
                    }
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => buf.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => return,
                _ => {}
            }
        }

        // 主循环：请求-响应式执行
        loop {
            match rx.recv().await {
                Some(AgentCmd::Run { command, reply }) => {
                    let marker = gen_marker("END");
                    let payload = format!("{command}\necho {marker}$?\n");
                    if channel.data(payload.as_bytes()).await.is_err() {
                        let _ = reply.send(Err(anyhow!("写入 Agent 通道失败")));
                        break;
                    }
                    let mut close_channel = false;
                    let mut rbuf: Vec<u8> = Vec::new();
                    let run_timeout = sleep(AGENT_RUN_TIMEOUT);
                    tokio::pin!(run_timeout);

                    let result = loop {
                        tokio::select! {
                            _ = &mut run_timeout => {
                                let cleanup_marker = gen_marker("INT");
                                let _ = channel.data(&[3u8][..]).await;
                                let cleanup_cmd = format!("\necho {cleanup_marker}$?\n");
                                let _ = channel.data(cleanup_cmd.as_bytes()).await;

                                let cleanup_timeout = sleep(AGENT_INTERRUPT_GRACE);
                                tokio::pin!(cleanup_timeout);
                                let recovered_output = loop {
                                    tokio::select! {
                                        _ = &mut cleanup_timeout => {
                                            close_channel = true;
                                            let s = String::from_utf8_lossy(&strip_ansi(&rbuf)).trim().to_string();
                                            break s;
                                        }
                                        msg = channel.wait() => {
                                            match msg {
                                                Some(ChannelMsg::Data { data }) => {
                                                    rbuf.extend_from_slice(&data);
                                                    let s = String::from_utf8_lossy(&strip_ansi(&rbuf)).to_string();
                                                    if let Some((pos, _code)) = find_marker(&s, &cleanup_marker) {
                                                        break s[..pos].trim_matches(['\n', ' ', '\t']).to_string();
                                                    }
                                                }
                                                Some(ChannelMsg::ExtendedData { data, .. }) => {
                                                    rbuf.extend_from_slice(&data);
                                                }
                                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                                    close_channel = true;
                                                    let s = String::from_utf8_lossy(&strip_ansi(&rbuf)).trim().to_string();
                                                    break s;
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                };

                                let note = if close_channel {
                                    "Agent 命令超过 30 秒，已自动中断并关闭执行通道。"
                                } else {
                                    "Agent 命令超过 30 秒，已自动中断。"
                                };
                                break Ok(AgentRunResult {
                                    output: append_agent_note(recovered_output, note),
                                    exit_code: None,
                                });
                            }
                            msg = channel.wait() => {
                                match msg {
                                    Some(ChannelMsg::Data { data }) => {
                                        rbuf.extend_from_slice(&data);
                                        let s = String::from_utf8_lossy(&strip_ansi(&rbuf)).to_string();
                                        if let Some((pos, code)) = find_marker(&s, &marker) {
                                            let output = s[..pos].trim_matches(['\n', ' ', '\t']).to_string();
                                            break Ok(AgentRunResult {
                                                output,
                                                exit_code: Some(code),
                                            });
                                        }
                                    }
                                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                                        rbuf.extend_from_slice(&data);
                                    }
                                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                        close_channel = true;
                                        let s = String::from_utf8_lossy(&strip_ansi(&rbuf))
                                            .trim()
                                            .to_string();
                                        break Ok(AgentRunResult {
                                            output: s,
                                            exit_code: None,
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                    };
                    let _ = reply.send(result);
                    if close_channel {
                        let _ = channel.eof().await;
                        break;
                    }
                }
                Some(AgentCmd::Close) | None => {
                    let _ = channel.eof().await;
                    break;
                }
            }
        }
    });

    Ok(Arc::new(AgentSession { tx }))
}
