//! SFTP 命令行会话：解析 sftp> 交互命令，get/put 交回前端走传输队列。

use crate::sftp::SftpConn;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResult {
    pub output: String,
    pub cwd: String,
    pub lcwd: String,
    /// get/put 时由前端调用传输引擎执行
    pub transfer: Option<CliTransfer>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTransfer {
    pub kind: String, // "upload" | "download"
    pub local: String,
    pub remote: String,
    pub title: String,
}

const HELP: &str = "\
可用命令：
  ls [路径]        列出远程目录        ll [路径]   详细列表
  cd <路径>        切换远程目录        pwd         显示远程目录
  lls [路径]       列出本地目录        lcd <路径>  切换本地目录
  lpwd             显示本地目录
  get <远程文件> [本地名]   下载（进传输队列，支持目录与断点续传）
  put <本地文件> [远程名]   上传（同上）
  mkdir <路径>     远程建目录          rm <文件>   删除远程文件
  rmdir <目录>     删除远程空目录      mv <旧> <新> 重命名
  clear            清屏                help        帮助";

fn join_remote(cwd: &str, p: &str) -> String {
    if p.starts_with('/') {
        p.to_string()
    } else if cwd.ends_with('/') {
        format!("{cwd}{p}")
    } else {
        format!("{cwd}/{p}")
    }
}

fn join_local(lcwd: &str, p: &str) -> String {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        p.to_string()
    } else {
        std::path::Path::new(lcwd)
            .join(p)
            .to_string_lossy()
            .to_string()
    }
}

