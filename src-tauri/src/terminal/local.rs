use super::{TermEvent, TermSession};
use anyhow::Context;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::ipc::Channel;

pub struct LocalPtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl TermSession for LocalPtySession {
    fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.lock().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn close(&self) {
        let _ = self.killer.lock().kill();
    }
}

/// 打开本地 shell（Windows 默认 PowerShell），输出经 Channel 推给前端。
pub fn open(
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> anyhow::Result<Arc<LocalPtySession>> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty failed")?;

    let program = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(program);
    configure_terminal_env(&mut cmd);
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .context("spawn shell failed")?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    // portable-pty 是阻塞 IO，读取放独立线程
    let events = on_event.clone();
    std::thread::spawn(move || {
        let mut child = child;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if events
                        .send(TermEvent::Data {
                            bytes: buf[..n].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = child.wait();
        let _ = events.send(TermEvent::Exit { message: None });
    });

    let _ = on_event.send(TermEvent::Connected);

    Ok(Arc::new(LocalPtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
    }))
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn configure_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TermAI");
    cmd.env("CLICOLOR", "1");
}

#[cfg(test)]
mod tests {
    use super::configure_terminal_env;
    use portable_pty::CommandBuilder;

    #[test]
    fn local_terminal_overrides_dumb_term() {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.env("TERM", "dumb");

        configure_terminal_env(&mut cmd);

        assert_eq!(
            cmd.get_env("TERM").and_then(|v| v.to_str()),
            Some("xterm-256color")
        );
        assert_eq!(
            cmd.get_env("COLORTERM").and_then(|v| v.to_str()),
            Some("truecolor")
        );
        assert_eq!(
            cmd.get_env("TERM_PROGRAM").and_then(|v| v.to_str()),
            Some("TermAI")
        );
    }
}
