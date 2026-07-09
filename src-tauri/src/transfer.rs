//! 传输引擎：队列、进度/速率事件、目录递归、取消。
//! 同名等大文件跳过（增量同步），其余覆盖重传；不做按大小猜测的断点续传
//! （那会拼出损坏文件）。真正的续传需配合校验，留待队列持久化时一并做对。

use crate::sftp::SftpConn;
use anyhow::{anyhow, bail, Context};
use parking_lot::Mutex;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const CHUNK: usize = 64 * 1024;
const RESUME_THRESHOLD_BYTES: u64 = 800 * 1024 * 1024;
/// 进度事件节流间隔
const PROGRESS_INTERVAL_MS: u128 = 100;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransferEvent {
    /// 扫描完成，总量确定
    Started {
        total_bytes: u64,
        total_files: u32,
    },
    /// 开始传某个文件（相对展示名）
    File {
        name: String,
    },
    /// 该文件因目标等大而跳过
    Skipped {
        name: String,
    },
    Progress {
        transferred: u64,
        rate_bps: u64,
    },
    Done {
        transferred: u64,
        files: u32,
    },
    Cancelled,
    Error {
        message: String,
    },
}

#[derive(Default)]
pub struct TransferManager {
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TransferManager {
    pub fn register(&self, id: String) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().insert(id, flag.clone());
        flag
    }

    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.cancels.lock().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }

    /// 供任务结束后自清理
    pub fn map(&self) -> Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> {
        self.cancels.clone()
    }
}

struct Progress {
    events: Channel<TransferEvent>,
    transferred: u64,
    last_emit: Instant,
    window_start: Instant,
    window_bytes: u64,
    rate_bps: u64,
}

impl Progress {
    fn new(events: Channel<TransferEvent>) -> Self {
        Self {
            events,
            transferred: 0,
            last_emit: Instant::now(),
            window_start: Instant::now(),
            window_bytes: 0,
            rate_bps: 0,
        }
    }

    fn add(&mut self, n: u64) {
        self.transferred += n;
        self.window_bytes += n;
        let win = self.window_start.elapsed();
        if win.as_millis() >= 1000 {
            self.rate_bps = (self.window_bytes as f64 / win.as_secs_f64()) as u64;
            self.window_start = Instant::now();
            self.window_bytes = 0;
        }
        if self.last_emit.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            self.last_emit = Instant::now();
            let _ = self.events.send(TransferEvent::Progress {
                transferred: self.transferred,
                rate_bps: self.rate_bps,
            });
        }
    }

    fn add_existing(&mut self, n: u64) {
        if n == 0 {
            return;
        }
        self.transferred += n;
        self.last_emit = Instant::now();
        let _ = self.events.send(TransferEvent::Progress {
            transferred: self.transferred,
            rate_bps: self.rate_bps,
        });
    }
}

fn check_cancel(cancel: &AtomicBool) -> anyhow::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("__cancelled__");
    }
    Ok(())
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn resume_offset(source_size: u64, target_size: u64) -> Option<u64> {
    if source_size > RESUME_THRESHOLD_BYTES && target_size > 0 && target_size < source_size {
        Some(target_size)
    } else {
        None
    }
}

/// 传输入口：kind = "upload" | "download"，自动识别文件/目录。
pub async fn run(
    conn: Arc<SftpConn>,
    kind: String,
    local: String,
    remote: String,
    cancel: Arc<AtomicBool>,
    events: Channel<TransferEvent>,
) {
    let result = match kind.as_str() {
        "upload" => upload_entry(&conn, &local, &remote, &cancel, &events).await,
        "download" => download_entry(&conn, &local, &remote, &cancel, &events).await,
        other => Err(anyhow!("未知传输类型: {other}")),
    };
    match result {
        Ok((total, files)) => {
            let _ = events.send(TransferEvent::Done {
                transferred: total,
                files,
            });
        }
        Err(e) if e.to_string().contains("__cancelled__") => {
            let _ = events.send(TransferEvent::Cancelled);
        }
        Err(e) => {
            let _ = events.send(TransferEvent::Error {
                message: format!("{e:#}"),
            });
        }
    }
}

// ---------- 服务器间传输（A→B，本地不落盘，流式中转） ----------

