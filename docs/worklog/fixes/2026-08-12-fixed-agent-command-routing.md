---
title: 固定 Agent 模式误接管明确 Shell 命令
type: fix
status: done
created: 2026-08-12
updated: 2026-08-12
---

## 现象

终端输入 `htop` 等明确命令时，命令偶发被送入 Agent；Agent 随后分析并改写命令，而不是让原始命令直接进入 Shell。

## 复现方式

将输入路由设为固定 Agent 后输入 `htop`。现有分类器会返回 `manual-agent`，绕过已存在的已知命令识别。

## 根因

`classifyTerminalInput` 与 `decideTerminalInput` 都在识别明确 Shell 输入前直接处理固定 Agent 模式。固定状态因此覆盖命令语义，并同时影响原生终端输入与 Agent 时间线下方输入框。

## 修复方式

调整统一输入分类顺序：先识别已知命令和具备命令形态的输入，再应用固定 Agent 意图。统一决策模型不再自行提前返回固定 Agent，而是复用同一分类器，因此原生终端输入与时间线输入框遵循相同规则。

明确命令在自动或固定 Agent 状态下均进入 Shell；自然语言仍可进入 Agent。若需要 Agent 操作某条命令，用户可输入“运行 htop 并分析”等自然语言意图。

同时修复 Agent 已接管场景下的 `htop` 兼容问题：直接命令、`sudo htop` 和 `timeout ... htop ...` 均统一转换为 `top -b -n 1` 单次快照，不再让模型继续猜测本机 `htop 2.2.0` 不支持的 `-b/-n` 参数。

## 回归验证

- 红测：修复前 `inputRouter` 与 `inputDecisionModel` 两项新增用例均稳定失败，实际值为 `agent`、期望值为 `shell`。
- 定向测试：`node --test --experimental-strip-types tests\inputRouter.test.ts tests\inputDecisionModel.test.ts`，24/24 通过。
- `htop` 回归覆盖直接执行、`sudo` 和两种 `timeout` 包装形式。
- 前端全量测试：196/196 通过，0 失败。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `cargo test --manifest-path src-tauri\Cargo.toml`：55 通过、0 失败，4 项外部环境 smoke 测试按条件忽略。

## 同类隐患

原生终端与时间线输入框原先各有一条固定 Agent 快速返回路径，现已统一到同一分类器。未发现第三条独立输入路由路径。
