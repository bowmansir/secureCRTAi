mod agent;
mod ai;
mod forward;
mod hostkeys;
mod keys;
mod localfs;
mod portable;
mod sftp;
mod sftp_cli;
mod store;
mod terminal;
mod transfer;
mod vault;

use ai::{AiEvent, ChatMessage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use store::{AiProviderConfig, SessionProfile, Store};
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};
use terminal::ssh::SshParams;
use terminal::{TermEvent, TerminalRegistry};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;
use uuid::Uuid;

struct AppState {
    terminals: TerminalRegistry,
    sftp: sftp::SftpRegistry,
    transfers: transfer::TransferManager,
    agents: agent::AgentRegistry,
    forwards: forward::ForwardRegistry,
    hostkeys: std::sync::Arc<hostkeys::HostKeyStore>,
    store: Store,
}

fn ssh_params_from_profile(state: &AppState, session_id: &str) -> Result<SshParams, String> {
    let profile = state
        .store
        .get_session(session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    Ok(SshParams {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        password: store::decrypt_optional(&profile.password_enc).map_err(err_str)?,
        key_path: profile.key_path.clone(),
        key_passphrase: store::decrypt_optional(&profile.key_passphrase_enc).map_err(err_str)?,
    })
}

type CmdResult<T> = Result<T, String>;

const AGENT_RUN_COMMAND_TIMEOUT: Duration = Duration::from_secs(35);
const HEALTH_CHECK_CONCURRENCY: usize = 20;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckResult {
    session_id: String,
    host: String,
    port: u16,
    ok: bool,
    latency_ms: Option<u64>,
    message: String,
}

async fn check_session_tcp_health(
    session_id: String,
    profile: Option<SessionProfile>,
    timeout_ms: u64,
    timeout_duration: Duration,
    limiter: Arc<Semaphore>,
) -> HealthCheckResult {
    let Some(profile) = profile else {
        return HealthCheckResult {
            session_id,
            host: String::new(),
            port: 0,
            ok: false,
            latency_ms: None,
            message: "session not found".to_string(),
        };
    };

    let _permit = limiter.acquire_owned().await.ok();
    let started = Instant::now();
    match timeout(
        timeout_duration,
        TcpStream::connect((profile.host.as_str(), profile.port)),
    )
    .await
    {
        Ok(Ok(_)) => HealthCheckResult {
            session_id: profile.id,
            host: profile.host,
            port: profile.port,
            ok: true,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: "reachable".to_string(),
        },
        Ok(Err(err)) => HealthCheckResult {
            session_id: profile.id,
            host: profile.host,
            port: profile.port,
            ok: false,
            latency_ms: None,
            message: err.to_string(),
        },
        Err(_) => HealthCheckResult {
            session_id: profile.id,
            host: profile.host,
            port: profile.port,
            ok: false,
            latency_ms: None,
            message: format!("timeout after {timeout_ms}ms"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_profile(id: &str, host: &str, port: u16) -> SessionProfile {
        SessionProfile {
            id: id.to_string(),
            name: id.to_string(),
            group: String::new(),
            host: host.to_string(),
            port,
            username: "root".to_string(),
            auth_type: "password".to_string(),
            password_enc: None,
            key_path: None,
            key_passphrase_enc: None,
        }
    }

    #[tokio::test]
    async fn health_check_marks_local_tcp_server_online() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let port = listener.local_addr().expect("listener address").port();
        let accept_task = tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), listener.accept()).await;
        });

        let result = check_session_tcp_health(
            "online".to_string(),
            Some(test_profile("online", "127.0.0.1", port)),
            1000,
            Duration::from_millis(1000),
            Arc::new(Semaphore::new(1)),
        )
        .await;

        assert!(result.ok, "expected reachable result, got {result:?}");
        assert_eq!(result.session_id, "online");
        assert_eq!(result.host, "127.0.0.1");
        assert_eq!(result.port, port);
        assert!(result.latency_ms.is_some());
        assert_eq!(result.message, "reachable");
        accept_task.await.expect("accept task");
    }

    #[tokio::test]
    async fn health_check_marks_closed_local_port_offline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);

        let result = check_session_tcp_health(
            "offline".to_string(),
            Some(test_profile("offline", "127.0.0.1", port)),
            1000,
            Duration::from_millis(1000),
            Arc::new(Semaphore::new(1)),
        )
        .await;

        assert!(!result.ok, "expected offline result, got {result:?}");
        assert_eq!(result.session_id, "offline");
        assert_eq!(result.host, "127.0.0.1");
        assert_eq!(result.port, port);
        assert_eq!(result.latency_ms, None);
        assert!(!result.message.is_empty());
    }

    #[tokio::test]
    async fn health_check_reports_missing_session() {
        let result = check_session_tcp_health(
            "missing".to_string(),
            None,
            1000,
            Duration::from_millis(1000),
            Arc::new(Semaphore::new(1)),
        )
        .await;

        assert!(!result.ok);
        assert_eq!(result.session_id, "missing");
        assert_eq!(result.host, "");
        assert_eq!(result.port, 0);
        assert_eq!(result.latency_ms, None);
        assert_eq!(result.message, "session not found");
    }
}

