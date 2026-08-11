---
title: HTTP 与 Redis 只读诊断误判为风险命令
type: fix
status: done
created: 2026-07-31
updated: 2026-07-31
---

## 现象

- `curl -sI` HTTP HEAD 探测被要求高风险确认。
- `redis-cli --scan --pattern` 只读键扫描被要求高风险确认。
- Elasticsearch/OpenSearch `POST /_search` JSON 查询因使用 `curl -d` 被误判为
  HTTP 写操作。
- `appName=<业务线>&env=<环境>...` 之类的查询格式示例被当成 Shell 命令执行，
  最终由 Bash 返回语法错误。

## 复现方式

- 使用用户截图中的 HTTP、Redis 和占位符查询片段调用 `assessAgentAction`。
  修复前只读诊断返回 `approval-required`，查询片段可能进入执行流程。

## 根因

- 风险策略没有为 `curl` 和 `redis-cli` 建立可证明只读的参数级分类。
- Agent 协议没有明确禁止把格式示例和未替换占位符作为 `shell.execute` 动作，
  查询片段也缺少执行前的无效动作判定。

## 修复方式

- 保留危险特征黑名单作为第一层拦截。
- 为 `curl` 增加参数级只读判定，只允许 HTTP(S) GET/HEAD 及有限的连接、
  超时和展示参数。额外允许 `/_search`、`/_count` 端点使用单个内联 JSON
  请求体执行 GET/POST 查询；其他请求体、方法覆盖、上传和输出文件仍需确认。
- 为 `redis-cli` 增加参数级只读判定，允许 `--scan` 和明确的查询子命令；
  `SET/DEL/FLUSH/CONFIG SET/EVAL` 等写操作仍需确认。
- 只有 `key=value` 查询片段而没有可执行程序的动作标记为 `invalid`，退回 Agent
  重新规划，不再显示高风险确认框。
- Agent 协议明确禁止执行 `<业务线>`、`<环境>`、`<时间戳>` 等未替换占位符
  以及裸查询参数；缺少真实参数时必须从证据提取或询问用户。

## 回归验证

- 修复前，用户截图中的 HTTP 与 Redis 命令均稳定返回 `approval-required`，
  查询参数片段也被误判为风险命令。
- 修复后，截图中的两条只读命令返回 `safe`，Runtime 执行测试确认审批回调为
  0 次。
- Elasticsearch/OpenSearch `/_search`、`/_count` 的内联 JSON 查询返回
  `safe`；Runtime 确认未触发审批并按原命令执行。
- HTTP POST/上传/输出文件、Redis 写命令和 `sh -c` 内部危险操作仍返回
  `approval-required`。
- `/_bulk`、`/_update`、方法覆盖头、`@file` 请求体及非 JSON 请求体继续返回
  `approval-required`。
- 精确复现截图中的占位符查询片段，结果为 `invalid`；Runtime 测试确认审批、
  SSH 通道创建和命令执行次数均为 0。
- Node 全量测试 140 项通过，`pnpm build` 通过，`git diff --check` 通过。

## 同类隐患

- 未知 `curl`/`redis-cli` 参数继续保守要求确认；后续按真实误报补参数语义，
  不将整个可执行程序无条件加入自动执行范围。
