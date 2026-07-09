//! SSH 本地端口转发（-L）：在本机监听端口，把每个连接经 SSH 隧道转到远端目标。
//! 一条 SSH 连接多路复用多个 direct-tcpip channel；停止转发即 abort 接受循环、释放监听端口。

use crate::hostkeys::HostKeyStore;
use crate::terminal::ssh::{
    connect_and_auth, connect_and_auth_with_forwarded, exec_once, ClientHandler, ForwardedTcpip,
    SshParams,
};
use anyhow::{bail, Context};
use parking_lot::Mutex;
use russh::client;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{copy_bidirectional, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    Local,
    Dynamic,
    Remote,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    pub id: String,
    pub kind: ForwardKind,
    pub session_id: String,
    pub session_name: String,
    pub local_bind: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// 当前活跃连接数（list 时以实时计数填充）
    pub active: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardTestResult {
    pub id: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub target: String,
    pub message: String,
}

pub struct ForwardEntry {
    view: ForwardView,
    active: Arc<AtomicUsize>,
    task: JoinHandle<()>,
    children: Arc<Mutex<Vec<JoinHandle<()>>>>,
    cancel_tx: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct ForwardRegistry {
    inner: Mutex<HashMap<String, ForwardEntry>>,
}

impl ForwardRegistry {
    pub fn add(&self, entry: ForwardEntry) -> ForwardView {
        let view = entry.view.clone();
        self.inner.lock().insert(view.id.clone(), entry);
        view
    }

    pub fn list(&self) -> Vec<ForwardView> {
        let mut list: Vec<ForwardView> = self
            .inner
            .lock()
            .values()
            .map(|e| {
                let mut v = e.view.clone();
                v.active = e.active.load(Ordering::Relaxed);
                v
            })
            .collect();
        list.sort_by_key(|a| a.local_port);
        list
    }

    pub fn get(&self, id: &str) -> Option<ForwardView> {
        self.inner.lock().get(id).map(|e| {
            let mut v = e.view.clone();
            v.active = e.active.load(Ordering::Relaxed);
            v
        })
    }

    pub fn remove(&self, id: &str) -> bool {
        match self.inner.lock().remove(id) {
            Some(entry) => {
                if let Some(cancel_tx) = entry.cancel_tx {
                    let _ = cancel_tx.send(());
                } else {
                    entry.task.abort(); // 中止接受循环，TcpListener 随之 drop，端口释放
                }
                for child in entry.children.lock().drain(..) {
                    child.abort();
                }
                true
            }
            None => false,
        }
    }
}

fn track_child(children: &Arc<Mutex<Vec<JoinHandle<()>>>>, handle: JoinHandle<()>) {
    let mut items = children.lock();
    items.retain(|h| !h.is_finished());
    items.push(handle);
}

async fn bind_listener(local_bind: &str, local_port: u16) -> anyhow::Result<TcpListener> {
    let bind_addr = format!("{local_bind}:{local_port}");
    TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("无法监听本地地址 {bind_addr}（端口可能被占用）"))
}

/// 建立 SSH 连接并开始本地转发监听。绑定失败会同步返回错误（前端可即时提示）。
#[allow(clippy::too_many_arguments)]
pub async fn start(
    store: Arc<HostKeyStore>,
    params: SshParams,
    id: String,
    session_id: String,
    session_name: String,
    local_bind: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> anyhow::Result<ForwardEntry> {
    let handle = Arc::new(connect_and_auth(store, &params).await?);
    let listener = bind_listener(&local_bind, local_port).await?;

    let active = Arc::new(AtomicUsize::new(0));
    let accept_active = active.clone();
    let accept_rhost = remote_host.clone();
    let children = Arc::new(Mutex::new(Vec::new()));
    let accept_children = children.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut inbound, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let h = handle.clone();
            let cnt = accept_active.clone();
            let rhost = accept_rhost.clone();
            let originator_port = peer.port() as u32;
            let child = tokio::spawn(async move {
                cnt.fetch_add(1, Ordering::Relaxed);
                let channel = h
                    .channel_open_direct_tcpip(
                        rhost,
                        remote_port as u32,
                        "127.0.0.1",
                        originator_port,
                    )
                    .await
                    .ok(); // 远端目标不可达等，放弃这条连接
                if let Some(channel) = channel {
                    let mut stream = channel.into_stream();
                    let _ = copy_bidirectional(&mut inbound, &mut stream).await;
                }
                cnt.fetch_sub(1, Ordering::Relaxed);
            });
            track_child(&accept_children, child);
        }
    });

    Ok(ForwardEntry {
        view: ForwardView {
            id,
            kind: ForwardKind::Local,
            session_id,
            session_name,
            local_bind,
            local_port,
            remote_host,
            remote_port,
            active: 0,
        },
        active,
        task,
        children,
        cancel_tx: None,
    })
}