fn err_str(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---------- 终端 ----------

#[tauri::command]
async fn term_open_local(
    state: State<'_, AppState>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<String> {
    let session = terminal::local::open(shell, cols, rows, on_event).map_err(err_str)?;
    let id = Uuid::new_v4().to_string();
    state.terminals.insert(id.clone(), session);
    Ok(id)
}

/// 直接以参数连接（未保存的临时连接）
#[tauri::command]
async fn term_open_ssh(
    state: State<'_, AppState>,
    params: SshParams,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<String> {
    let session = terminal::ssh::open(state.hostkeys.clone(), params, cols, rows, on_event)
        .await
        .map_err(err_str)?;
    let id = Uuid::new_v4().to_string();
    state.terminals.insert(id.clone(), session);
    Ok(id)
}

/// 用已保存的会话连接（密码在后端解密，不经过前端）
#[tauri::command]
async fn term_open_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> CmdResult<String> {
    let params = ssh_params_from_profile(&state, &session_id)?;
    let session = terminal::ssh::open(state.hostkeys.clone(), params, cols, rows, on_event)
        .await
        .map_err(err_str)?;
    let id = Uuid::new_v4().to_string();
    state.terminals.insert(id.clone(), session);
    Ok(id)
}

// ---------- Agent A+ ----------

#[tauri::command]
async fn agent_open(state: State<'_, AppState>, session_id: String) -> CmdResult<String> {
    let params = ssh_params_from_profile(&state, &session_id)?;
    let session = agent::open(state.hostkeys.clone(), params)
        .await
        .map_err(err_str)?;
    let id = Uuid::new_v4().to_string();
    state.agents.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
async fn agent_run(
    state: State<'_, AppState>,
    id: String,
    command: String,
) -> CmdResult<agent::AgentRunResult> {
    let session = state.agents.get(&id).ok_or("Agent 会话不存在")?;
    match tokio::time::timeout(AGENT_RUN_COMMAND_TIMEOUT, session.run(command)).await {
        Ok(result) => result.map_err(err_str),
        Err(_) => {
            if let Some(s) = state.agents.remove(&id) {
                s.close();
            }
            Err("Agent 执行超时，已重置执行通道，请重试".to_string())
        }
    }
}

#[tauri::command]
fn agent_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if let Some(s) = state.agents.remove(&id) {
        s.close();
    }
    Ok(())
}

/// 采集会话对应服务器的环境信息（发行版/内核），供 AI 上下文。失败返回空串。
#[tauri::command]
async fn ssh_probe_env(state: State<'_, AppState>, session_id: String) -> CmdResult<String> {
    let params = ssh_params_from_profile(&state, &session_id)?;
    match terminal::ssh::probe_env(state.hostkeys.clone(), params).await {
        Ok(env) => Ok(env),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn term_write(state: State<'_, AppState>, id: String, data: Vec<u8>) -> CmdResult<()> {
    let session = state.terminals.get(&id).ok_or("终端不存在")?;
    session.write(&data).map_err(err_str)
}

#[tauri::command]
fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    let session = state.terminals.get(&id).ok_or("终端不存在")?;
    session.resize(cols, rows).map_err(err_str)
}

#[tauri::command]
fn term_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if let Some(session) = state.terminals.remove(&id) {
        session.close();
    }
    Ok(())
}

// ---------- SFTP ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpOpenResult {
    id: String,
    home: String,
}

#[tauri::command]
async fn sftp_open(state: State<'_, AppState>, session_id: String) -> CmdResult<SftpOpenResult> {
    let params = ssh_params_from_profile(&state, &session_id)?;
    let (conn, home) = sftp::open(state.hostkeys.clone(), params)
        .await
        .map_err(err_str)?;
    let id = Uuid::new_v4().to_string();
    state.sftp.insert(id.clone(), conn);
    Ok(SftpOpenResult { id, home })
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> CmdResult<Vec<sftp::FileEntry>> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    sftp::list_dir(&conn, &path).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
) -> CmdResult<()> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    sftp::download(&conn, &remote, &local)
        .await
        .map_err(err_str)
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
) -> CmdResult<()> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    sftp::upload(&conn, &local, &remote).await.map_err(err_str)
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> CmdResult<()> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    conn.sftp
        .create_dir(path)
        .await
        .map_err(|e| format!("创建目录失败: {e}"))
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> CmdResult<()> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    let r = if is_dir {
        conn.sftp.remove_dir(path).await
    } else {
        conn.sftp.remove_file(path).await
    };
    r.map_err(|e| format!("删除失败: {e}"))
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> CmdResult<()> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    conn.sftp
        .rename(from, to)
        .await
        .map_err(|e| format!("重命名失败: {e}"))
}

