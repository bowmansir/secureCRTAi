---
title: Agent 证书诊断只读误判
type: fix
status: done
created: 2026-08-11
updated: 2026-08-11
---

## 现象

Agent 执行 nginx 证书与反向代理排查时，将 `ss`、`ps`、`grep`、`getent`、只读
`curl`、`nginx -T/-t`、`openssl s_client` 和 `openssl x509 -noout` 等组合查询误判为
“命令不在只读自动执行范围”，导致用户在同一任务中频繁确认。

## 复现方式

使用用户截图的脱敏等价命令覆盖以下四类组合：nginx/frp 配置盘点、DNS 与公网地址查询、
TLS 握手检查、证书元数据读取。修复前均应稳定返回 `approval-required`；同时保留 nginx
reload、OpenSSL 写密钥/证书和命令替换内写文件的审批反例。

## 根因

授权分类器只把固定的通用命令列入只读集合，未描述 nginx 与 OpenSSL 的子命令语义；
`getent` 也不在只读集合中。组合诊断中的安全命令替换（例如只读取 nginx 主进程 PID）同样
会被保守拒绝，因此整条命令进入审批。审批缓存又严格按完整命令匹配，Agent 每次生成不同的
后续查询时无法复用上一次确认，最终表现为同一业务任务连续弹窗。

## 修复方式

- 增加 `getent` 只读识别。
- `nginx` 仅放行配置校验、配置输出和版本查询参数；`-s reload` 等状态变更仍需确认。
- `openssl x509` 仅放行带 `-noout` 的证书元数据读取；`openssl s_client` 仅在外层有
  `timeout` 边界且不存在输出/keylog 参数时放行。
- 递归验证 `$()` 中的内部命令，只有内部与外部命令都满足只读规则才自动执行；动态循环、
  shell 包装器和写文件命令继续拒绝自动执行。
- 第二轮扩展常见、有界运维查询：DNS、有限网络探测、文本筛选与哈希、systemd、Docker/
  Podman、Compose、Kubernetes、证书与服务配置校验；持续输出模式必须由 `timeout` 或工具自身
  的有限参数约束。
- 放行规范化临时诊断探针：仅允许 `mktemp` 在 `/tmp` 或 `/var/tmp` 创建 Termexa/Mya 前缀、
  排他生成的临时文件或目录，同一条动作中立即清理；禁止固定文件名、路径逃逸、写后执行、
  下载、私钥/keylog/凭据以及无关文件清理。
- Agent 规划提示明确要求同一业务变更合并为一次确认，变更后的只读核验自动执行，避免把一次
  证书替换拆成多次等价审批。
- 不再无条件剥离前置环境变量；`PATH`、`LD_*`、`BASH_ENV`、可执行 pager 等注入仍需审批，
  只允许 locale/格式变量与安全的 `PAGER=cat` 类设置。

## 回归验证

- 红灯：新增截图脱敏等价用例后，首条 nginx/frp 诊断返回 `approval-required`。
- 第二轮红灯覆盖：规范临时探针仍需确认、环境注入被误判安全、常见有界诊断误弹，以及持续
  Docker 输出未自动限时；修复前相应用例稳定失败。
- 绿灯：`node --test --experimental-strip-types tests\\typedActions.test.ts`，36/36 通过。
- 组合回归：Agent 协议、运行时、授权分类与通道共 110/110 通过。
- 前端全量：`node --test --experimental-strip-types tests\\*.test.ts`，188/188 通过。
- 生产构建：`pnpm build` 退出码 0，TypeScript 与 Vite 构建成功。
- 差异检查：`git diff --check` 退出码 0；仅报告仓库既有工作树的行尾提示。

## 同类隐患

当前放行仍是参数与执行语义级规则，不是对工具名的整体信任。真实证书/配置覆盖、reload/restart、
安装删除、密钥与凭据、动态路径、环境执行注入、临时文件写后执行仍会确认。前端超时与通道回收
作为独立生命周期问题另行修复，避免用扩大授权掩盖执行状态不确定性。