pub async fn run_remote(
    src: Arc<SftpConn>,
    dst: Arc<SftpConn>,
    src_path: String,
    dst_path: String,
    cancel: Arc<AtomicBool>,
    events: Channel<TransferEvent>,
) {
    let result = remote_copy_entry(&src, &dst, &src_path, &dst_path, &cancel, &events).await;
    match result {
        Ok((total, files)) => {
            let _ = events.send(TransferEvent::Done {
                transferred: total,
                files,
            });
        }
        Err(e) if e.to_string().contains("__cancelled__") => {
            let _ = events.send(TransferEvent::Cancelled);
        }
        Err(e) => {
            let _ = events.send(TransferEvent::Error {
                message: format!("{e:#}"),
            });
        }
    }
}

/// 单文件从源服务器流式转发到目标服务器（读一块直接写一块，不落本地盘）
async fn remote_copy(
    src: &SftpConn,
    dst: &SftpConn,
    src_path: &str,
    dst_path: &str,
    cancel: &AtomicBool,
    events: &Channel<TransferEvent>,
) -> anyhow::Result<(u64, u32)> {
    let meta = src
        .sftp
        .metadata(src_path.to_string())
        .await
        .with_context(|| format!("读取源文件失败: {src_path}"))?;
    if meta.file_type().is_dir() {
        bail!("服务器间传输暂只支持单文件，不支持目录");
    }
    let size = meta.size.unwrap_or(0);
    let _ = events.send(TransferEvent::Started {
        total_bytes: size,
        total_files: 1,
    });
    let _ = events.send(TransferEvent::File {
        name: display_name(src_path),
    });

    let existing_size = dst
        .sftp
        .metadata(dst_path.to_string())
        .await
        .ok()
        .and_then(|m| m.size);
    if existing_size == Some(size) {
        let _ = events.send(TransferEvent::Skipped {
            name: display_name(src_path),
        });
        let mut progress = Progress::new(events.clone());
        progress.add_existing(size);
        return Ok((size, 1));
    }
    let offset = existing_size
        .and_then(|n| resume_offset(size, n))
        .unwrap_or(0);

    let mut rf = src
        .sftp
        .open(src_path.to_string())
        .await
        .with_context(|| format!("打开源文件失败: {src_path}"))?;
    if offset > 0 {
        rf.seek(SeekFrom::Start(offset)).await?;
    }
    let mut wf = dst
        .sftp
        .open_with_flags(
            dst_path.to_string(),
            if offset > 0 {
                OpenFlags::WRITE | OpenFlags::CREATE
            } else {
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
            },
        )
        .await
        .with_context(|| format!("创建目标文件失败: {dst_path}"))?;

    if offset > 0 {
        wf.seek(SeekFrom::Start(offset)).await?;
    }

    let mut progress = Progress::new(events.clone());
    progress.add_existing(offset);
    let mut buf = vec![0u8; CHUNK];
    loop {
        check_cancel(cancel)?;
        let n = rf.read(&mut buf).await.context("读取源服务器失败")?;
        if n == 0 {
            break;
        }
        wf.write_all(&buf[..n])
            .await
            .context("写入目标服务器失败")?;
        progress.add(n as u64);
    }
    wf.flush().await.ok();
    wf.shutdown().await.ok();
    Ok((progress.transferred, 1))
}