fn base_name(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

fn fmt_size(n: u64) -> String {
    if n < 1024 {
        format!("{n}")
    } else if n < 1024 * 1024 {
        format!("{:.1}K", n as f64 / 1024.0)
    } else if n < 1024 * 1024 * 1024 {
        format!("{:.1}M", n as f64 / 1024.0 / 1024.0)
    } else {
        format!("{:.2}G", n as f64 / 1024.0 / 1024.0 / 1024.0)
    }
}

/// 按空白拆分命令行，支持双引号包路径
fn tokenize(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub async fn exec(conn: &SftpConn, line: &str, cwd: &str, lcwd: &str) -> CliResult {
    let mut r = CliResult {
        output: String::new(),
        cwd: cwd.to_string(),
        lcwd: lcwd.to_string(),
        transfer: None,
    };
    let tokens = tokenize(line);
    let Some(cmd) = tokens.first().map(|s| s.as_str()) else {
        return r;
    };
    let arg1 = tokens.get(1).map(|s| s.as_str());
    let arg2 = tokens.get(2).map(|s| s.as_str());

    match cmd {
        "help" | "?" => r.output = HELP.to_string(),
        "pwd" => r.output = cwd.to_string(),
        "lpwd" => r.output = lcwd.to_string(),
        "ls" | "ll" => {
            let path = arg1
                .map(|p| join_remote(cwd, p))
                .unwrap_or_else(|| cwd.to_string());
            match conn.sftp.read_dir(path).await {
                Ok(entries) => {
                    let mut items: Vec<_> = entries
                        .filter(|e| e.file_name() != "." && e.file_name() != "..")
                        .collect();
                    items.sort_by_key(|e| (!e.file_type().is_dir(), e.file_name().to_lowercase()));
                    let lines: Vec<String> = items
                        .iter()
                        .map(|e| {
                            let name = if e.file_type().is_dir() {
                                format!("{}/", e.file_name())
                            } else {
                                e.file_name()
                            };
                            if cmd == "ll" {
                                let m = e.metadata();
                                format!("{:>8}  {}", fmt_size(m.size.unwrap_or(0)), name)
                            } else {
                                name
                            }
                        })
                        .collect();
                    r.output = if lines.is_empty() {
                        "(空目录)".into()
                    } else {
                        lines.join("\n")
                    };
                }
                Err(e) => r.output = format!("ls 失败: {e}"),
            }
        }
        "cd" => match arg1 {
            Some(p) => {
                let target = join_remote(cwd, p);
                match conn.sftp.canonicalize(target.clone()).await {
                    Ok(canon) => match conn.sftp.read_dir(canon.clone()).await {
                        Ok(_) => r.cwd = canon,
                        Err(e) => r.output = format!("cd 失败: {e}"),
                    },
                    Err(e) => r.output = format!("cd 失败: {e}"),
                }
            }
            None => r.output = "用法: cd <路径>".into(),
        },
        "lls" => {
            let path = arg1
                .map(|p| join_local(lcwd, p))
                .unwrap_or_else(|| lcwd.to_string());
            match std::fs::read_dir(&path) {
                Ok(entries) => {
                    let mut lines: Vec<String> = entries
                        .flatten()
                        .map(|e| {
                            let is_dir = e.path().is_dir();
                            let name = e.file_name().to_string_lossy().to_string();
                            if is_dir {
                                format!("{name}/")
                            } else {
                                name
                            }
                        })
                        .collect();
                    lines.sort();
                    r.output = if lines.is_empty() {
                        "(空目录)".into()
                    } else {
                        lines.join("\n")
                    };
                }
                Err(e) => r.output = format!("lls 失败: {e}"),
            }
        }
        "lcd" => match arg1 {
            Some(p) => {
                let target = join_local(lcwd, p);
                if std::path::Path::new(&target).is_dir() {
                    r.lcwd = std::fs::canonicalize(&target)
                        .map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
                        .unwrap_or(target);
                } else {
                    r.output = format!("lcd 失败: 目录不存在 {target}");
                }
            }
            None => r.output = "用法: lcd <路径>".into(),
        },
        "get" => match arg1 {
            Some(remote_name) => {
                let remote = join_remote(cwd, remote_name);
                let local_name = arg2
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| base_name(remote_name));
                let local = join_local(lcwd, &local_name);
                r.output = format!("已加入下载队列: {remote} -> {local}（进度见传输面板）");
                r.transfer = Some(CliTransfer {
                    kind: "download".into(),
                    local,
                    remote,
                    title: base_name(remote_name),
                });
            }
            None => r.output = "用法: get <远程文件> [本地名]".into(),
        },
        "put" => match arg1 {
            Some(local_name) => {
                let local = join_local(lcwd, local_name);
                if !std::path::Path::new(&local).exists() {
                    r.output = format!("put 失败: 本地文件不存在 {local}");
                } else {
                    let remote_name = arg2
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| base_name(local_name));
                    let remote = join_remote(cwd, &remote_name);
                    r.output = format!("已加入上传队列: {local} -> {remote}（进度见传输面板）");
                    r.transfer = Some(CliTransfer {
                        kind: "upload".into(),
                        local,
                        remote,
                        title: base_name(local_name),
                    });
                }
            }
            None => r.output = "用法: put <本地文件> [远程名]".into(),
        },
        "mkdir" => match arg1 {
            Some(p) => {
                r.output = match conn.sftp.create_dir(join_remote(cwd, p)).await {
                    Ok(_) => format!("已创建目录 {p}"),
                    Err(e) => format!("mkdir 失败: {e}"),
                }
            }
            None => r.output = "用法: mkdir <路径>".into(),
        },
        "rm" => match arg1 {
            Some(p) => {
                r.output = match conn.sftp.remove_file(join_remote(cwd, p)).await {
                    Ok(_) => format!("已删除 {p}"),
                    Err(e) => format!("rm 失败: {e}"),
                }
            }
            None => r.output = "用法: rm <文件>".into(),
        },
        "rmdir" => match arg1 {
            Some(p) => {
                r.output = match conn.sftp.remove_dir(join_remote(cwd, p)).await {
                    Ok(_) => format!("已删除目录 {p}"),
                    Err(e) => format!("rmdir 失败: {e}"),
                }
            }
            None => r.output = "用法: rmdir <目录>".into(),
        },
        "mv" | "rename" => match (arg1, arg2) {
            (Some(a), Some(b)) => {
                r.output = match conn
                    .sftp
                    .rename(join_remote(cwd, a), join_remote(cwd, b))
                    .await
                {
                    Ok(_) => format!("{a} -> {b}"),
                    Err(e) => format!("mv 失败: {e}"),
                }
            }
            _ => r.output = "用法: mv <旧名> <新名>".into(),
        },
        other => r.output = format!("未知命令: {other}（输入 help 查看帮助）"),
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_basic() {
        assert_eq!(tokenize("get a b"), vec!["get", "a", "b"]);
        assert_eq!(tokenize("  ls   /tmp  "), vec!["ls", "/tmp"]);
        assert_eq!(tokenize(""), Vec::<String>::new());
        assert_eq!(tokenize("pwd"), vec!["pwd"]);
    }

    #[test]
    fn tokenize_quoted_paths() {
        // 双引号内的空格不拆分
        assert_eq!(
            tokenize(r#"get "my file.txt" dest"#),
            vec!["get", "my file.txt", "dest"]
        );
        assert_eq!(tokenize(r#"cd "a b/c d""#), vec!["cd", "a b/c d"]);
    }

    #[test]
    fn join_remote_paths() {
        // 绝对路径原样返回
        assert_eq!(join_remote("/home", "/etc/passwd"), "/etc/passwd");
        // 相对路径拼接，处理末尾斜杠
        assert_eq!(join_remote("/home", "file"), "/home/file");
        assert_eq!(join_remote("/home/", "file"), "/home/file");
        assert_eq!(join_remote("/", "x"), "/x");
    }

    #[test]
    fn base_name_extracts_last_component() {
        assert_eq!(base_name("/a/b/c.txt"), "c.txt");
        assert_eq!(base_name(r"C:\dir\f.log"), "f.log");
        assert_eq!(base_name("plain"), "plain");
        assert_eq!(base_name("/trailing/"), "");
    }

    #[test]
    fn fmt_size_units() {
        assert_eq!(fmt_size(512), "512");
        assert_eq!(fmt_size(1024), "1.0K");
        assert_eq!(fmt_size(1536), "1.5K");
        assert_eq!(fmt_size(1024 * 1024), "1.0M");
        assert_eq!(fmt_size(1024 * 1024 * 1024), "1.00G");
    }
}