#[tauri::command]
fn sftp_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.sftp.remove(&id);
    Ok(())
}

#[tauri::command]
async fn sftp_cli_exec(
    state: State<'_, AppState>,
    id: String,
    line: String,
    cwd: String,
    lcwd: String,
) -> CmdResult<sftp_cli::CliResult> {
    let conn = state.sftp.get(&id).ok_or("SFTP 连接不存在")?;
    Ok(sftp_cli::exec(&conn, &line, &cwd, &lcwd).await)
}

// ---------- 传输引擎 ----------

#[tauri::command]
async fn transfer_start(
    state: State<'_, AppState>,
    sftp_id: String,
    kind: String,
    local: String,
    remote: String,
    on_event: Channel<transfer::TransferEvent>,
) -> CmdResult<String> {
    let conn = state.sftp.get(&sftp_id).ok_or("SFTP 连接不存在")?;
    let id = Uuid::new_v4().to_string();
    let cancel = state.transfers.register(id.clone());
    let cancels = state.transfers.map();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        transfer::run(conn, kind, local, remote, cancel, on_event).await;
        cancels.lock().remove(&task_id);
    });
    Ok(id)
}

#[tauri::command]
fn transfer_cancel(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.transfers.cancel(&id);
    Ok(())
}

/// 服务器间传输 A→B：从已打开的源 SFTP 读，新建目标会话的 SFTP 连接写，本地不落盘
#[tauri::command]
async fn transfer_remote(
    state: State<'_, AppState>,
    src_sftp_id: String,
    src_path: String,
    dst_session_id: String,
    dst_path: String,
    on_event: Channel<transfer::TransferEvent>,
) -> CmdResult<String> {
    let src = state.sftp.get(&src_sftp_id).ok_or("源 SFTP 连接不存在")?;
    let params = ssh_params_from_profile(&state, &dst_session_id)?;
    let (dst, _home) = sftp::open(state.hostkeys.clone(), params)
        .await
        .map_err(err_str)?;
    let id = Uuid::new_v4().to_string();
    let cancel = state.transfers.register(id.clone());
    let cancels = state.transfers.map();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        transfer::run_remote(src, dst, src_path, dst_path, cancel, on_event).await;
        cancels.lock().remove(&task_id);
    });
    Ok(id)
}

