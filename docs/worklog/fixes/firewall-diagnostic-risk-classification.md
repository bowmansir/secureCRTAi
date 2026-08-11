---
title: 防火墙只读诊断误判为风险命令
type: fix
status: done
created: 2026-07-31
updated: 2026-07-31
---

## 现象

Agent 执行防火墙状态检查时，即使命令只包含临时 PATH 设置与 iptables、nft、ufw、
firewalld 查询，也会弹出高风险确认。

## 复现方式

执行用户提供的完整组合命令，并断言 `assessAgentAction` 应返回 `safe`。修复前返回
`approval-required`，原因为“命令不在只读自动执行范围”。

## 根因

保守只读分类器不识别独立的临时 `export PATH=...` 片段，也没有为防火墙工具定义严格
的只读查询子命令，因此整条组合命令回退到审批。

## 修复方式

新增严格的只读分类：

- `export PATH=...` 仅允许保留现有 PATH，并加入 `/bin`、`/sbin`、`/usr/bin`、
  `/usr/sbin`；不允许 `/tmp` 等可劫持命令解析的目录。
- iptables/ip6tables 仅允许 check/list/list-rules。
- nft 仅允许 list/get/describe。
- ufw 仅允许 status/show。
- firewall-cmd 仅允许明确的 get/list/query/state/check 参数与只读选择器。

## 回归验证

- 先用用户提供的完整命令稳定复现 `approval-required`。
- 定向测试 2/2 通过：只读组合命令安全，修改与不安全 PATH 仍需审批。
- typed action 策略测试 14/14 通过。
- Node 全量 128/128 通过。
- `pnpm build` 通过。

## 同类隐患

已覆盖规则追加、清空、端口开放、关闭防火墙、reload、混合查询与修改，以及
`PATH=/tmp:$PATH`。未识别的防火墙参数继续保守要求审批。
