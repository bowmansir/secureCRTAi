# TermAI

**TermAI 是一款 AI 原生的现代化远程终端管理工具。**  
它把 SSH 终端、SFTP 传输、端口转发、密钥工具和 AI 运维助手整合到一个桌面客户端里，让日常服务器运维从“记命令、查日志、来回复制”变成“描述目标、确认步骤、快速执行”。

**TermAI is an AI-native remote terminal manager.**  
It brings SSH terminals, SFTP workflows, port forwarding, key utilities, and an AI operations assistant into one desktop app, helping engineers move from memorizing commands to describing intent, reviewing actions, and shipping fixes faster.

> 目标不是把聊天框贴到终端旁边，而是让 AI 真正理解当前会话、输出和服务器上下文，成为可控、可追踪的运维协作层。  
> TermAI is not just a chat box beside a terminal. It is designed as an operations copilot that understands the active session, terminal output, and server context while keeping execution under user control.

## 核心亮点 / Highlights

### AI 运维助手 / AI Operations Copilot

- 自然语言生成命令：描述“查 8080 端口占用”“查看磁盘最大的目录”，AI 生成可插入终端的命令。
- 解释终端输出：把报错、日志、系统输出变成可读结论，减少来回搜索。
- 诊断最近报错：可携带当前终端最近输出作为上下文，让回答更贴近现场。
- Agent 模式：在 SSH 会话下通过独立执行通道分步执行命令，输出过程折叠展示，避免刷屏。
- 会话隔离：不同标签页的 AI 上下文互相隔离，切换标签后恢复对应对话。
- 多 Provider：支持 Anthropic Claude、OpenAI 兼容接口、DeepSeek、Ollama 本地模型等配置方式。

- Generate shell commands from natural language, such as “find the process using port 8080” or “show the largest directories”.
- Explain terminal output, logs, and error messages in plain language.
- Diagnose recent terminal failures with optional terminal-output context.
- Agent mode can run confirmed steps through a dedicated SSH execution channel, with command output summarized and folded.
- AI conversations are isolated per tab, so switching sessions restores the right context.
- Multiple providers are supported, including Anthropic Claude, OpenAI-compatible APIs, DeepSeek, and local Ollama models.

### 专业终端工作台 / Professional Terminal Workspace

- 多标签终端：本地 PowerShell 与远程 SSH 会话并行工作。
- SSH 认证：支持密码和私钥认证。
- 主机管理：分组、搜索、折叠、拖拽归组，适合几十到上百台服务器的运维场景。
- 状态反馈：主机在线状态、连接状态、终端行列、传输速率等信息集中展示。
- 命令面板：通过快捷入口快速打开会话、工具和设置。
- 主题系统：深色、极夜、浅色主题可选。
- 系统托盘：关闭窗口后可退到托盘，保持后台可恢复。

- Multi-tab workspace for local PowerShell and remote SSH sessions.
- Password and private-key authentication.
- Host groups, search, collapse, and drag-to-group workflows for large server fleets.
- Real-time connection, terminal, and transfer status feedback.
- Command palette for fast access to sessions, tools, and settings.
- Dark, midnight, and light themes.
- System tray support for background availability.

### SFTP 与传输 / SFTP and File Transfer

- 双栏 SFTP：本地与远程文件系统并排操作。
- 服务器间传输：从一台服务器直接传到另一台服务器，本地不落盘。
- 目录传输：支持目录递归上传、下载和服务器间传输。
- 大文件续传：800MB 以上文件在安全条件满足时启用断点续传。
- 增量优化：同名等大文件自动跳过，减少重复传输。
- 传输队列：全局进度面板展示速率、进度、状态和取消操作。
- 表格列宽：SFTP 文件名、大小、修改时间列支持拖拽调整宽度。

- Dual-pane SFTP for local and remote file operations.
- Server-to-server transfer without staging files on the local machine.
- Recursive directory upload, download, and remote transfer.
- Resume support for files larger than 800MB when safe to do so.
- Same-name, same-size files are skipped to avoid repeated transfers.
- Global transfer queue with speed, progress, status, and cancellation.
- Resizable SFTP table columns for long names and metadata-heavy directories.

### 工具箱 / Built-in Tools