// ---------- 端口转发（本地 -L） ----------

#[tauri::command]
async fn forward_start(
    state: State<'_, AppState>,
    session_id: String,
    local_bind: Option<String>,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> CmdResult<forward::ForwardView> {
    let profile = state
        .store
        .get_session(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    let params = ssh_params_from_profile(&state, &session_id)?;
    let bind = local_bind
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let id = Uuid::new_v4().to_string();
    let entry = forward::start(
        state.hostkeys.clone(),
        params,
        id,
        session_id,
        profile.name,
        bind,
        local_port,
        remote_host.trim().to_string(),
        remote_port,
    )
    .await
    .map_err(err_str)?;
    Ok(state.forwards.add(entry))
}

#[tauri::command]
async fn forward_start_dynamic(
    state: State<'_, AppState>,
    session_id: String,
    local_bind: Option<String>,
    local_port: u16,
) -> CmdResult<forward::ForwardView> {
    let profile = state
        .store
        .get_session(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    let params = ssh_params_from_profile(&state, &session_id)?;
    let bind = local_bind
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let id = Uuid::new_v4().to_string();
    let entry = forward::start_dynamic(
        state.hostkeys.clone(),
        params,
        id,
        session_id,
        profile.name,
        bind,
        local_port,
    )
    .await
    .map_err(err_str)?;
    Ok(state.forwards.add(entry))
}

#[tauri::command]
async fn forward_start_remote(
    state: State<'_, AppState>,
    session_id: String,
    remote_bind: Option<String>,
    remote_port: u16,
    target_host: String,
    target_port: u16,
) -> CmdResult<forward::ForwardView> {
    let profile = state
        .store
        .get_session(&session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    let params = ssh_params_from_profile(&state, &session_id)?;
    let bind = remote_bind
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let entry = forward::start_remote(
        state.hostkeys.clone(),
        params,
        Uuid::new_v4().to_string(),
        session_id,
        profile.name,
        bind,
        remote_port,
        target_host.trim().to_string(),
        target_port,
    )
    .await
    .map_err(err_str)?;
    Ok(state.forwards.add(entry))
}

#[tauri::command]
fn forward_list(state: State<'_, AppState>) -> Vec<forward::ForwardView> {
    state.forwards.list()
}

#[tauri::command]
async fn forward_test(
    state: State<'_, AppState>,
    id: String,
    target_host: Option<String>,
    target_port: Option<u16>,
) -> CmdResult<forward::ForwardTestResult> {
    let view = state
        .forwards
        .get(&id)
        .ok_or_else(|| "转发规则不存在或已停止".to_string())?;
    let params = ssh_params_from_profile(&state, &view.session_id)?;
    Ok(forward::test(
        state.hostkeys.clone(),
        params,
        view,
        target_host,
        target_port,
    )
    .await)
}

#[tauri::command]
fn forward_stop(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.forwards.remove(&id);
    Ok(())
}

// ---------- SSH 密钥生成 / 部署 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PubKeyEntry {
    path: String,
    content: String,
}

/// 扫描 ~/.ssh 下的 .pub 公钥文件，供部署时选择。
#[tauri::command]
fn list_ssh_pubkeys() -> Vec<PubKeyEntry> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(home.join(".ssh")) else {
        return Vec::new();
    };
    let mut keys: Vec<PubKeyEntry> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".pub")
        })
        .filter_map(|e| {
            std::fs::read_to_string(e.path())
                .ok()
                .map(|content| PubKeyEntry {
                    path: e.path().to_string_lossy().to_string(),
                    content: content.trim().to_string(),
                })
        })
        .filter(|k| !k.content.is_empty())
        .collect();
    keys.sort_by(|a, b| a.path.cmp(&b.path));
    keys
}

