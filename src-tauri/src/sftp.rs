//! SFTP 客户端：基于已认证的 russh 连接打开 sftp 子系统。

use crate::hostkeys::HostKeyStore;
use crate::terminal::ssh::{connect_and_auth, ClientHandler, SshParams};
use anyhow::Context;
use parking_lot::Mutex;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

pub struct SftpConn {
    /// 连接句柄必须与 SftpSession 一同存活
    _handle: Handle<ClientHandler>,
    pub sftp: SftpSession,
}

#[derive(Default)]
pub struct SftpRegistry {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
}

impl SftpRegistry {
    pub fn insert(&self, id: String, conn: Arc<SftpConn>) {
        self.conns.lock().insert(id, conn);
    }

    pub fn get(&self, id: &str) -> Option<Arc<SftpConn>> {
        self.conns.lock().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<SftpConn>> {
        self.conns.lock().remove(id)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix 时间戳（秒），可能缺失
    pub mtime: Option<u32>,
}

pub async fn open(
    store: Arc<HostKeyStore>,
    params: SshParams,
) -> anyhow::Result<(Arc<SftpConn>, String)> {
    let handle = connect_and_auth(store, &params).await?;
    let channel = handle.channel_open_session().await?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("服务器不支持 SFTP 子系统")?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .context("初始化 SFTP 会话失败")?;
    let home = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());
    Ok((
        Arc::new(SftpConn {
            _handle: handle,
            sftp,
        }),
        home,
    ))
}

pub async fn list_dir(conn: &SftpConn, path: &str) -> anyhow::Result<Vec<FileEntry>> {
    let entries = conn
        .sftp
        .read_dir(path)
        .await
        .with_context(|| format!("读取目录失败: {path}"))?;
    let mut out: Vec<FileEntry> = entries
        .map(|e| {
            let meta = e.metadata();
            FileEntry {
                name: e.file_name(),
                is_dir: e.file_type().is_dir(),
                size: meta.size.unwrap_or(0),
                mtime: meta.mtime,
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    // 目录优先，再按名称排序
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub async fn download(conn: &SftpConn, remote: &str, local: &str) -> anyhow::Result<()> {
    let mut rf = conn
        .sftp
        .open(remote)
        .await
        .with_context(|| format!("打开远程文件失败: {remote}"))?;
    let mut lf = tokio::fs::File::create(local)
        .await
        .with_context(|| format!("创建本地文件失败: {local}"))?;
    tokio::io::copy(&mut rf, &mut lf)
        .await
        .context("下载失败")?;
    Ok(())
}

pub async fn upload(conn: &SftpConn, local: &str, remote: &str) -> anyhow::Result<()> {
    let mut lf = tokio::fs::File::open(local)
        .await
        .with_context(|| format!("打开本地文件失败: {local}"))?;
    let mut rf = conn
        .sftp
        .create(remote)
        .await
        .with_context(|| format!("创建远程文件失败: {remote}"))?;
    tokio::io::copy(&mut lf, &mut rf)
        .await
        .context("上传失败")?;
    Ok(())
}
