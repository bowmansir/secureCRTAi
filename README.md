# TermAI

[中文](README.md) | [English](README.en.md)

**TermAI 是一款 AI 原生的现代化远程终端管理工具。**

它把 SSH 终端、SFTP 传输、端口转发、密钥工具和 AI 运维助手整合到一个桌面客户端里，让日常服务器运维从“记命令、查日志、来回复制”变成“描述目标、确认步骤、快速执行”。

TermAI 的目标不是把聊天框贴到终端旁边，而是让 AI 真正理解当前会话、输出和服务器上下文，成为可控、可追踪的运维协作层。

## 核心亮点

### AI 运维助手

- 自然语言生成命令：描述“查 8080 端口占用”“查看磁盘最大的目录”，AI 生成可插入终端的命令。
- 解释终端输出：把报错、日志、系统输出变成可读结论，减少来回搜索。
- 诊断最近报错：可携带当前终端最近输出作为上下文，让回答更贴近现场。
- Agent 模式：在 SSH 会话下通过独立执行通道分步执行命令，输出过程折叠展示，避免刷屏。
- 会话隔离：不同标签页的 AI 上下文互相隔离，切换标签后恢复对应对话。
- 多 Provider：支持 Anthropic Claude、OpenAI 兼容接口、DeepSeek、Ollama 本地模型等配置方式。

### 专业终端工作台

- 多标签终端：本地 PowerShell 与远程 SSH 会话并行工作。
- SSH 认证：支持密码和私钥认证。
- 主机管理：分组、搜索、折叠、拖拽归组，适合几十到上百台服务器的运维场景。
- 状态反馈：主机在线状态、连接状态、终端行列、传输速率等信息集中展示。
- 命令面板：通过快捷入口快速打开会话、工具和设置。
- 主题系统：深色、极夜、浅色主题可选。
- 系统托盘：关闭窗口后可退到托盘，保持后台可恢复。

### SFTP 与传输

- 双栏 SFTP：本地与远程文件系统并排操作。
- 服务器间传输：从一台服务器直接传到另一台服务器，本地不落盘。
- 目录传输：支持目录递归上传、下载和服务器间传输。
- 大文件续传：800MB 以上文件在安全条件满足时启用断点续传。
- 增量优化：同名等大文件自动跳过，减少重复传输。
- 传输队列：全局进度面板展示速率、进度、状态和取消操作。
- 表格列宽：SFTP 文件名、大小、修改时间列支持拖拽调整宽度。

### 内置工具箱

- 端口转发：支持本地转发、远程转发和动态 SOCKS5 代理。
- 转发闭环：创建后展示可复制的访问地址、流量路径，并支持连通性测试。
- SSH 密钥：生成 Ed25519 密钥对，部署公钥到目标服务器。
- 证书转换：OpenSSH PEM 私钥转换为本机私钥文件与 `.pub` 公钥。
- 配置迁移：会话和 AI Provider 可加密导出，再导入到另一台机器。

### 安全设计

- 密码、私钥引用和 API Key 不以明文配置形式暴露在业务代码中。
- 敏感数据使用 AES-256-GCM 加密落盘，主密钥托管在系统凭据管理器。
- 导出文件使用 PBKDF2 + AES-256-GCM 口令加密。
- AI 生成命令默认只插入终端，不自动执行；Agent 执行路径也独立于普通终端交互。
- SFTP 页面会自动折叠 AI 面板，减少文件操作时的干扰。

## 适用场景

- 运维人员批量管理多台 Linux 服务器。
- 开发者需要在终端、文件传输和日志诊断之间频繁切换。
- 团队希望把常见命令、报错解释、端口转发和密钥管理集中到一个现代桌面工具里。
- 内网排障、临时代理、远程服务调试、大文件传输和目录同步。

## 技术栈

- Tauri 2：Rust 后端 + 系统 WebView，安装包小、内存占用低。
- React 19 + TypeScript + Vite。
- xterm.js：终端渲染引擎。
- russh / russh-sftp：纯 Rust SSH 与 SFTP 栈。
- portable-pty：本地终端支持，包含 Windows ConPTY。
- reqwest streaming：AI Provider 流式响应。
- keyring + AES-GCM + PBKDF2：本地凭据保护与加密导入导出。

## 快速开始

```powershell
pnpm install
pnpm tauri dev
```

## 打包

```powershell
pnpm tauri build
```

打包产物会生成在：

```text
src-tauri/target/release/bundle/
```

## 项目结构

```text
src/
  components/        终端视图、会话侧栏、AI 面板、SFTP、工具箱、弹窗
  api.ts             Tauri 命令桥接
  types.ts           前端共享类型

src-tauri/src/
  terminal/          本地 PTY 与 SSH 终端会话
  sftp.rs            SFTP 客户端
  transfer.rs        传输队列、进度、目录传输、大文件续传
  forward.rs         本地、远程、动态端口转发
  agent.rs           基于 SSH 的 AI Agent 执行通道
  keys.rs            SSH 密钥生成与 OpenSSH 私钥导入
  vault.rs           凭据加密保管库
  store.rs           会话与 AI Provider 持久化
  ai.rs              AI Provider 抽象与流式对话

docs/
  PRODUCT_PLAN.md
  FILE_TRANSFER_PLAN.md
```

## 文档

- [产品规划](docs/PRODUCT_PLAN.md)
- [文件传输规划](docs/FILE_TRANSFER_PLAN.md)

## 产品方向

TermAI 的方向是成为“AI 原生的 SecureCRT/Xshell 替代品”：保留专业终端工具的稳定性、状态反馈和批量管理能力，同时把 AI 深度嵌入命令生成、错误诊断、上下文解释和自动化执行路径。
