---
title: Termexa 品牌迁移
type: feature
status: done
created: 2026-07-31
updated: 2026-07-31
---

## 目标

- 将用户可见品牌、桌面产品名、可执行文件和项目文档统一为 `Termexa`。
- 升级后继续使用现有主机、分组、主题、AI 配置和系统凭据。

## 边界

- 本次不重命名本地仓库目录和 GitHub 远程仓库。
- 旧配置目录、凭据服务名、本地存储键和 typed-action 协议作为兼容入口保留，
  不再作为用户可见品牌展示。

## 迁移策略

- 新配置写入 `Termexa` 目录；新目录没有数据时从 `TermAI` 读取并迁移。
- 保留原 Tauri bundle identifier 和系统凭据服务名，维持安装升级及密文解密能力。
- 新 Agent 协议使用 `termexa-actions`，解析端继续接受 `termai-actions`。

## 进度

- [x] 用户界面、文档和构建元数据改名
- [x] 配置、主机密钥和本地设置兼容迁移
- [x] typed-action 与 Shell Integration 兼容迁移
- [x] 全量测试、前端构建、Rust 测试和桌面验证

## 验证

- Node 测试：141 项通过，0 失败。
- Rust 测试：49 项通过，0 失败；4 项需 Provider 或 Docker 的 smoke test 按设计忽略。
- `pnpm build`、`cargo build`、`cargo fmt --check` 和 `git diff --check` 通过。
- 桌面真机确认窗口标题、进程名和状态栏均为 `Termexa`。
- 真实 `store.json` 和 `known_hosts.json` 迁移前后 SHA-256 完全一致。
- 正式产物：
  - `target/release/termexa.exe`
  - `target/release/bundle/msi/Termexa_0.1.0_x64_en-US.msi`
  - `target/release/bundle/nsis/Termexa_0.1.0_x64-setup.exe`
