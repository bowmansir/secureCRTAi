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

    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    let events = on_event.clone();

    tauri::async_runtime::spawn(async move {
        // handle 必须存活到会话结束，移入任务持有
        let _handle = handle;
        loop {
            tokio::select! {
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
                        let _ = events.send(TermEvent::Data { bytes: data.to_vec() });
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = events.send(TermEvent::Data { bytes: data.to_vec() });
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                        break;
                    }
                    Some(_) => {}
                },
            }
        }
        let _ = events.send(TermEvent::Exit {
            message: Some("SSH 连接已断开".to_string()),
        });
    });

    let _ = on_event.send(TermEvent::Connected);
    Ok(Arc::new(SshTermSession { tx }))
}
