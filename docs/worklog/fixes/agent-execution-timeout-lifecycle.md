---
title: Agent 执行超时与通道回收竞态
type: fix
status: done
created: 2026-08-11
updated: 2026-08-11
---

## 现象

Agent 执行本应很快结束的组合运维命令时，前端偶发显示“Agent 执行超时，执行通道正在关闭”，
随后自动重新分析；同一个证书任务因此反复开通道、重复确认并继续探测。

## 复现方式

使用延迟后端模拟 Rust 已进入超时清理、即将在清理宽限期内返回 `exitCode=null`：动作截止点
到达后稍晚返回。当前前端会先拒绝并关闭通道。另覆盖中断调用永久不返回、未知退出码仍自动
续跑，以及 Rust 清理写入被网络背压阻塞的边界。

## 根因

- 前端通道注册表和 Tauri IPC 都使用 35 秒截止点，Rust 命令执行又固定为 30 秒加 3 秒清理；
  三层截止时间过近，Rust 正常进入清理时前端可能抢先报错并关闭通道。
- Rust 的 Ctrl-C、清理标记写入和 EOF 没有全部纳入有界超时；网络背压时，清理或中断可能永久
  等待。前端释放通道又先等待中断，因此无法保证执行到 `close`。
- 后端运行失败后旧通道仍可能留在注册表中；`exitCode=null` 又被当作可继续规划的普通失败，
  造成状态未知时自动重试，存在重复执行已部分生效变更的风险。

## 修复方式

- 动作的 `timeoutMs` 从前端贯穿 Tauri 到 Rust，由 Rust 作为唯一命令执行截止点；Tauri 只在
  `T+5s` 做进程边界保护，前端只在 `T+8s` 做 IPC 看门狗，避免相同截止点竞态。
- Ctrl-C 写入、清理标记写入与等待统一纳入 3 秒清理预算；EOF 和关闭时 Ctrl-C 同样有界。
- 运行失败或看门狗触发时先使旧通道失效；中断最多等待短暂宽限，`close` 无论中断是否返回
  都会执行，后续命令不会复用失去帧边界的通道。
- `exitCode=null` 和执行通道错误统一表示“执行状态未知”：界面标记为错误，停止自动重新规划，
  提醒用户先做新的只读核验，绝不自动重放可能已执行的变更。

## 回归验证

- 红灯覆盖：Rust 在前端截止点稍后完成清理、interrupt 永不返回、失败后旧通道复用、未知退出码
  自动续跑；修复前新增用例稳定失败。
- 定向回归：Agent 协议、通道、运行时和授权测试共 110/110 通过。
- 前端全量：`node --test --experimental-strip-types tests\\*.test.ts`，188/188 通过。
- Rust：`cargo test --manifest-path src-tauri\\Cargo.toml`，55 通过、0 失败、4 个条件式实机测试忽略；
  `cargo fmt --check` 通过。
- 构建：`pnpm build` 和 `cargo build --release --manifest-path src-tauri\\Cargo.toml` 通过。
- Tauri 安装包编译与 MSI/NSIS 打包已完成，但 updater 签名阶段因当前进程未注入
  `TAURI_SIGNING_PRIVATE_KEY` 退出；未读取私钥、未绕过签名，也未发布或安装该产物。

## 同类隐患

远端命令超时后可能已经完成、部分完成或仍在运行，客户端无法可靠推断结果。因此未知状态只能
隔离通道并停止自动操作，后续必须从新通道进行只读核验。持续输出命令也必须自动加时限；本次已
覆盖 `tail/journalctl -f`、`docker stats` 与 `docker compose logs --follow`。
