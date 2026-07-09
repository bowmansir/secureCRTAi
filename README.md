# TermAI

[English](README.md) | [中文](README.zh.md)

**TermAI is an AI-native remote terminal manager.**

It brings SSH terminals, SFTP workflows, port forwarding, key utilities, and an AI operations assistant into one desktop app, helping engineers move from memorizing commands to describing intent, reviewing actions, and shipping fixes faster.

TermAI is not just a chat box beside a terminal. It is designed as an operations copilot that understands the active session, terminal output, and server context while keeping execution under user control.

## Highlights

### AI Operations Copilot

- Generate shell commands from natural language, such as "find the process using port 8080" or "show the largest directories".
- Explain terminal output, logs, and error messages in plain language.
- Diagnose recent terminal failures with optional terminal-output context.
- Agent mode can run confirmed steps through a dedicated SSH execution channel, with command output summarized and folded.
- AI conversations are isolated per tab, so switching sessions restores the right context.
- Multiple providers are supported, including Anthropic Claude, OpenAI-compatible APIs, DeepSeek, and local Ollama models.

### Professional Terminal Workspace

- Multi-tab workspace for local PowerShell and remote SSH sessions.
- Password and private-key authentication.
- Host groups, search, collapse, and drag-to-group workflows for large server fleets.
- Real-time connection, terminal, and transfer status feedback.
- Command palette for fast access to sessions, tools, and settings.
- Dark, midnight, and light themes.
- System tray support for background availability.

### SFTP and File Transfer

- Dual-pane SFTP for local and remote file operations.
- Server-to-server transfer without staging files on the local machine.
- Recursive directory upload, download, and remote transfer.
- Resume support for files larger than 800MB when safe to do so.
- Same-name, same-size files are skipped to avoid repeated transfers.
- Global transfer queue with speed, progress, status, and cancellation.
- Resizable SFTP table columns for long names and metadata-heavy directories.

### Built-in Tools

- Local forwarding, remote forwarding, and dynamic SOCKS5 proxy support.
- Each tunnel shows a copyable endpoint, traffic path, and built-in connectivity test.
- Generate Ed25519 SSH keys and deploy public keys to servers.
- Convert OpenSSH PEM private keys into local private-key files and `.pub` public keys.
- Export and import sessions and AI providers with password-based encryption.

### Security Model

- Passwords, key references, and API keys are not stored as plaintext business config.
- Sensitive data is encrypted at rest with AES-256-GCM, with the master key protected by the OS credential store.
- Portable export files use PBKDF2 + AES-256-GCM password encryption.
- AI-generated commands are inserted for review by default instead of being executed automatically.
- Agent execution is isolated from normal terminal interaction.
- SFTP views automatically fold the AI panel to keep file operations focused.

## Use Cases

- Managing many Linux servers from one desktop workspace.
- Switching quickly between terminals, file transfer, and log diagnosis.
- Centralizing common commands, error explanations, port forwarding, and key management.
- Debugging internal services, creating temporary proxies, transferring large files, and syncing directories.

## Tech Stack

- Tauri 2: Rust backend with the system WebView for a small desktop footprint.
- React 19 + TypeScript + Vite.
- xterm.js: terminal rendering engine.
- russh / russh-sftp: pure Rust SSH and SFTP stack.
- portable-pty: local terminal support, including Windows ConPTY.
- reqwest streaming: AI provider streaming responses.
- keyring + AES-GCM + PBKDF2: local credential protection and portable encrypted exports.

## Getting Started

```powershell
pnpm install
pnpm tauri dev
```

## Build

```powershell
pnpm tauri build
```

The packaged installers are generated under:

```text
src-tauri/target/release/bundle/
```

## Project Structure

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

## Docs

- [Product Plan](docs/PRODUCT_PLAN.md)
- [File Transfer Plan](docs/FILE_TRANSFER_PLAN.md)

## Product Direction

TermAI aims to become an AI-native alternative to SecureCRT and Xshell: keeping the reliability, status visibility, and fleet-management workflow of professional terminal tools, while deeply integrating AI into command generation, error diagnosis, contextual explanations, and controlled automation.