/// Dynamic forwarding (-D): local SOCKS5 proxy over the selected SSH session.
pub async fn start_dynamic(
    store: Arc<HostKeyStore>,
    params: SshParams,
    id: String,
    session_id: String,
    session_name: String,
    local_bind: String,
    local_port: u16,
) -> anyhow::Result<ForwardEntry> {
    let handle = Arc::new(connect_and_auth(store, &params).await?);
    let listener = bind_listener(&local_bind, local_port).await?;

    let active = Arc::new(AtomicUsize::new(0));
    let accept_active = active.clone();
    let children = Arc::new(Mutex::new(Vec::new()));
    let accept_children = children.clone();
    let task = tokio::spawn(async move {
        loop {
            let (inbound, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let h = handle.clone();
            let cnt = accept_active.clone();
            let child = tokio::spawn(async move {
                cnt.fetch_add(1, Ordering::Relaxed);
                let _ = handle_socks5_client(inbound, h).await;
                cnt.fetch_sub(1, Ordering::Relaxed);
            });
            track_child(&accept_children, child);
        }
    });

    Ok(ForwardEntry {
        view: ForwardView {
            id,
            kind: ForwardKind::Dynamic,
            session_id,
            session_name,
            local_bind,
            local_port,
            remote_host: String::new(),
            remote_port: 0,
            active: 0,
        },
        active,
        task,
        children,
        cancel_tx: None,
    })
}

/// Remote forwarding (-R): listen on the remote server and forward back to a local target.
#[allow(clippy::too_many_arguments)]
pub async fn start_remote(
    store: Arc<HostKeyStore>,
    params: SshParams,
    id: String,
    session_id: String,
    session_name: String,
    remote_bind: String,
    remote_port: u16,
    target_host: String,
    target_port: u16,
) -> anyhow::Result<ForwardEntry> {
    let (tx, mut rx) = mpsc::unbounded_channel::<ForwardedTcpip>();
    let handle = connect_and_auth_with_forwarded(store, &params, tx).await?;
    let assigned = handle
        .tcpip_forward(remote_bind.clone(), remote_port as u32)
        .await
        .with_context(|| {
            format!("远端无法监听 {remote_bind}:{remote_port}，请检查 sshd AllowTcpForwarding / GatewayPorts / 端口占用")
        })?;
    let listen_port = if remote_port == 0 {
        assigned as u16
    } else {
        remote_port
    };

    let active = Arc::new(AtomicUsize::new(0));
    let children = Arc::new(Mutex::new(Vec::new()));
    let task_active = active.clone();
    let task_children = children.clone();
    let view_target_host = target_host.clone();
    let cancel_bind = remote_bind.clone();
    let cancel_port = listen_port;
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    let _ = handle.cancel_tcpip_forward(cancel_bind, cancel_port as u32).await;
                    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
                    break;
                }
                item = rx.recv() => {
                    let Some(item) = item else { break };
                    let cnt = task_active.clone();
                    let host = target_host.clone();
                    let child = tokio::spawn(async move {
                        cnt.fetch_add(1, Ordering::Relaxed);
                        let _ = bridge_forwarded_tcpip(item, host, target_port).await;
                        cnt.fetch_sub(1, Ordering::Relaxed);
                    });
                    track_child(&task_children, child);
                }
            }
        }
    });

    Ok(ForwardEntry {
        view: ForwardView {
            id,
            kind: ForwardKind::Remote,
            session_id,
            session_name,
            local_bind: view_target_host,
            local_port: target_port,
            remote_host: remote_bind,
            remote_port: listen_port,
            active: 0,
        },
        active,
        task,
        children,
        cancel_tx: Some(cancel_tx),
    })
}