async fn remote_copy_entry(
    src: &SftpConn,
    dst: &SftpConn,
    src_path: &str,
    dst_path: &str,
    cancel: &AtomicBool,
    events: &Channel<TransferEvent>,
) -> anyhow::Result<(u64, u32)> {
    let meta = src
        .sftp
        .metadata(src_path.to_string())
        .await
        .with_context(|| format!("读取源路径失败: {src_path}"))?;

    if !meta.file_type().is_dir() {
        return remote_copy(src, dst, src_path, dst_path, cancel, events).await;
    }

    let mut files: Vec<(String, String, u64)> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    scan_remote_to_remote(src, src_path, dst_path, &mut files, &mut dirs).await?;

    let total_bytes: u64 = files.iter().map(|f| f.2).sum();
    let _ = events.send(TransferEvent::Started {
        total_bytes,
        total_files: files.len() as u32,
    });

    for d in &dirs {
        check_cancel(cancel)?;
        let _ = dst.sftp.create_dir(d.clone()).await;
    }

    let mut progress = Progress::new(events.clone());
    let mut done_files: u32 = 0;
    for (spath, dpath, size) in files {
        check_cancel(cancel)?;
        let name = display_name(&spath);
        let _ = events.send(TransferEvent::File { name: name.clone() });

        let existing_size = if size > 0 {
            dst.sftp
                .metadata(dpath.clone())
                .await
                .ok()
                .and_then(|m| m.size)
        } else {
            None
        };
        if existing_size == Some(size) {
            let _ = events.send(TransferEvent::Skipped { name });
            progress.add(size);
            done_files += 1;
            continue;
        }
        let offset = existing_size
            .and_then(|n| resume_offset(size, n))
            .unwrap_or(0);

        let mut rf = src
            .sftp
            .open(spath.clone())
            .await
            .with_context(|| format!("打开源文件失败: {spath}"))?;
        if offset > 0 {
            rf.seek(SeekFrom::Start(offset)).await?;
        }
        let mut wf = dst
            .sftp
            .open_with_flags(
                dpath.clone(),
                if offset > 0 {
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND
                } else {
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
                },
            )
            .await
            .with_context(|| format!("创建目标文件失败: {dpath}"))?;

        progress.add_existing(offset);
        let mut buf = vec![0u8; CHUNK];
        loop {
            check_cancel(cancel)?;
            let n = rf.read(&mut buf).await.context("读取源服务器失败")?;
            if n == 0 {
                break;
            }
            wf.write_all(&buf[..n])
                .await
                .context("写入目标服务器失败")?;
            progress.add(n as u64);
        }
        wf.flush().await.ok();
        wf.shutdown().await.ok();
        done_files += 1;
    }
    Ok((progress.transferred, done_files))
}

async fn scan_remote_to_remote(
    conn: &SftpConn,
    src_root: &str,
    dst_root: &str,
    files: &mut Vec<(String, String, u64)>,
    dirs: &mut Vec<String>,
) -> anyhow::Result<()> {
    dirs.push(dst_root.to_string());
    let mut queue = vec![(src_root.to_string(), dst_root.to_string())];
    while let Some((sd, dd)) = queue.pop() {
        let entries = conn
            .sftp
            .read_dir(sd.clone())
            .await
            .with_context(|| format!("读取源服务器目录失败: {sd}"))?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let spath = join_remote(&sd, &name);
            let dpath = join_remote(&dd, &name);
            if e.file_type().is_dir() {
                dirs.push(dpath.clone());
                queue.push((spath, dpath));
            } else {
                files.push((spath, dpath, e.metadata().size.unwrap_or(0)));
            }
        }
    }
    Ok(())
}

// ---------- 上传 ----------

async fn upload_entry(
    conn: &SftpConn,
    local: &str,
    remote: &str,
    cancel: &AtomicBool,
    events: &Channel<TransferEvent>,
) -> anyhow::Result<(u64, u32)> {
    let meta = tokio::fs::metadata(local)
        .await
        .with_context(|| format!("读取本地路径失败: {local}"))?;

    // 扫描阶段：统计总量
    let mut files: Vec<(String, String, u64)> = Vec::new(); // (local, remote, size)
    let mut dirs: Vec<String> = Vec::new();
    if meta.is_dir() {
        scan_local_dir(local, remote, &mut files, &mut dirs).await?;
    } else {
        files.push((local.to_string(), remote.to_string(), meta.len()));
    }
    let total_bytes: u64 = files.iter().map(|f| f.2).sum();
    let _ = events.send(TransferEvent::Started {
        total_bytes,
        total_files: files.len() as u32,
    });

    // 先建远端目录层级
    for d in &dirs {
        check_cancel(cancel)?;
        // 已存在时忽略错误
        let _ = conn.sftp.create_dir(d.clone()).await;
    }

    let mut progress = Progress::new(events.clone());
    let mut done_files: u32 = 0;
    for (lpath, rpath, size) in files {
        check_cancel(cancel)?;
        let name = display_name(&lpath);
        let _ = events.send(TransferEvent::File { name: name.clone() });

        // 目标已存在且等大：视为已传，跳过（增量同步）。其余一律覆盖重传，
        // 不做按大小猜测的断点续传（会拼出损坏文件）。
        let existing_size = if size > 0 {
            conn.sftp
                .metadata(rpath.clone())
                .await
                .ok()
                .and_then(|m| m.size)
        } else {
            None
        };
        if existing_size == Some(size) {
            let _ = events.send(TransferEvent::Skipped { name });
            progress.add(size);
            done_files += 1;
            continue;
        }
        let offset = existing_size
            .and_then(|n| resume_offset(size, n))
            .unwrap_or(0);

        let mut lf = tokio::fs::File::open(&lpath)
            .await
            .with_context(|| format!("打开本地文件失败: {lpath}"))?;
        if offset > 0 {
            lf.seek(SeekFrom::Start(offset)).await?;
        }
        let mut rf = conn
            .sftp
            .open_with_flags(
                rpath.clone(),
                if offset > 0 {
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND
                } else {
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
                },
            )
            .await
            .with_context(|| format!("创建远程文件失败: {rpath}"))?;

        progress.add_existing(offset);
        let mut buf = vec![0u8; CHUNK];
        loop {
            check_cancel(cancel)?;
            let n = lf.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n]).await.context("写入远程失败")?;
            progress.add(n as u64);
        }
        rf.flush().await.ok();
        rf.shutdown().await.ok();
        done_files += 1;
    }
    Ok((progress.transferred, done_files))
}