#[tauri::command]
async fn ssh_generate_key(name: String, comment: Option<String>) -> CmdResult<keys::GeneratedKey> {
    let comment = comment.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || keys::generate(&name, &comment))
        .await
        .map_err(|e| format!("生成任务失败: {e}"))?
        .map_err(err_str)
}

#[tauri::command]
async fn ssh_import_openssh_key(
    name: String,
    pem: String,
    passphrase: Option<String>,
) -> CmdResult<keys::GeneratedKey> {
    tauri::async_runtime::spawn_blocking(move || {
        keys::import_openssh_private(&name, &pem, passphrase.as_deref())
    })
    .await
    .map_err(|e| format!("导入任务失败: {e}"))?
    .map_err(err_str)
}

#[tauri::command]
async fn ssh_deploy_key(
    state: State<'_, AppState>,
    session_id: String,
    public_key: String,
) -> CmdResult<String> {
    let params = ssh_params_from_profile(&state, &session_id)?;
    keys::deploy(state.hostkeys.clone(), params, &public_key)
        .await
        .map_err(err_str)
}

// ---------- 配置导入导出 ----------

#[tauri::command]
fn config_export(state: State<'_, AppState>, path: String, passphrase: String) -> CmdResult<()> {
    portable::export(&state.store, &path, &passphrase).map_err(err_str)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    sessions: usize,
    providers: usize,
}

#[tauri::command]
fn config_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> CmdResult<ImportResult> {
    let (sessions, providers) =
        portable::import(&state.store, &path, &passphrase).map_err(err_str)?;
    Ok(ImportResult {
        sessions,
        providers,
    })
}

// ---------- 本机 SSH 密钥发现 ----------

/// 扫描 ~/.ssh，返回疑似私钥文件的完整路径，供连接对话框直接下拉选择。
#[tauri::command]
fn list_ssh_keys() -> Vec<String> {
    const SKIP: &[&str] = &[
        "known_hosts",
        "known_hosts.old",
        "config",
        "authorized_keys",
        "agent.sock",
    ];
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let dir = home.join(".ssh");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !name.ends_with(".pub") && !SKIP.contains(&name.as_str())
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    keys.sort();
    keys
}

// ---------- 窗口 ----------

#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> CmdResult<()> {
    let label = format!("term-{}", Uuid::new_v4().simple());
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
        .title("TermAI")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|e| format!("创建窗口失败: {e}"))?;
    Ok(())
}

// ---------- 会话管理 ----------

/// 前端提交的会话（密码为明文，仅在本次 IPC 中存在，落盘前加密）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInput {
    id: Option<String>,
    name: String,
    #[serde(default)]
    group: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    /// None = 不修改原有密码；Some("") = 清除
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
}

#[tauri::command]
fn sessions_list(state: State<'_, AppState>) -> Vec<SessionProfile> {
    // password_enc 是密文，回传前端无泄露风险
    state.store.sessions()
}

#[tauri::command]
async fn health_check_sessions(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
    timeout_ms: Option<u64>,
) -> CmdResult<Vec<HealthCheckResult>> {
    let timeout_ms = timeout_ms.unwrap_or(2500).clamp(500, 10_000);
    let timeout_duration = Duration::from_millis(timeout_ms);
    let sessions = state.store.sessions();
    let by_id: HashMap<String, SessionProfile> =
        sessions.into_iter().map(|s| (s.id.clone(), s)).collect();
    let targets: Vec<String> = if session_ids.is_empty() {
        by_id.keys().cloned().collect()
    } else {
        session_ids
    };
    let limiter = Arc::new(Semaphore::new(HEALTH_CHECK_CONCURRENCY));
    let mut tasks = Vec::with_capacity(targets.len());

    for session_id in targets {
        let profile = by_id.get(&session_id).cloned();
        let limiter = limiter.clone();
        tasks.push(tokio::spawn(check_session_tcp_health(
            session_id,
            profile,
            timeout_ms,
            timeout_duration,
            limiter,
        )));
    }

    let mut results = Vec::with_capacity(tasks.len());
    for task in tasks {
        if let Ok(result) = task.await {
            results.push(result);
        }
    }
    Ok(results)
}