async fn bridge_forwarded_tcpip(
    item: ForwardedTcpip,
    target_host: String,
    target_port: u16,
) -> anyhow::Result<()> {
    let mut local = TcpStream::connect((target_host.as_str(), target_port)).await?;
    let mut stream = item.channel.into_stream();
    let _ = copy_bidirectional(&mut stream, &mut local).await;
    Ok(())
}

async fn handle_socks5_client(
    mut inbound: TcpStream,
    handle: Arc<client::Handle<ClientHandler>>,
) -> anyhow::Result<()> {
    let originator_port = inbound.peer_addr().map(|a| a.port()).unwrap_or(0) as u32;
    let (target_host, target_port) = match read_socks5_target(&mut inbound).await {
        Ok(v) => v,
        Err(e) => {
            let _ = write_socks_reply(&mut inbound, 0x01).await;
            return Err(e);
        }
    };
    let channel = match handle
        .channel_open_direct_tcpip(
            target_host,
            target_port as u32,
            "127.0.0.1",
            originator_port,
        )
        .await
    {
        Ok(c) => c,
        Err(e) => {
            let _ = write_socks_reply(&mut inbound, 0x05).await;
            return Err(e.into());
        }
    };
    write_socks_reply(&mut inbound, 0x00).await?;
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut inbound, &mut stream).await;
    Ok(())
}