async fn scan_local_dir(
    local: &str,
    remote: &str,
    files: &mut Vec<(String, String, u64)>,
    dirs: &mut Vec<String>,
) -> anyhow::Result<()> {
    dirs.push(remote.to_string());
    // 迭代式 BFS，避免异步递归
    let mut queue = vec![(local.to_string(), remote.to_string())];
    while let Some((ld, rd)) = queue.pop() {
        let mut entries = tokio::fs::read_dir(&ld)
            .await
            .with_context(|| format!("读取本地目录失败: {ld}"))?;
        while let Some(e) = entries.next_entry().await? {
            let name = e.file_name().to_string_lossy().to_string();
            let lpath = e.path().to_string_lossy().to_string();
            let rpath = join_remote(&rd, &name);
            let meta = e.metadata().await?;
            if meta.is_dir() {
                dirs.push(rpath.clone());
                queue.push((lpath, rpath));
            } else if meta.is_file() {
                files.push((lpath, rpath, meta.len()));
            }
        }
    }
    Ok(())
}

// ---------- 下载 ----------

async fn download_entry(
    conn: &SftpConn,
    local: &str,
    remote: &str,
    cancel: &AtomicBool,
    events: &Channel<TransferEvent>,
) -> anyhow::Result<(u64, u32)> {
    let meta = conn
        .sftp
        .metadata(remote.to_string())
        .await
        .with_context(|| format!("读取远程路径失败: {remote}"))?;

    let mut files: Vec<(String, String, u64)> = Vec::new(); // (remote, local, size)
    let mut dirs: Vec<String> = Vec::new();
    if meta.file_type().is_dir() {
        scan_remote_dir(conn, remote, local, &mut files, &mut dirs).await?;
    } else {
        files.push((
            remote.to_string(),
            local.to_string(),
            meta.size.unwrap_or(0),
        ));
    }
    let total_bytes: u64 = files.iter().map(|f| f.2).sum();
    let _ = events.send(TransferEvent::Started {
        total_bytes,
        total_files: files.len() as u32,
    });

    for d in &dirs {
        check_cancel(cancel)?;
        tokio::fs::create_dir_all(d)
            .await
            .with_context(|| format!("创建本地目录失败: {d}"))?;
    }

    let mut progress = Progress::new(events.clone());
    let mut done_files: u32 = 0;
    for (rpath, lpath, size) in files {
        check_cancel(cancel)?;
        let name = display_name(&rpath);
        let _ = events.send(TransferEvent::File { name: name.clone() });

        // 目标已存在且等大则跳过，其余覆盖重传（不做按大小猜测的续传）
        let existing_size = if size > 0 {
            tokio::fs::metadata(&lpath).await.ok().map(|m| m.len())
        } else {
            None
        };
        if existing_size == Some(size) {
            let _ = events.send(TransferEvent::Skipped { name });
            progress.add(size);
            done_files += 1;
            continue;
        }
        let offset = existing_size
            .and_then(|n| resume_offset(size, n))
            .unwrap_or(0);
        progress.add_existing(offset);

        let mut rf = conn
            .sftp
            .open(rpath.clone())
            .await
            .with_context(|| format!("打开远程文件失败: {rpath}"))?;
        if offset > 0 {
            rf.seek(SeekFrom::Start(offset)).await?;
        }
        let mut lf = if offset > 0 {
            tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(true)
                .open(&lpath)
                .await
        } else {
            tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&lpath)
                .await
        }
        .with_context(|| format!("创建本地文件失败: {lpath}"))?;

        let mut buf = vec![0u8; CHUNK];
        loop {
            check_cancel(cancel)?;
            let n = rf.read(&mut buf).await.context("读取远程失败")?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n]).await.context("写入本地失败")?;
            progress.add(n as u64);
        }
        lf.flush().await.ok();
        done_files += 1;
    }
    Ok((progress.transferred, done_files))
}

