use super::integration::{IntegrationEvent, ParsedItem, ShellIntegrationParser};
use super::{TermEvent, TermSession};
use crate::hostkeys::HostKeyStore;
use anyhow::{anyhow, bail, Context};
use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{Channel as SshChannel, ChannelMsg, ChannelOpenFailure};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::mpsc;

#[derive(Clone, Deserialize)]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
}

enum TermCmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

pub struct SshTermSession {
    tx: mpsc::UnboundedSender<TermCmd>,
}

impl TermSession for SshTermSession {
    fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        self.tx
            .send(TermCmd::Write(data.to_vec()))
            .map_err(|_| anyhow!("ssh session closed"))
    }

    fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.tx
            .send(TermCmd::Resize(cols, rows))
            .map_err(|_| anyhow!("ssh session closed"))
    }

    fn close(&self) {
        let _ = self.tx.send(TermCmd::Close);
    }
}

/// 主机密钥校验（TOFU）：首次连接记录公钥，之后必须一致，否则拒绝。
pub struct ClientHandler {
    store: Arc<HostKeyStore>,
    host: String,
    port: u16,
    /// 记录到"公钥与保存值不符"，供上层给出清晰提示
    mismatch: Arc<AtomicBool>,
    forwarded_tx: Option<mpsc::UnboundedSender<ForwardedTcpip>>,
}