- 端口转发：支持本地转发、远程转发和动态 SOCKS5 代理。
- 转发闭环：创建后展示可复制的访问地址、流量路径，并支持连通性测试。
- SSH 密钥：生成 Ed25519 密钥对，部署公钥到目标服务器。
- 证书转换：OpenSSH PEM 私钥转换为本机私钥文件与 `.pub` 公钥。
- 配置迁移：会话和 AI Provider 可加密导出，再导入到另一台机器。

- Local forwarding, remote forwarding, and dynamic SOCKS5 proxy support.
- Each tunnel shows a copyable endpoint, traffic path, and built-in connectivity test.
- Generate Ed25519 SSH keys and deploy public keys to servers.
- Convert OpenSSH PEM private keys into local private-key files and `.pub` public keys.
- Export and import sessions and AI providers with password-based encryption.

### 安全设计 / Security Model

- 密码、私钥引用和 API Key 不以明文配置形式暴露在业务代码中。
- 敏感数据使用 AES-256-GCM 加密落盘，主密钥托管在系统凭据管理器。
- 导出文件使用 PBKDF2 + AES-256-GCM 口令加密。
- AI 生成命令默认只插入终端，不自动执行；Agent 执行路径也独立于普通终端交互。
- SFTP 页面会自动折叠 AI 面板，减少文件操作时的干扰。

- Passwords, key references, and API keys are not stored as plaintext business config.
- Sensitive data is encrypted at rest with AES-256-GCM, with the master key protected by the OS credential store.
- Portable export files use PBKDF2 + AES-256-GCM password encryption.
- AI-generated commands are inserted for review by default instead of being executed automatically.
- SFTP views automatically fold the AI panel to keep file operations focused.

## 适用场景 / Use Cases

- 运维人员批量管理多台 Linux 服务器。
- 开发者需要在终端、文件传输和日志诊断之间频繁切换。
- 团队希望把常见命令、报错解释、端口转发和密钥管理集中到一个现代桌面工具里。
- 内网排障、临时代理、远程服务调试、大文件传输和目录同步。

- Managing many Linux servers from one desktop workspace.
- Switching quickly between terminals, file transfer, and log diagnosis.
- Centralizing common commands, error explanations, port forwarding, and key management.
- Debugging internal services, creating temporary proxies, transferring large files, and syncing directories.

## 技术栈 / Tech Stack

- Tauri 2: Rust backend with the system WebView for a small desktop footprint.
- React 19 + TypeScript + Vite.
- xterm.js: terminal rendering engine.
- russh / russh-sftp: pure Rust SSH and SFTP stack.
- portable-pty: local terminal support, including Windows ConPTY.
- reqwest streaming: AI provider streaming responses.
- keyring + AES-GCM + PBKDF2: local credential protection and portable encrypted exports.

## 快速开始 / Getting Started

```powershell
pnpm install
pnpm tauri dev
```

## 打包 / Build

```powershell
pnpm tauri build
```

打包产物会生成在：

```text
src-tauri/target/release/bundle/
```

The packaged installers are generated under:

```text
src-tauri/target/release/bundle/
```

## 项目结构 / Project Structure

```text
src/
  components/        Terminal view, session sidebar, AI panel, SFTP, tools, dialogs
  api.ts             Tauri command bridge
  types.ts           Shared frontend types

src-tauri/src/
  terminal/          Local PTY and SSH terminal sessions
  sftp.rs            SFTP client
  transfer.rs        Transfer queue, progress, directory transfer, large-file resume
  forward.rs         Local, remote, and dynamic port forwarding
  agent.rs           AI Agent execution channel over SSH
  keys.rs            SSH key generation and OpenSSH key import
  vault.rs           Credential encryption vault
  store.rs           Sessions and AI provider persistence
  ai.rs              AI provider abstraction and streaming chat

docs/
  PRODUCT_PLAN.md
  FILE_TRANSFER_PLAN.md
```

## 文档 / Docs

- [产品规划 / Product Plan](docs/PRODUCT_PLAN.md)
- [文件传输规划 / File Transfer Plan](docs/FILE_TRANSFER_PLAN.md)

## 产品方向 / Product Direction

TermAI 的方向是成为“AI 原生的 SecureCRT/Xshell 替代品”：保留专业终端工具的稳定性、状态反馈和批量管理能力，同时把 AI 深度嵌入命令生成、错误诊断、上下文解释和自动化执行路径。

TermAI aims to become an AI-native alternative to SecureCRT and Xshell: keeping the reliability, status visibility, and fleet-management workflow of professional terminal tools, while deeply integrating AI into command generation, error diagnosis, contextual explanations, and controlled automation.