#[tauri::command]
fn session_save(state: State<'_, AppState>, input: SessionInput) -> CmdResult<SessionProfile> {
    let existing = input
        .id
        .as_deref()
        .and_then(|id| state.store.get_session(id));
    let encrypt_or_keep =
        |new_val: &Option<String>, old: Option<String>| -> CmdResult<Option<String>> {
            match new_val {
                None => Ok(old),
                Some(s) if s.is_empty() => Ok(None),
                Some(s) => Ok(Some(vault::encrypt(s).map_err(err_str)?)),
            }
        };
    let profile = SessionProfile {
        id: input
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        name: input.name,
        group: input.group,
        host: input.host,
        port: input.port,
        username: input.username,
        auth_type: input.auth_type,
        password_enc: encrypt_or_keep(
            &input.password,
            existing.as_ref().and_then(|e| e.password_enc.clone()),
        )?,
        key_path: input.key_path,
        key_passphrase_enc: encrypt_or_keep(
            &input.key_passphrase,
            existing.as_ref().and_then(|e| e.key_passphrase_enc.clone()),
        )?,
    };
    state
        .store
        .upsert_session(profile.clone())
        .map_err(err_str)?;
    Ok(profile)
}

#[tauri::command]
fn session_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete_session(&id).map_err(err_str)
}

// ---------- 命令片段 ----------

#[tauri::command]
fn snippets_list(state: State<'_, AppState>) -> Vec<store::Snippet> {
    state.store.snippets()
}

#[tauri::command]
fn snippet_save(
    state: State<'_, AppState>,
    mut snippet: store::Snippet,
) -> CmdResult<store::Snippet> {
    if snippet.id.is_empty() {
        snippet.id = Uuid::new_v4().to_string();
    }
    state
        .store
        .upsert_snippet(snippet.clone())
        .map_err(err_str)?;
    Ok(snippet)
}

#[tauri::command]
fn snippet_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete_snippet(&id).map_err(err_str)
}

// ---------- 分组 ----------

#[tauri::command]
fn groups_list(state: State<'_, AppState>) -> Vec<String> {
    state.store.groups()
}

#[tauri::command]
fn group_add(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    state.store.group_add(name.trim()).map_err(err_str)
}

#[tauri::command]
fn group_rename(state: State<'_, AppState>, from: String, to: String) -> CmdResult<()> {
    state.store.group_rename(&from, to.trim()).map_err(err_str)
}

#[tauri::command]
fn group_delete(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    state.store.group_delete(&name).map_err(err_str)
}

#[tauri::command]
fn session_set_group(state: State<'_, AppState>, id: String, group: String) -> CmdResult<()> {
    state
        .store
        .session_set_group(&id, group.trim())
        .map_err(err_str)
}

// ---------- AI ----------

