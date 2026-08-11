# Agent 日志输出被当作命令执行

## 现象

Agent 偶发把远程日志原文放入 `shell.execute.command`，用户执行后 Bash 把行首时间戳当成命令，返回退出码 127 和 `command not found`。

## 复现

- [x] 用截图中的三行 `HH:mm:ss.SSS + 日志正文` 构造 `shell.execute`
- [x] 确认修复前动作被判为 `approval-required`，用户确认后会进入 SSH 执行
- [x] 确认修复后不会打开审批框或调用 SSH Agent 通道

## 根因

`parseTypedAction` 只验证 `command` 是非空字符串；`assessAgentAction` 只完成风险分类，未识别“日志/终端输出而非 Shell 命令”。因此日志正文被当作未知命令进入审批，仍可被用户执行。

## 修复方式

- [x] 在本地 typed-action 校验中增加输出文本识别，直接标记为 `invalid`
- [x] 保留包含时间条件的合法 `grep/awk/journalctl` 命令
- [x] Runtime 在本地生成错误执行记录，将原因反馈给 Agent 重新规划，不触发格式修复

## 回归验证

- [x] 定向测试：`typedActions`、`terminalAgentRuntime`、`agentProtocol` 共 56/56 通过
- [x] 前端全量测试：143/143 通过
- [x] 前端生产构建：`npm run build` 通过
- [x] 真实 SSH Agent：DeepSeek Provider + 已保存会话“光”完成两轮 typed action、真实命令执行、错误反馈重规划和最终总结
- [x] UI：长分析内容的展开控件移至内容底部中央，并完成桌面 dev 与截图检查

## 同类隐患

- Provider 也可能把 JSON 响应、Bash 报错或 Markdown 正文误放入 `command`，需以同一“动作有效性”边界继续覆盖，不应混入危险命令黑白名单。
- 本轮覆盖了常见时间戳日志形态；无时间戳的纯正文仍需结合后续真实样本扩展语义校验，避免以过宽规则误伤合法命令。