async fn read_socks5_target<S>(stream: &mut S) -> anyhow::Result<(String, u16)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut hello = [0u8; 2];
    stream.read_exact(&mut hello).await?;
    if hello[0] != 0x05 {
        bail!("unsupported SOCKS version");
    }
    let mut methods = vec![0u8; hello[1] as usize];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0x00) {
        stream.write_all(&[0x05, 0xff]).await?;
        bail!("SOCKS5 no-auth method is required");
    }
    stream.write_all(&[0x05, 0x00]).await?;

    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await?;
    if req[0] != 0x05 {
        bail!("unsupported SOCKS request version");
    }
    if req[1] != 0x01 {
        write_socks_reply(stream, 0x07).await?;
        bail!("only SOCKS5 CONNECT is supported");
    }
    if req[2] != 0x00 {
        bail!("invalid SOCKS5 reserved byte");
    }

    let host = match req[3] {
        0x01 => {
            let mut ip = [0u8; 4];
            stream.read_exact(&mut ip).await?;
            Ipv4Addr::from(ip).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut buf = vec![0u8; len[0] as usize];
            stream.read_exact(&mut buf).await?;
            String::from_utf8(buf).context("SOCKS5 domain is not valid UTF-8")?
        }
        0x04 => {
            let mut ip = [0u8; 16];
            stream.read_exact(&mut ip).await?;
            Ipv6Addr::from(ip).to_string()
        }
        _ => {
            write_socks_reply(stream, 0x08).await?;
            bail!("unsupported SOCKS5 address type");
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

async fn write_socks_reply<S>(stream: &mut S, code: u8) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
}

const TCP_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const TCP_CLOSE_GRACE: Duration = Duration::from_millis(250);
const REMOTE_PROBE_TIMEOUT: Duration = Duration::from_secs(7);

fn endpoint(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

fn test_result(
    view: &ForwardView,
    started: Instant,
    ok: bool,
    target: String,
    message: String,
) -> ForwardTestResult {
    ForwardTestResult {
        id: view.id.clone(),
        ok,
        latency_ms: started.elapsed().as_millis() as u64,
        target,
        message,
    }
}

async fn probe_tcp_local(host: &str, port: u16) -> anyhow::Result<()> {
    let stream = timeout(TCP_PROBE_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .with_context(|| format!("TCP connect timeout: {}", endpoint(host, port)))?
        .with_context(|| format!("TCP connect failed: {}", endpoint(host, port)))?;

    let mut buf = [0u8; 1];
    match timeout(TCP_CLOSE_GRACE, stream.peek(&mut buf)).await {
        Ok(Ok(0)) => bail!(
            "TCP connection closed immediately: {}",
            endpoint(host, port)
        ),
        Ok(Err(e)) => bail!("TCP probe failed: {} ({e})", endpoint(host, port)),
        Ok(Ok(_)) | Err(_) => Ok(()),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_tcp_probe_command(host: &str, port: u16) -> String {
    format!(
        "HOST={}; PORT={}; \
         if command -v nc >/dev/null 2>&1; then \
           nc -z -w 3 \"$HOST\" \"$PORT\"; \
         elif command -v python3 >/dev/null 2>&1; then \
           python3 -c \"import socket,sys; s=socket.create_connection((sys.argv[1], int(sys.argv[2])), 3); s.close()\" \"$HOST\" \"$PORT\"; \
         elif command -v bash >/dev/null 2>&1; then \
           timeout 3 bash -lc 'cat < /dev/null > /dev/tcp/\"$0\"/\"$1\"' \"$HOST\" \"$PORT\"; \
         else \
           exit 127; \
         fi",
        shell_quote(host),
        port
    )
}

async fn probe_tcp_from_ssh(
    store: Arc<HostKeyStore>,
    params: &SshParams,
    host: &str,
    port: u16,
) -> anyhow::Result<()> {
    let handle = connect_and_auth(store, params).await?;
    let command = remote_tcp_probe_command(host, port);
    let result = timeout(REMOTE_PROBE_TIMEOUT, exec_once(&handle, &command)).await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;

    let (exit_code, output) = result
        .with_context(|| format!("remote TCP probe timeout: {}", endpoint(host, port)))?
        .with_context(|| format!("remote TCP probe failed: {}", endpoint(host, port)))?;
    match exit_code {
        Some(0) => Ok(()),
        Some(127) => bail!("remote host lacks nc/python3/bash for TCP probe"),
        Some(code) => bail!(
            "remote TCP probe failed: {} (exit {code}{})",
            endpoint(host, port),
            if output.is_empty() {
                String::new()
            } else {
                format!(", {output}")
            }
        ),
        None => bail!(
            "remote TCP probe ended without exit status: {}",
            endpoint(host, port)
        ),
    }
}

fn socks5_connect_request(host: &str, port: u16) -> anyhow::Result<Vec<u8>> {
    let mut req = vec![0x05, 0x01, 0x00];
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        req.push(0x01);
        req.extend_from_slice(&ip.octets());
    } else if let Ok(ip) = host.parse::<Ipv6Addr>() {
        req.push(0x04);
        req.extend_from_slice(&ip.octets());
    } else {
        let bytes = host.as_bytes();
        if bytes.len() > u8::MAX as usize {
            bail!("SOCKS5 domain is too long");
        }
        req.push(0x03);
        req.push(bytes.len() as u8);
        req.extend_from_slice(bytes);
    }
    req.extend_from_slice(&port.to_be_bytes());
    Ok(req)
}

async fn probe_socks5(
    local_bind: &str,
    local_port: u16,
    target_host: Option<&str>,
    target_port: Option<u16>,
) -> anyhow::Result<String> {
    let mut stream = timeout(
        TCP_PROBE_TIMEOUT,
        TcpStream::connect((local_bind, local_port)),
    )
    .await
    .with_context(|| {
        format!(
            "SOCKS5 connect timeout: {}",
            endpoint(local_bind, local_port)
        )
    })?
    .with_context(|| {
        format!(
            "SOCKS5 connect failed: {}",
            endpoint(local_bind, local_port)
        )
    })?;

    stream.write_all(&[0x05, 0x01, 0x00]).await?;
    let mut auth = [0u8; 2];
    timeout(TCP_PROBE_TIMEOUT, stream.read_exact(&mut auth))
        .await
        .context("SOCKS5 handshake timeout")??;
    if auth != [0x05, 0x00] {
        bail!("SOCKS5 no-auth handshake rejected");
    }

    let Some(host) = target_host.filter(|s| !s.trim().is_empty()) else {
        return Ok("SOCKS5 handshake is available".to_string());
    };
    let Some(port) = target_port else {
        return Ok("SOCKS5 handshake is available; no target port was provided".to_string());
    };
    let req = socks5_connect_request(host.trim(), port)?;
    stream.write_all(&req).await?;
    let mut reply = [0u8; 10];
    timeout(TCP_PROBE_TIMEOUT, stream.read_exact(&mut reply))
        .await
        .context("SOCKS5 CONNECT timeout")??;
    if reply[1] != 0x00 {
        bail!("SOCKS5 CONNECT failed with code 0x{:02x}", reply[1]);
    }
    Ok(format!(
        "SOCKS5 CONNECT succeeded: {}",
        endpoint(host.trim(), port)
    ))
}

pub async fn test(
    store: Arc<HostKeyStore>,
    params: SshParams,
    view: ForwardView,
    socks_target_host: Option<String>,
    socks_target_port: Option<u16>,
) -> ForwardTestResult {
    let started = Instant::now();
    match view.kind {
        ForwardKind::Local => {
            let local = endpoint(&view.local_bind, view.local_port);
            if let Err(e) = probe_tcp_local(&view.local_bind, view.local_port).await {
                return test_result(
                    &view,
                    started,
                    false,
                    local,
                    format!("Local entry is not reachable: {e:#}"),
                );
            }
            let remote = endpoint(&view.remote_host, view.remote_port);
            if let Err(e) =
                probe_tcp_from_ssh(store, &params, &view.remote_host, view.remote_port).await
            {
                return test_result(
                    &view,
                    started,
                    false,
                    remote,
                    format!("Target is not reachable from jump server: {e:#}"),
                );
            }
            test_result(
                &view,
                started,
                true,
                format!("{local} -> {remote}"),
                "Local entry and server-side target are reachable".to_string(),
            )
        }
        ForwardKind::Dynamic => {
            let local = endpoint(&view.local_bind, view.local_port);
            match probe_socks5(
                &view.local_bind,
                view.local_port,
                socks_target_host.as_deref(),
                socks_target_port,
            )
            .await
            {
                Ok(message) => test_result(&view, started, true, local, message),
                Err(e) => test_result(
                    &view,
                    started,
                    false,
                    local,
                    format!("SOCKS5 probe failed: {e:#}"),
                ),
            }
        }
        ForwardKind::Remote => {
            let target = endpoint(&view.local_bind, view.local_port);
            if let Err(e) = probe_tcp_local(&view.local_bind, view.local_port).await {
                return test_result(
                    &view,
                    started,
                    false,
                    target,
                    format!("Local target is not reachable: {e:#}"),
                );
            }
            let remote = endpoint(&view.remote_host, view.remote_port);
            if let Err(e) =
                probe_tcp_from_ssh(store, &params, &view.remote_host, view.remote_port).await
            {
                return test_result(
                    &view,
                    started,
                    false,
                    remote,
                    format!("Remote entry is not reachable from server: {e:#}"),
                );
            }
            test_result(
                &view,
                started,
                true,
                format!("{remote} -> {target}"),
                "Remote entry and local target are reachable".to_string(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        read_socks5_target, start, start_dynamic, start_remote, ForwardEntry, ForwardKind,
        ForwardRegistry, ForwardView,
    };
    use crate::hostkeys::HostKeyStore;
    use crate::terminal::ssh::SshParams;
    use russh::server::{self, Auth, Msg, Server as _, Session};
    use russh::{Channel, ChannelId, ChannelOpenFailure};
    use ssh_key::getrandom::SysRng;
    use ssh_key::rand_core::UnwrapErr;
    use ssh_key::{Algorithm, PrivateKey};
    use std::net::SocketAddr;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{copy_bidirectional, duplex, AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot};
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    const TEST_PAYLOAD: &[u8] = b"termai-forward-e2e-payload\nsecond-line";

    #[derive(Clone)]
    struct TestForwardSshServer {
        remote_probe_tx: Option<mpsc::Sender<Vec<u8>>>,
    }

    impl russh::server::Server for TestForwardSshServer {
        type Handler = Self;

        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self::Handler {
            self.clone()
        }
    }

    impl russh::server::Handler for TestForwardSshServer {
        type Error = anyhow::Error;

        async fn auth_password(&mut self, _: &str, _: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            reply: server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            let target = match TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
                Ok(stream) => stream,
                Err(_) => {
                    reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return Ok(());
                }
            };
            reply.accept().await;
            tokio::spawn(async move {
                let mut channel_stream = channel.into_stream();
                let mut target = target;
                let _ = copy_bidirectional(&mut channel_stream, &mut target).await;
            });
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            _data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }

        async fn tcpip_forward(
            &mut self,
            address: &str,
            port: &mut u32,
            session: &mut Session,
        ) -> Result<bool, Self::Error> {
            if *port == 0 {
                *port = 41000;
            }
            let Some(tx) = self.remote_probe_tx.clone() else {
                return Ok(true);
            };
            let handle = session.handle();
            let address = address.to_string();
            let port = *port;
            tokio::spawn(async move {
                let result = async {
                    let channel = handle
                        .channel_open_forwarded_tcpip(address, port, "127.0.0.1", 43210)
                        .await?;
                    let mut stream = channel.into_stream();
                    stream.write_all(TEST_PAYLOAD).await?;
                    let mut buf = vec![0u8; TEST_PAYLOAD.len()];
                    stream.read_exact(&mut buf).await?;
                    stream.shutdown().await?;
                    Ok::<Vec<u8>, anyhow::Error>(buf)
                }
                .await
                .unwrap_or_else(|e| format!("remote-forward-error:{e:#}").into_bytes());
                let _ = tx.send(result).await;
            });
            Ok(true)
        }

        async fn cancel_tcpip_forward(
            &mut self,
            _address: &str,
            _port: u32,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn start_test_ssh_server(
        remote_probe_tx: Option<mpsc::Sender<Vec<u8>>>,
    ) -> (SocketAddr, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let config = Arc::new(russh::server::Config {
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(1)),
            keys: vec![
                PrivateKey::random(&mut UnwrapErr(SysRng), Algorithm::Ed25519)
                    .expect("generate test ssh host key"),
            ],
            ..Default::default()
        });
        let mut server = TestForwardSshServer { remote_probe_tx };
        let task = tokio::spawn(async move {
            let _ = server.run_on_socket(config, &listener).await;
        });
        (addr, task)
    }

    async fn start_echo_server() -> (SocketAddr, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut read, mut write) = socket.split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });
        (addr, task)
    }

    async fn unused_local_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn test_ssh_params(addr: SocketAddr) -> SshParams {
        SshParams {
            host: "127.0.0.1".to_string(),
            port: addr.port(),
            username: "tester".to_string(),
            password: Some("password".to_string()),
            key_path: None,
            key_passphrase: None,
        }
    }

    async fn roundtrip_tcp(addr: SocketAddr, payload: &[u8]) -> Vec<u8> {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(payload).await.unwrap();
        let mut buf = vec![0u8; payload.len()];
        timeout(Duration::from_secs(3), stream.read_exact(&mut buf))
            .await
            .expect("tcp roundtrip timed out")
            .unwrap();
        stream.shutdown().await.unwrap();
        buf
    }

    fn stop_forward(registry: &ForwardRegistry, view: &ForwardView) {
        assert!(registry.remove(&view.id));
    }

    #[tokio::test]
    async fn local_forward_roundtrips_over_real_ssh_direct_tcpip() {
        let (target_addr, target_task) = start_echo_server().await;
        let (ssh_addr, ssh_task) = start_test_ssh_server(None).await;
        let local_port = unused_local_port().await;
        let registry = ForwardRegistry::default();

        let entry = start(
            Arc::new(HostKeyStore::default()),
            test_ssh_params(ssh_addr),
            "local-e2e".to_string(),
            "session-1".to_string(),
            "test-ssh".to_string(),
            "127.0.0.1".to_string(),
            local_port,
            target_addr.ip().to_string(),
            target_addr.port(),
        )
        .await
        .expect("start local forward");
        let view = registry.add(entry);

        let echoed = roundtrip_tcp(([127, 0, 0, 1], local_port).into(), TEST_PAYLOAD).await;
        assert_eq!(echoed, TEST_PAYLOAD);

        let probe = super::test(
            Arc::new(HostKeyStore::default()),
            test_ssh_params(ssh_addr),
            view.clone(),
            None,
            None,
        )
        .await;
        assert!(probe.ok, "local forward probe failed: {}", probe.message);

        stop_forward(&registry, &view);
        target_task.abort();
        ssh_task.abort();
    }

    #[tokio::test]
    async fn dynamic_forward_roundtrips_over_real_ssh_socks5() {
        let (target_addr, target_task) = start_echo_server().await;
        let (ssh_addr, ssh_task) = start_test_ssh_server(None).await;
        let local_port = unused_local_port().await;
        let registry = ForwardRegistry::default();

        let entry = start_dynamic(
            Arc::new(HostKeyStore::default()),
            test_ssh_params(ssh_addr),
            "dynamic-e2e".to_string(),
            "session-1".to_string(),
            "test-ssh".to_string(),
            "127.0.0.1".to_string(),
            local_port,
        )
        .await
        .expect("start dynamic forward");
        let view = registry.add(entry);

        let mut stream = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut auth = [0u8; 2];
        stream.read_exact(&mut auth).await.unwrap();
        assert_eq!(auth, [0x05, 0x00]);

        let mut req = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1];
        req.extend_from_slice(&target_addr.port().to_be_bytes());
        stream.write_all(&req).await.unwrap();
        let mut reply = [0u8; 10];
        stream.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0x00);

        stream.write_all(TEST_PAYLOAD).await.unwrap();
        let mut echoed = vec![0u8; TEST_PAYLOAD.len()];
        timeout(Duration::from_secs(3), stream.read_exact(&mut echoed))
            .await
            .expect("SOCKS5 roundtrip timed out")
            .unwrap();
        stream.shutdown().await.unwrap();
        assert_eq!(echoed, TEST_PAYLOAD);

        let probe = super::test(
            Arc::new(HostKeyStore::default()),
            test_ssh_params(ssh_addr),
            view.clone(),
            Some(target_addr.ip().to_string()),
            Some(target_addr.port()),
        )
        .await;
        assert!(probe.ok, "dynamic forward probe failed: {}", probe.message);

        stop_forward(&registry, &view);
        target_task.abort();
        ssh_task.abort();
    }

    #[tokio::test]
    async fn remote_forward_roundtrips_over_real_ssh_forwarded_tcpip() {
        let (target_addr, target_task) = start_echo_server().await;
        let (probe_tx, mut probe_rx) = mpsc::channel(1);
        let (ssh_addr, ssh_task) = start_test_ssh_server(Some(probe_tx)).await;
        let registry = ForwardRegistry::default();

        let entry = start_remote(
            Arc::new(HostKeyStore::default()),
            test_ssh_params(ssh_addr),
            "remote-e2e".to_string(),
            "session-1".to_string(),
            "test-ssh".to_string(),
            "127.0.0.1".to_string(),
            0,
            target_addr.ip().to_string(),
            target_addr.port(),
        )
        .await
        .expect("start remote forward");
        let view = registry.add(entry);

        let echoed = timeout(Duration::from_secs(3), probe_rx.recv())
            .await
            .expect("remote forward probe timed out")
            .expect("remote forward probe channel closed");
        assert_eq!(echoed, TEST_PAYLOAD);
        assert_eq!(view.remote_port, 41000);

        let probe = super::test(
            Arc::new(HostKeyStore::default()),
            test_ssh_params(ssh_addr),
            view.clone(),
            None,
            None,
        )
        .await;
        assert!(probe.ok, "remote forward probe failed: {}", probe.message);

        stop_forward(&registry, &view);
        target_task.abort();
        ssh_task.abort();
    }

    #[tokio::test]
    async fn socks5_reads_domain_connect_request() {
        let (mut client, mut server) = duplex(128);
        let task = tokio::spawn(async move { read_socks5_target(&mut server).await.unwrap() });

        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut auth = [0u8; 2];
        client.read_exact(&mut auth).await.unwrap();
        assert_eq!(auth, [0x05, 0x00]);

        let host = b"example.com";
        let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
        req.extend_from_slice(host);
        req.extend_from_slice(&443u16.to_be_bytes());
        client.write_all(&req).await.unwrap();

        let (parsed_host, parsed_port) = task.await.unwrap();
        assert_eq!(parsed_host, "example.com");
        assert_eq!(parsed_port, 443);
    }

    #[tokio::test]
    async fn socks5_rejects_auth_methods_when_no_auth_is_missing() {
        let (mut client, mut server) = duplex(64);
        let task = tokio::spawn(async move { read_socks5_target(&mut server).await });

        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
        let mut auth = [0u8; 2];
        client.read_exact(&mut auth).await.unwrap();
        assert_eq!(auth, [0x05, 0xff]);
        assert!(task.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn removing_remote_forward_sends_cancel_signal() {
        let registry = ForwardRegistry::default();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (done_tx, done_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = cancel_rx.await;
            let _ = done_tx.send(());
        });

        registry.add(ForwardEntry {
            view: ForwardView {
                id: "remote-1".to_string(),
                kind: ForwardKind::Remote,
                session_id: "s1".to_string(),
                session_name: "server".to_string(),
                local_bind: "127.0.0.1".to_string(),
                local_port: 3000,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 9000,
                active: 0,
            },
            active: Arc::new(AtomicUsize::new(0)),
            task,
            children: Arc::new(parking_lot::Mutex::new(Vec::new())),
            cancel_tx: Some(cancel_tx),
        });

        assert!(registry.remove("remote-1"));
        assert!(done_rx.await.is_ok());
    }
}
