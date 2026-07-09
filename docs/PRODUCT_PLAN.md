# TermAI — 产品规划（对标 SecureCRT 的现代化 AI 终端）

> 定位：一款现代化、开源友好、AI 原生的远程终端管理工具。
> 对标 SecureCRT，目标是在「连接管理 + 终端体验 + 智能辅助」三个维度全面超越。

## 1. 竞品分析摘要

| 维度 | SecureCRT | 本产品目标 |
|------|-----------|-----------|
| 协议 | SSH1/2, Telnet, Serial, Rlogin | SSH2、本地终端（MVP）；Serial/Telnet/SFTP（二期） |
| UI | Win32 老式界面 | 现代化 UI（Tauri 2 + React），深色主题、命令面板 |
| 会话管理 | 树形会话库 | 树形 + 搜索 + 标签分组 + 凭据加密保管库 |
| 脚本 | VBScript/Python | 二期：JS 脚本 + 录制回放 |
| AI | 无 | AI 原生：命令生成、输出解释、报错诊断、会话上下文感知 |
| 更新 | 缓慢、闭源 | 快速迭代、跨平台 |
| 资源占用 | 低 | Tauri 原生壳，安装包 <15MB，内存远低于 Electron 方案 |

## 2. 技术选型（已确认）

- **壳**：Tauri 2（Rust 后端 + 系统 WebView）
- **前端**：React 18 + TypeScript + Vite + xterm.js（@xterm/xterm，VS Code 同款终端引擎）
- **SSH**：russh（纯 Rust，无 OpenSSL 依赖）
- **本地终端**：portable-pty（Windows ConPTY / Unix pty，天然跨平台）
- **凭据安全**：主密钥存 OS 凭据管理器（keyring crate → Windows Credential Manager），
  会话密码用 AES-256-GCM 加密后落盘，密钥不出本机
- **AI**：Rust 侧统一 Provider 抽象（避免 WebView CORS），流式输出经 Tauri Channel 推给前端
  - 默认支持：Anthropic Claude / OpenAI 兼容接口 / Ollama 本地模型
  - 用户自填 API Key / Base URL，企业内网模型即配即用
- **平台**：Windows 优先（ConPTY），架构保持 macOS/Linux 可移植

## 3. 架构

```
┌────────────────────────── WebView (React + TS) ──────────────────────────┐
│  TabBar / 终端区(xterm.js) / 会话管理侧栏 / AI 助手面板 / 设置           │
└──────────────────────┬───────────────────────────────────────────────────┘
                       │ Tauri IPC（invoke + Channel 流式事件）
┌──────────────────────┴───────────────────────────────────────────────────┐
│                            Rust Core                                      │
│  terminal/  会话注册表：SSH(russh) 与本地 PTY(portable-pty) 统一 Trait    │
│  vault/     凭据保管库：keyring 主密钥 + AES-GCM 加密存储                 │
│  store/     会话配置持久化（JSON，密码只存密文）                          │
│  ai/        Provider 抽象（anthropic / openai 兼容 / ollama），SSE 流式   │
└───────────────────────────────────────────────────────────────────────────┘
```

关键数据流：
- 终端输出：Rust 读取 SSH channel / PTY → Tauri Channel → xterm.write()
- 终端输入：xterm.onData → invoke("term_write") → Rust 写入
- AI 上下文：前端维护每个终端最近 N 行输出环形缓冲，按需随提问发送

## 4. MVP 功能清单（本期交付）

1. **终端核心**
   - 多标签页；本地 PowerShell 终端（ConPTY）
   - SSH2 连接：密码 / 私钥（含 passphrase）认证；窗口 resize 同步
   - xterm.js：真彩色、链接识别、复制粘贴、字体/主题
2. **会话管理**
   - 会话的增删改查、分组文件夹、搜索、双击连接
   - 密码 AES-GCM 加密存储，主密钥托管于 Windows 凭据管理器
3. **AI 助手（差异化核心）**
   - 侧边 AI 面板，流式对话
   - `自然语言 → 命令`：生成命令一键插入当前终端（不自动执行，用户确认）
   - `解释选中输出 / 诊断报错`：把终端最近输出作为上下文发给模型
   - 多 Provider 配置页：Anthropic / OpenAI 兼容 / Ollama，Key 存入加密保管库

## 5. 路线图

- **v0.1（MVP，本期）**：上述功能清单 + SFTP 文件面板 + 克隆会话 + 多窗口
- **v0.2**：端口转发、Telnet/Serial、连接保活与自动重连、known_hosts 指纹校验
- **v0.3**：脚本引擎（JS）、操作录制回放、键映射、Zmodem
- **v0.4**：AI Agent 模式（多步运维任务、带确认的自动执行）、团队会话库同步（自托管）
- **v1.0**：三平台正式发布、企业策略（审计日志、跳板机、堡垒机集成）

## 6. 安全红线

- API Key、密码、私钥 passphrase 一律不明文落盘
- AI 默认不自动执行任何命令，生成命令需用户显式回车确认
- 发送给 AI 的终端上下文默认脱敏提示，用户可关闭上下文共享