/// 回传前端的 Provider 视图：不含密文，只标记是否已配置 Key
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderView {
    id: String,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    has_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiConfigView {
    providers: Vec<ProviderView>,
    active_provider: Option<String>,
}

impl From<AiProviderConfig> for ProviderView {
    fn from(c: AiProviderConfig) -> Self {
        Self {
            id: c.id,
            name: c.name,
            kind: c.kind,
            base_url: c.base_url,
            model: c.model,
            has_key: c.api_key_enc.is_some(),
        }
    }
}

#[tauri::command]
fn ai_get_config(state: State<'_, AppState>) -> AiConfigView {
    let (providers, active) = state.store.providers();
    AiConfigView {
        providers: providers.into_iter().map(Into::into).collect(),
        active_provider: active,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderInput {
    id: Option<String>,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    /// None = 不修改；Some("") = 清除
    api_key: Option<String>,
}

#[tauri::command]
async fn ai_save_provider(state: State<'_, AppState>, input: ProviderInput) -> CmdResult<()> {
    let existing = input
        .id
        .as_deref()
        .and_then(|id| state.store.get_provider(id));
    let api_key_enc = match &input.api_key {
        None => existing.and_then(|e| e.api_key_enc),
        Some(s) if s.is_empty() => None,
        Some(s) => {
            let api_key = s.clone();
            let task = tauri::async_runtime::spawn_blocking(move || vault::encrypt(&api_key));
            let encrypted = tokio::time::timeout(std::time::Duration::from_secs(8), task)
                .await
                .map_err(|_| "加密 API Key 超时，请检查系统凭据管理器是否可用".to_string())?
                .map_err(|e| format!("加密任务失败: {e}"))?
                .map_err(err_str)?;
            Some(encrypted)
        }
    };
    let cfg = AiProviderConfig {
        id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        name: input.name,
        kind: input.kind,
        base_url: input.base_url,
        model: input.model,
        api_key_enc,
    };
    state.store.upsert_provider(cfg).map_err(err_str)
}

#[tauri::command]
fn ai_delete_provider(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete_provider(&id).map_err(err_str)
}

#[tauri::command]
fn ai_set_active(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.set_active_provider(&id).map_err(err_str)
}

#[tauri::command]
async fn ai_chat(
    state: State<'_, AppState>,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: Channel<AiEvent>,
) -> CmdResult<()> {
    let cfg = state
        .store
        .active_provider()
        .ok_or("尚未配置 AI Provider，请先到设置页添加")?;
    // 放到后台任务执行，命令立即返回，增量经 Channel 推送
    tauri::async_runtime::spawn(ai::chat_stream(cfg, system, messages, on_event));
    Ok(())
}

// ---------- 入口 ----------

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show-main", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-main" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Store::load().expect("初始化配置存储失败");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            setup_system_tray(app)?;
            Ok(())
        })
        .manage(AppState {
            terminals: TerminalRegistry::default(),
            sftp: sftp::SftpRegistry::default(),
            transfers: transfer::TransferManager::default(),
            agents: agent::AgentRegistry::default(),
            forwards: forward::ForwardRegistry::default(),
            hostkeys: std::sync::Arc::new(hostkeys::HostKeyStore::load()),
            store,
        })
        .invoke_handler(tauri::generate_handler![
            term_open_local,
            term_open_ssh,
            term_open_session,
            ssh_probe_env,
            agent_open,
            agent_run,
            agent_close,
            term_write,
            term_resize,
            term_close,
            sftp_open,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_mkdir,
            sftp_delete,
            sftp_rename,
            sftp_close,
            sftp_cli_exec,
            transfer_start,
            transfer_cancel,
            transfer_remote,
            forward_start,
            forward_start_dynamic,
            forward_start_remote,
            forward_list,
            forward_test,
            forward_stop,
            list_ssh_pubkeys,
            ssh_generate_key,
            ssh_import_openssh_key,
            ssh_deploy_key,
            list_ssh_keys,
            localfs::local_home,
            localfs::local_drives,
            localfs::local_list,
            localfs::local_mkdir,
            localfs::local_delete,
            localfs::local_reveal,
            config_export,
            config_import,
            open_new_window,
            sessions_list,
            health_check_sessions,
            session_save,
            session_delete,
            snippets_list,
            snippet_save,
            snippet_delete,
            groups_list,
            group_add,
            group_rename,
            group_delete,
            session_set_group,
            ai_get_config,
            ai_save_provider,
            ai_delete_provider,
            ai_set_active,
            ai_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
