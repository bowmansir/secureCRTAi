---
title: PM2 只读查询误判与持续命令假死
type: fix
status: done
created: 2026-07-31
updated: 2026-07-31
---

## 现象

- `pm2 list` 被识别为高风险命令并要求确认。
- `pm2 log 0` 持续输出时，内联终端仍显示一个可编辑提示符，但提交被阻止，
  用户输入后只看到“等待命令结束”，像是终端卡死。
- `sleep` 等暂未结束的前台命令存在相同的伪提示符问题。

## 复现方式

- 对包含 `pm2 list` 的只读探测命令调用 `assessAgentAction`，修复前返回
  `approval-required`。
- 在已启用内联 Agent 时间线的 SSH 标签执行 `pm2 log 0`，命令没有返回 Prompt
  事件时，界面仍渲染可编辑 Composer，而 `submitComposer` 因 `shellBusy` 直接返回。

## 根因

- 风险策略没有 PM2 的严格只读子命令分类。
- 命令生命周期只区分“已结束/未结束”，没有识别持续流式命令；同时忙碌状态复用了
  普通输入 Composer，造成可以输入但无法提交的误导交互。

## 修复方式

- 为 PM2 增加严格的只读子命令白名单；`list/status/show/describe/info`
  等查询和有限日志快照允许安全自动执行，重启、删除和无限日志仍按风险策略处理。
- 内联终端和右侧 AI Agent 共用 `prepareAgentCommand`：AI 发起的 `pm2 logs`、
  `tail -f/-F`、`journalctl -f`、容器日志跟随、`watch` 和 `sleep` 最多运行
  5 秒，到期退出码 124 被规范为正常采样结束。
- 复合命令通过 `timeout 5s sh -c '...'` 限制整个脚本，风险引擎递归检查
  `sh -c` 内部命令，外层超时不能掩盖删除、重启或文件覆盖。
- 用户在 Shell 或自动模式下亲自输入的命令不经过 Agent 命令转换，不设置
  5 秒自动中断；前台命令持续运行时隐藏不可提交的 Composer，并提供明确的
  运行状态与 `Ctrl+C` 中断入口。

## 回归验证

- `node --test <tests/*.test.ts>`：134 项通过。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：44 项通过，4 项需要
  Provider/Docker 环境的 smoke 测试按设计忽略。
- 桌面开发态连接现有 SSH 主机验证：用户前台命令持续超过 5 秒未被自动中断，
  `Ctrl+C` 能恢复 Prompt。

## 同类隐患

- 已覆盖 `tail -f/-F`、`journalctl -f`、Docker/Podman/Kubernetes 日志跟随、
  `watch`、`sleep`、已带较长 `timeout` 和包含单引号的复合命令。
- `less/more` 也沿用同一 5 秒 Agent 边界；用户 Shell 原始交互保持不变。