pub struct ForwardedTcpip {
    pub channel: SshChannel<client::Msg>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let openssh = match server_public_key.to_openssh() {
            Ok(s) => s,
            Err(_) => return Ok(false),
        };
        match self.store.get(&self.host, self.port) {
            Some(saved) if saved == openssh => Ok(true),
            Some(_) => {
                // 已记录但公钥变了：疑似中间人，拒绝
                self.mismatch.store(true, Ordering::Relaxed);
                Ok(false)
            }
            None => {
                // 首次连接：信任并记录
                self.store.save(&self.host, self.port, &openssh);
                Ok(true)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: SshChannel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = &self.forwarded_tx {
            let item = ForwardedTcpip { channel };
            if tx.send(item).is_ok() {
                reply.accept().await;
                return Ok(());
            }
        }
        reply
            .reject(ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }
}

/// 建立 TCP 连接并完成认证，SSH 终端与 SFTP 共用。
pub async fn connect_and_auth(
    store: Arc<HostKeyStore>,
    params: &SshParams,
) -> anyhow::Result<client::Handle<ClientHandler>> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let mismatch = Arc::new(AtomicBool::new(false));
    let handler = ClientHandler {
        store,
        host: params.host.clone(),
        port: params.port,
        mismatch: mismatch.clone(),
        forwarded_tx: None,
    };
    let addr = (params.host.as_str(), params.port);
    let mut handle = match client::connect(config, addr, handler).await {
        Ok(h) => h,
        Err(e) => {
            if mismatch.load(Ordering::Relaxed) {
                bail!(
                    "主机 {}:{} 的密钥与已保存记录不一致，可能存在中间人攻击风险。\
                     如确为预期变更，请删除配置目录下 known_hosts.json 中该主机记录后重试",
                    params.host,
                    params.port
                );
            }
            return Err(e).with_context(|| format!("无法连接 {}:{}", params.host, params.port));
        }
    };

    // 认证：优先私钥，其次密码
    let auth = if let Some(key_path) = params.key_path.as_deref().filter(|s| !s.is_empty()) {
        let key = load_secret_key(key_path, params.key_passphrase.as_deref())
            .with_context(|| format!("加载私钥失败: {key_path}"))?;
        let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
        handle
            .authenticate_publickey(
                params.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await?
    } else if let Some(password) = params.password.clone() {
        handle
            .authenticate_password(params.username.clone(), password)
            .await?
    } else {
        bail!("未提供密码或私钥");
    };

    if !matches!(auth, AuthResult::Success) {
        bail!("SSH 认证失败，请检查用户名/密码/密钥");
    }
    Ok(handle)
}

pub async fn connect_and_auth_with_forwarded(
    store: Arc<HostKeyStore>,
    params: &SshParams,
    forwarded_tx: mpsc::UnboundedSender<ForwardedTcpip>,
) -> anyhow::Result<client::Handle<ClientHandler>> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let mismatch = Arc::new(AtomicBool::new(false));
    let handler = ClientHandler {
        store,
        host: params.host.clone(),
        port: params.port,
        mismatch: mismatch.clone(),
        forwarded_tx: Some(forwarded_tx),
    };
    let addr = (params.host.as_str(), params.port);
    let mut handle = match client::connect(config, addr, handler).await {
        Ok(h) => h,
        Err(e) => {
            if mismatch.load(Ordering::Relaxed) {
                bail!(
                    "主机 {}:{} 的密钥与已保存记录不一致，可能存在中间人攻击风险。\n\
                     如确认为预期变更，请删除配置目录下 known_hosts.json 中该主机记录后重试",
                    params.host,
                    params.port
                );
            }
            return Err(e).with_context(|| format!("无法连接 {}:{}", params.host, params.port));
        }
    };

    let auth = if let Some(key_path) = params.key_path.as_deref().filter(|s| !s.is_empty()) {
        let key = load_secret_key(key_path, params.key_passphrase.as_deref())
            .with_context(|| format!("加载私钥失败: {key_path}"))?;
        let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
        handle
            .authenticate_publickey(
                params.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await?
    } else if let Some(password) = params.password.clone() {
        handle
            .authenticate_password(params.username.clone(), password)
            .await?
    } else {
        bail!("未提供密码或私钥");
    };

    if !matches!(auth, AuthResult::Success) {
        bail!("SSH 认证失败，请检查用户名/密码/密钥");
    }
    Ok(handle)
}

/// 在已认证的连接上开一个 exec channel 跑一条命令，收集 stdout+stderr 与退出码。
/// 供环境采集、公钥部署等一次性命令复用。
pub async fn exec_once(
    handle: &client::Handle<ClientHandler>,
    command: &str,
) -> anyhow::Result<(Option<u32>, String)> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;

    let mut out = Vec::new();
    let mut exit_code = None;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok((exit_code, String::from_utf8_lossy(&out).trim().to_string()))
}

/// 采集服务器环境信息（发行版、内核），供 AI 作常驻上下文。
/// 失败返回空串（不影响主流程）。
pub async fn probe_env(store: Arc<HostKeyStore>, params: SshParams) -> anyhow::Result<String> {
    let handle = connect_and_auth(store, &params).await?;
    let (_code, out) = exec_once(
        &handle,
        "uname -srm 2>/dev/null; . /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\"",
    )
    .await?;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    Ok(out)
}

pub async fn open(
    store: Arc<HostKeyStore>,
    params: SshParams,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> anyhow::Result<Arc<SshTermSession>> {
    let handle = connect_and_auth(store, &params).await?;
    let mut channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    let integration_nonce = uuid::Uuid::new_v4().simple().to_string();
    let integration_bootstrap = shell_integration_bootstrap(&integration_nonce);
    let integration_body = shell_integration_body(&integration_nonce);
    channel.data(integration_bootstrap.as_bytes()).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    let events = on_event.clone();

    tauri::async_runtime::spawn(async move {
        // handle 必须存活到会话结束，移入任务持有
        let _handle = handle;
        let mut parser = ShellIntegrationParser::new(&integration_nonce);
        let integration_deadline = tokio::time::sleep(std::time::Duration::from_secs(3));
        tokio::pin!(integration_deadline);
        let mut integration_pending = true;
        let mut integration_buffer = Vec::new();
        let mut install_body_sent = false;
        let mut active_command_id = None;
        loop {
            tokio::select! {
                _ = &mut integration_deadline, if integration_pending => {
                    integration_pending = false;
                    flush_integration_buffer(&mut integration_buffer, &events, false);
                    let _ = events.send(TermEvent::ShellIntegration {
                        available: false,
                        shell: None,
                    });
                }
                cmd = rx.recv() => match cmd {
                    Some(TermCmd::Write(data)) => {
                        if channel.data(&data[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(TermCmd::Resize(cols, rows)) => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Some(TermCmd::Close) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                },
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let bootstrap_ready = forward_terminal_items(
                            parser.feed(&data),
                            &events,
                            &mut integration_pending,
                            &mut integration_buffer,
                            &mut active_command_id,
                        );
                        if bootstrap_ready && !install_body_sent {
                            if channel.data(integration_body.as_bytes()).await.is_err() {
                                break;
                            }
                            install_body_sent = true;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let bootstrap_ready = forward_terminal_items(
                            parser.feed(&data),
                            &events,
                            &mut integration_pending,
                            &mut integration_buffer,
                            &mut active_command_id,
                        );
                        if bootstrap_ready && !install_body_sent {
                            if channel.data(integration_body.as_bytes()).await.is_err() {
                                break;
                            }
                            install_body_sent = true;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                        break;
                    }
                    Some(_) => {}
                },
            }
        }
        flush_integration_buffer(&mut integration_buffer, &events, false);
        let pending = parser.finish();
        if !pending.is_empty() {
            let _ = events.send(TermEvent::Data {
                bytes: pending,
                command_id: active_command_id.clone(),
            });
        }
        let _ = events.send(TermEvent::Exit {
            message: Some("SSH 连接已断开".to_string()),
        });
    });

    let _ = on_event.send(TermEvent::Connected);
    Ok(Arc::new(SshTermSession { tx }))
}

const SHELL_INTEGRATION_NONCE_PLACEHOLDER: &str = "__TERMEXA_NONCE__";
const SHELL_INTEGRATION_BOOTSTRAP_TEMPLATE: &str =
    " stty -echo 2>/dev/null; printf '\\033]633;Termexa;__TERMEXA_NONCE__;B\\007'\r";

const SHELL_INTEGRATION_BODY_TEMPLATE: &str = concat!(
    "__termexa_emit_command(){ ",
    "__termexa_cmd=${1:-}; ",
    "if [ -z \"$__termexa_cmd\" ]; then ",
    "__termexa_cmd=$(history 1 2>/dev/null | sed 's/^ *[0-9][0-9]* *//'); fi; ",
    "__termexa_cmd_b64=$(printf '%s' \"$__termexa_cmd\" | base64 2>/dev/null | tr -d '\\r\\n'); ",
    "printf '\\033]633;Termexa;__TERMEXA_NONCE__;C;%s\\007' \"$__termexa_cmd_b64\"; }; ",
    "__termexa_emit_prompt(){ __termexa_prompt_status=$?; ",
    "__termexa_status=${__termexa_status_captured:-$__termexa_prompt_status}; ",
    "unset __termexa_status_captured; ",
    "__termexa_cwd=$(printf '%s' \"$PWD\" | base64 2>/dev/null | tr -d '\\r\\n'); ",
    "printf '\\033]633;Termexa;__TERMEXA_NONCE__;P;%s;%s;\\007' \"$__termexa_status\" \"$__termexa_cwd\"; ",
    "__termexa_preexec_armed=1; ",
    "return \"$__termexa_status\"; }; ",
    "__termexa_emit_preexec(){ __termexa_debug_status=$?; ",
    "if [ \"${__termexa_preexec_armed:-0}\" = 1 ]; then ",
    "__termexa_preexec_armed=0; unset __termexa_status_captured; ",
    "__termexa_emit_command \"${1:-}\"; ",
    "elif [ -z \"${__termexa_status_captured+x}\" ]; then ",
    "__termexa_status_captured=$__termexa_debug_status; fi; }; ",
    "__termexa_preexec_armed=0; ",
    "if [ -n \"${BASH_VERSION:-}\" ]; then ",
    "if [ -z \"$(trap -p DEBUG 2>/dev/null)\" ]; then ",
    "PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND;}__termexa_emit_prompt\"; ",
    "__termexa_shell=bash; trap '__termexa_emit_preexec' DEBUG; ",
    "else __termexa_shell=raw; fi; ",
    "elif [ -n \"${ZSH_VERSION:-}\" ]; then ",
    "autoload -Uz add-zsh-hook 2>/dev/null && ",
    "add-zsh-hook precmd __termexa_emit_prompt && ",
    "add-zsh-hook preexec __termexa_emit_preexec; ",
    "__termexa_shell=zsh; ",
    "else __termexa_shell=raw; fi; ",
    "printf '\\033]633;Termexa;__TERMEXA_NONCE__;H;%s\\007' \"$__termexa_shell\"; ",
    "stty echo 2>/dev/null; true\r"
);

fn shell_integration_bootstrap(nonce: &str) -> String {
    SHELL_INTEGRATION_BOOTSTRAP_TEMPLATE.replace(SHELL_INTEGRATION_NONCE_PLACEHOLDER, nonce)
}

fn shell_integration_body(nonce: &str) -> String {
    SHELL_INTEGRATION_BODY_TEMPLATE.replace(SHELL_INTEGRATION_NONCE_PLACEHOLDER, nonce)
}

fn forward_terminal_items(
    items: Vec<ParsedItem>,
    events: &tauri::ipc::Channel<TermEvent>,
    integration_pending: &mut bool,
    integration_buffer: &mut Vec<u8>,
    active_command_id: &mut Option<String>,
) -> bool {
    let mut bootstrap_ready = false;
    for item in items {
        let event = match item {
            ParsedItem::Data(bytes) if *integration_pending => {
                integration_buffer.extend(bytes);
                continue;
            }
            ParsedItem::Data(bytes) => TermEvent::Data {
                bytes,
                command_id: active_command_id.clone(),
            },
            ParsedItem::Event(IntegrationEvent::BootstrapReady) => {
                bootstrap_ready = true;
                continue;
            }
            ParsedItem::Event(IntegrationEvent::Ready { shell }) => {
                flush_integration_buffer(integration_buffer, events, true);
                *integration_pending = false;
                TermEvent::ShellIntegration {
                    available: true,
                    shell: Some(shell),
                }
            }
            ParsedItem::Event(IntegrationEvent::Unavailable) => {
                flush_integration_buffer(integration_buffer, events, true);
                *integration_pending = false;
                TermEvent::ShellIntegration {
                    available: false,
                    shell: None,
                }
            }
            ParsedItem::Event(IntegrationEvent::CommandStart { command }) => {
                let command_id = begin_shell_command(active_command_id);
                TermEvent::ShellCommand {
                    command_id,
                    command,
                }
            }
            ParsedItem::Event(IntegrationEvent::Prompt {
                cwd,
                exit_code,
                command,
            }) => {
                let command_id = finish_shell_command(active_command_id);
                TermEvent::ShellPrompt {
                    command_id,
                    cwd,
                    exit_code,
                    command,
                }
            }
        };
        let _ = events.send(event);
    }
    bootstrap_ready
}

fn begin_shell_command(active_command_id: &mut Option<String>) -> String {
    let command_id = uuid::Uuid::new_v4().to_string();
    *active_command_id = Some(command_id.clone());
    command_id
}

fn finish_shell_command(active_command_id: &mut Option<String>) -> Option<String> {
    active_command_id.take()
}

fn flush_integration_buffer(
    integration_buffer: &mut Vec<u8>,
    events: &tauri::ipc::Channel<TermEvent>,
    integration_completed: bool,
) {
    if integration_buffer.is_empty() {
        return;
    }
    let mut bytes = strip_integration_install_echo(std::mem::take(integration_buffer));
    if integration_completed {
        strip_intermediate_install_prompt(&mut bytes);
    }
    if !bytes.is_empty() {
        let _ = events.send(TermEvent::Data {
            bytes,
            command_id: None,
        });
    }
}

fn strip_integration_install_echo(mut bytes: Vec<u8>) -> Vec<u8> {
    const COMMAND: &[u8] = b"stty -echo 2>/dev/null";
    while let Some(command_start) = bytes
        .windows(COMMAND.len())
        .position(|window| window == COMMAND)
    {
        let line_start = bytes[..command_start]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let line_end = bytes[command_start + COMMAND.len()..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| {
                command_start + COMMAND.len() + offset + 1
            });
        bytes.drain(line_start..line_end);
    }
    bytes
}

fn strip_intermediate_install_prompt(bytes: &mut Vec<u8>) {
    let line_start = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let line = &bytes[line_start..];
    if line_start == 0 || line.len() > 2048 {
        return;
    }
    if line
        .iter()
        .any(|byte| matches!(*byte, b'#' | b'$' | b'>' | b'%'))
    {
        bytes.truncate(line_start);
    }
}

#[cfg(test)]
mod integration_echo_tests {
    use super::{
        begin_shell_command, finish_shell_command, strip_integration_install_echo,
        strip_intermediate_install_prompt,
    };

    #[test]
    fn hides_only_the_internal_install_command_from_the_login_screen() {
        let input = b"Welcome\r\n[root@host ~]# stty -echo 2>/dev/null\r\n".to_vec();
        assert_eq!(strip_integration_install_echo(input), b"Welcome\r\n");
    }

    #[test]
    fn keeps_unrelated_terminal_output_unchanged() {
        let input = b"Welcome\r\n[root@host ~]# uptime\r\n".to_vec();
        assert_eq!(strip_integration_install_echo(input.clone()), input);
    }

    #[test]
    fn removes_the_intermediate_prompt_after_integration_is_ready() {
        let mut buffered = concat!(
            "Welcome\r\n",
            "[root@host ~]# stty -echo 2>/dev/null\r\n",
            "\x1b[01;32m[root@host ~]#\x1b[0m "
        )
        .as_bytes()
        .to_vec();
        buffered = strip_integration_install_echo(buffered);
        strip_intermediate_install_prompt(&mut buffered);
        assert_eq!(buffered, b"Welcome\r\n");
    }

    #[test]
    fn keeps_the_intermediate_prompt_when_integration_did_not_complete() {
        let input = b"Welcome\r\n[root@host ~]# ".to_vec();
        assert_eq!(strip_integration_install_echo(input.clone()), input);
    }

    #[test]
    fn keeps_one_stable_command_id_until_the_prompt_finishes_it() {
        let mut active_command_id = None;
        let first = begin_shell_command(&mut active_command_id);
        assert_eq!(active_command_id.as_deref(), Some(first.as_str()));
        assert_eq!(finish_shell_command(&mut active_command_id), Some(first));
        assert!(active_command_id.is_none());

        let second = begin_shell_command(&mut active_command_id);
        assert_eq!(active_command_id.as_deref(), Some(second.as_str()));
        assert_ne!(finish_shell_command(&mut active_command_id), None);
    }
}
