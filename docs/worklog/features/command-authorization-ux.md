---
title: 命令授权体验优化
type: feature
status: done
created: 2026-08-11
updated: 2026-08-11
current_task_id: 019f2d85-1b7d-7781-be47-a725714288d1
successor_task_id: 019feeb1-c5f4-78a0-b122-f8fc42417747
---

## 目标

修复 Agent 命令授权体验：用户已经允许的命令不应在相同授权范围内重复询问；风险等级应依据命令实际行为判断，不能仅因不在白名单就标成高风险；点击审批弹窗外部不能自动等价为“拒绝”。

## 方案要点

- 先梳理一次允许、当前任务允许和持久允许的现有状态边界，复用已有授权状态，不新增重复数据源。
- 保留危险命令显式确认；未知命令不因“未知”本身要求授权，而是根据命令名、子命令和参数中的查询证据与变更证据推断实际行为。明确只读查询可自动执行，明确变更或落盘行为需要确认，证据不足时才保守确认；“需要确认”与“高风险”始终是两个不同语义。
- 审批 UI 只有明确点击“拒绝”或等价键盘操作才返回 reject；弹窗外点击应保持待处理或按既有取消语义处理，不能伪造用户拒绝。
- 授权复用范围限定为同一 Agent runtime、SSH session、工作目录和精确命令文本；切换 session、关闭 runtime、改变目录或改变命令均不会复用授权。
- 当前工作树包含大量未提交功能改动；后续任务不得重置、覆盖或回退这些既有改动。

## 进度

- [x] 确认旧任务 rollout 为 631.8 MiB，健康等级 `rotate_required`（2026-08-11）
- [x] 修复导致原生模型远程压缩空错误的本地路由器 5 分钟超时（2026-08-11）
- [x] 定位授权核心代码：`src/agent/typedActions.ts`、`src/agent/terminalAgentRuntime.ts`、`src/components/AiPanel.tsx`（2026-08-11）
- [x] 还原当前授权状态机和弹窗关闭语义（2026-08-11）
- [x] 用 3 个失败测试复现重复审批、风险语义耦合和外部点击误拒绝（2026-08-11）
- [x] 增加 runtime 内精确命令授权复用，同时保持不同写命令重新审批（2026-08-11）
- [x] 将“是否需要确认”与 `unknown / moderate / high` 实际风险等级分离（2026-08-11）
- [x] 审批弹窗外部点击保持待处理，普通 prompt/confirm 维持原关闭行为（2026-08-11）
- [x] 运行定向测试、前端全量测试和生产构建（2026-08-11）
- [x] 按实际行为放行结构受限的只读 `for` 诊断循环，而非为单条命令加字符串特例（2026-08-11）
- [x] 增加循环内动态执行、写文件和命令替换的反向审批用例（2026-08-11）
- [x] 为未知可执行文件增加行为推断：`status/list/get/inspect/describe/version/help` 等查询形态自动执行，变更动词、写入参数和复合写操作优先要求授权（2026-08-11）
- [x] 增加未知命令的正反向回归，并对 `get-object` 等查询动词包装的下载落盘操作保持保守审批（2026-08-11）

## 验证结果

- 路由器回归测试 13/13 通过，在线健康接口返回 `requestTimeoutMs=1860000`。
- 不可持久化自动压缩探针：两个回合完成，`AutoCompactItemCompleted=True`，错误为空。
- 红灯证据：新增测试首次运行 57 项中 3 项失败，分别为审批弹窗外部点击、同 scope 重复审批、风险级别缺失。
- 只读循环红灯证据：截图中的 `for ... command -v ... echo ... done` 首次回归为 27 项中 1 项失败，实际返回 `approval-required`。
- 未知查询红灯证据：行为推断加入前，`virt-host-validate`、`qemu-img info` 和 `customctl status` 会因不在已知集合而要求审批。
- 落盘反向红灯证据：首版未知查询推断把 `aws s3api get-object bucket key /tmp/object.bin` 错误归为 `safe`；新增输出写入否决规则后恢复为 `approval-required`。
- 定向回归：`node --test --experimental-strip-types tests\dialogBehavior.test.ts tests\typedActions.test.ts tests\terminalAgentRuntime.test.ts`，58/58 通过。
- 循环分类定向回归：`node --test --experimental-strip-types tests\typedActions.test.ts tests\terminalAgentRuntime.test.ts`，59/59 通过。
- 未知命令行为推断定向回归：`node --test --experimental-strip-types tests\typedActions.test.ts tests\terminalAgentRuntime.test.ts`，62/62 通过。
- 前端全量：`node --test --experimental-strip-types tests\*.test.ts`，162/162 通过。
- 生产构建：`pnpm build` 通过，TypeScript 与 Vite production build 均成功。
- 安全反向用例确认：`systemctl restart nginx` 首次仍需显式审批；同 scope 的精确命令可复用；`systemctl restart redis` 不会继承前一命令授权。
- 只读循环边界：字面量候选列表配合 `command -v`、`test`、`echo`、`printf` 和只读 `if` 分支可自动执行；动态命令、输出写入和命令替换仍需审批。
- 未知命令边界：查询证据只负责证明可自动执行，任何变更动词、写入参数、重定向、复合写命令或下载落盘形态优先否决；完全不明确的未知命令仍需确认，但不会因此显示为高风险。

## 遗留问题

- 旧任务 `019f2d85-1b7d-7781-be47-a725714288d1` 保留为历史记录，不再追加开发内容。
- 后续任务已创建：`SecureCRT AI｜命令授权体验优化`（`019feeb1-c5f4-78a0-b122-f8fc42417747`）。
- 本次只完成前端状态机、组件语义、单元回归和生产构建；未启动真实 SSH 会话执行危险命令，也未生成安装包。
