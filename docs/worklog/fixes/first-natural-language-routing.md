---
title: 首条自然语言误入 Shell
type: fix
status: done
created: 2026-07-31
updated: 2026-07-31
---

## 现象

SSH 刚连接后，使用输入法输入首条中文自然语言并回车，模式仍显示 Shell，文本直接进入
Bash，出现 `command not found`；同一句话再次输入时可能正常进入 Agent。

## 复现方式

在终端提示符出现后，让输入层一次产生带提交符的数据块，例如 `哈哈哈\r`。当前
`TerminalView` 只识别数据严格等于 `\r` 或 `\n` 的提交事件，组合数据直接透传 PTY。

## 根因

`src/components/TerminalView.tsx` 的 xterm `onData` 处理只把数据严格等于 `\r` 或 `\n`
识别为提交。部分输入法和远程键盘会把已确认文本与回车合并为一个事件，例如
`哈哈哈\r`；该事件绕过分类和 Agent 接管，整段直接写入 SSH PTY。

## 修复方式

在 `src/terminal/inputRouter.ts` 增加提交数据拆分，把末尾 `CR`、`LF` 或 `CRLF`
与前面的输入分离。`TerminalView` 在提交分类前先把同批文本纳入输入捕获，并用当前
提示符状态确认这是 Shell 提示符下的用户输入。自然语言进入 Agent；真实 Shell 命令
仍原样写入 PTY。

## 回归验证

- 失败测试先证明原实现不存在组合输入提交解析。
- 定向输入测试 `19/19` 通过。
- Node 全量 `120/120` 通过。
- `pnpm build` 通过。
- Rust `42` 项通过，4 项条件 smoke 按环境忽略。

## 同类隐患

已覆盖 `文本+CR`、`文本+CRLF`、空回车、首条 `ls -la` 和多行输入。密码提示与 Raw
TUI 不满足 Shell 提示符条件，仍保守透传，不进入 Agent。

## 预防措施

已为输入法组合文本与回车同批到达的事件补独立解析测试，并同时断言自然语言与真实
Shell 命令的目标模式，防止修复造成命令误接管。