async fn scan_remote_dir(
    conn: &SftpConn,
    remote: &str,
    local: &str,
    files: &mut Vec<(String, String, u64)>,
    dirs: &mut Vec<String>,
) -> anyhow::Result<()> {
    dirs.push(local.to_string());
    let mut queue = vec![(remote.to_string(), local.to_string())];
    while let Some((rd, ld)) = queue.pop() {
        let entries = conn
            .sftp
            .read_dir(rd.clone())
            .await
            .with_context(|| format!("读取远程目录失败: {rd}"))?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let rpath = join_remote(&rd, &name);
            let lpath = Path::new(&ld).join(&name).to_string_lossy().to_string();
            if e.file_type().is_dir() {
                dirs.push(lpath.clone());
                queue.push((rpath, lpath));
            } else {
                files.push((rpath, lpath, e.metadata().size.unwrap_or(0)));
            }
        }
    }
    Ok(())
}

fn display_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

#[cfg(test)]
mod resume_smoke_tests {
    use super::*;
    use crate::hostkeys::HostKeyStore;
    use crate::sftp;
    use crate::terminal::ssh::SshParams;
    use anyhow::{bail, Context};
    use serde_json::Value;
    use std::process::Command;
    use tokio::time::{sleep, Duration};

    const USER: &str = "termai";
    const PASS: &str = "resume-pass";
    const FULL_SIZE: u64 = 841 * 1024 * 1024;
    const PARTIAL_SIZE: u64 = 512 * 1024 * 1024;

    #[derive(Clone, Debug)]
    struct SeenEvent {
        kind: String,
        transferred: Option<u64>,
    }

    struct DockerGuard {
        names: Vec<String>,
    }

    impl DockerGuard {
        fn new(names: Vec<String>) -> Self {
            Self { names }
        }
    }

    impl Drop for DockerGuard {
        fn drop(&mut self) {
            for name in &self.names {
                let _ = Command::new("docker").args(["rm", "-f", name]).output();
            }
        }
    }

    fn docker(args: Vec<String>) -> anyhow::Result<String> {
        let rendered = args.join(" ");
        let output = Command::new("docker")
            .args(&args)
            .output()
            .with_context(|| format!("failed to run docker {rendered}"))?;
        if !output.status.success() {
            bail!(
                "docker {rendered} failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn free_ports() -> anyhow::Result<(u16, u16)> {
        let first = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        let second = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        Ok((first.local_addr()?.port(), second.local_addr()?.port()))
    }

    fn start_sftp_container(name: &str, port: u16) -> anyhow::Result<()> {
        let port_map = format!("127.0.0.1:{port}:22");
        docker(vec![
            "run".into(),
            "-d".into(),
            "--rm".into(),
            "--name".into(),
            name.to_string(),
            "-p".into(),
            port_map,
            "atmoz/sftp:latest".into(),
            format!("{USER}:{PASS}:::upload"),
        ])?;
        Ok(())
    }

    fn prepare_source_files(container: &str) -> anyhow::Result<()> {
        let base = format!("/home/{USER}/upload");
        let command = format!(
            "set -eu; mkdir -p {base}/dir; \
             truncate -s {FULL_SIZE} {base}/single.bin; \
             truncate -s {FULL_SIZE} {base}/dir/large-in-dir.bin; \
             chown -R {USER} {base}"
        );
        docker(vec![
            "exec".into(),
            container.to_string(),
            "sh".into(),
            "-lc".into(),
            command,
        ])?;
        Ok(())
    }

    fn prepare_partial_targets(container: &str) -> anyhow::Result<()> {
        let base = format!("/home/{USER}/upload");
        let command = format!(
            "set -eu; mkdir -p {base}/dir; \
             truncate -s {PARTIAL_SIZE} {base}/single.bin; \
             truncate -s {PARTIAL_SIZE} {base}/dir/large-in-dir.bin; \
             chown -R {USER} {base}"
        );
        docker(vec![
            "exec".into(),
            container.to_string(),
            "sh".into(),
            "-lc".into(),
            command,
        ])?;
        Ok(())
    }

    fn remote_size(container: &str, path: &str) -> anyhow::Result<u64> {
        let command = format!("stat -c %s {path}");
        let out = docker(vec![
            "exec".into(),
            container.to_string(),
            "sh".into(),
            "-lc".into(),
            command,
        ])?;
        out.trim()
            .parse::<u64>()
            .with_context(|| format!("failed to parse remote size from {out:?}"))
    }

    async fn open_sftp(port: u16) -> anyhow::Result<Arc<SftpConn>> {
        let params = SshParams {
            host: "127.0.0.1".to_string(),
            port,
            username: USER.to_string(),
            password: Some(PASS.to_string()),
            key_path: None,
            key_passphrase: None,
        };

        let mut last_error = String::new();
        for _ in 0..60 {
            match sftp::open(Arc::new(HostKeyStore::default()), params.clone()).await {
                Ok((conn, _)) => return Ok(conn),
                Err(err) => {
                    last_error = format!("{err:#}");
                    sleep(Duration::from_millis(500)).await;
                }
            }
        }
        bail!("SFTP container on port {port} did not become ready: {last_error}");
    }

    fn event_channel(events: Arc<Mutex<Vec<SeenEvent>>>) -> Channel<TransferEvent> {
        Channel::new(move |body| {
            if let Ok(value) = body.deserialize::<Value>() {
                events.lock().push(SeenEvent {
                    kind: value
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    transferred: value.get("transferred").and_then(Value::as_u64),
                });
            }
            Ok(())
        })
    }

    fn assert_resumed(events: &Arc<Mutex<Vec<SeenEvent>>>, label: &str) {
        let snapshot = events.lock().clone();
        assert!(
            !snapshot.iter().any(|event| event.kind == "error"),
            "{label} transfer emitted error: {snapshot:?}"
        );
        assert!(
            snapshot
                .iter()
                .any(|event| event.kind == "progress" && event.transferred == Some(PARTIAL_SIZE)),
            "{label} transfer did not report existing partial bytes: {snapshot:?}"
        );
        assert!(
            snapshot
                .iter()
                .any(|event| event.kind == "done" && event.transferred == Some(FULL_SIZE)),
            "{label} transfer did not finish at full size: {snapshot:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires Docker and TERMAI_RESUME_SMOKE=1"]
    async fn resumes_large_remote_file_and_directory_transfers() -> anyhow::Result<()> {
        if std::env::var("TERMAI_RESUME_SMOKE").ok().as_deref() != Some("1") {
            eprintln!("skipped; set TERMAI_RESUME_SMOKE=1 to run the Docker smoke test");
            return Ok(());
        }

        let (src_port, dst_port) = free_ports()?;
        let suffix = std::process::id();
        let src_name = format!("termai-resume-src-{suffix}");
        let dst_name = format!("termai-resume-dst-{suffix}");
        let _guard = DockerGuard::new(vec![src_name.clone(), dst_name.clone()]);

        start_sftp_container(&src_name, src_port)?;
        start_sftp_container(&dst_name, dst_port)?;
        prepare_source_files(&src_name)?;
        prepare_partial_targets(&dst_name)?;

        let src = open_sftp(src_port).await?;
        let dst = open_sftp(dst_port).await?;

        let single_events = Arc::new(Mutex::new(Vec::new()));
        run_remote(
            src.clone(),
            dst.clone(),
            "/upload/single.bin".to_string(),
            "/upload/single.bin".to_string(),
            Arc::new(AtomicBool::new(false)),
            event_channel(single_events.clone()),
        )
        .await;
        assert_eq!(
            remote_size(&dst_name, &format!("/home/{USER}/upload/single.bin"))?,
            FULL_SIZE
        );
        assert_resumed(&single_events, "single file");

        let dir_events = Arc::new(Mutex::new(Vec::new()));
        run_remote(
            src,
            dst,
            "/upload/dir".to_string(),
            "/upload/dir".to_string(),
            Arc::new(AtomicBool::new(false)),
            event_channel(dir_events.clone()),
        )
        .await;
        assert_eq!(
            remote_size(
                &dst_name,
                &format!("/home/{USER}/upload/dir/large-in-dir.bin")
            )?,
            FULL_SIZE
        );
        assert_resumed(&dir_events, "directory");

        Ok(())
    }
}
