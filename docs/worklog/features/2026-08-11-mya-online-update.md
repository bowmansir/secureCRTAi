---
title: Mya 在线更新与启动探针
type: feature
status: done
created: 2026-08-11
updated: 2026-08-11
current_task_id: 019feeb1-c5f4-78a0-b122-f8fc42417747
successor_task_id: 019fef82-32f5-7a21-8774-19e85291f80e
---

## 目标

将 Termexa 以稳定软件标识 `termexa` 接入 Mya 统一发布后台。安装版启动后错峰检查更新，有新版本时展示版本与说明，用户确认后由 Tauri updater 完成签名下载、安装和重启；设置页提供手动检查。启动与更新事件按白名单通过加密探针 best-effort 上报，任何探针失败都不能影响主流程。

## 已完成

- Tauri/Cargo/package 使用同一 SemVer；接入 Tauri 2 updater 与 process 插件，生成 NSIS、MSI 及相邻 updater 签名。
- 更新状态显式区分 `idle / checking / upToDate / available / downloading / installing / error`；自动与手动检查共享单飞请求，浏览器开发模式不访问生产接口。
- 安装版启动后延迟 18～30 秒自动检查；设置页提供手动检查和自动检查开关。
- 新版本弹窗展示当前/目标版本、发布时间、发布说明、下载进度和错误分类；0.1.4 修复基础面板类缺失，并将头部、说明区、操作区拆分为稳定视觉层级。
- 首次启动生成稳定随机 `installId`；探针采用 AES-256-GCM、RSA-OAEP-SHA256、新 IV/nonce 与白名单字段，客户端仅内置生产 RSA-3072 公钥及 `kid=desktop-probe-2026-07`。
- 生产环境约 7 秒的正常响应超过原 5 秒客户端窗口，0.1.3 将探针超时提高到 15 秒；探针失败仍不改变更新结果。
- Termexa 独立 updater 私钥和 DPAPI 保护密码保存在仓库外；构建时仅注入当前进程并在结束后清除，不上传或写入日志。
- 使用既有 root SSH 公钥认证连接生产机；每次发布先做 SQLite 在线备份和 `PRAGMA quick_check`，再通过服务层发布器写入，未直接拼接发布 SQL。

## 发布记录

| 版本 | release_id | NSIS SHA-256 | 大小 | 说明 |
| --- | ---: | --- | ---: | --- |
| 0.1.1 | 4 | `a076a61ebaceea0a397c08af8b28b9afd492731d49e85f4dc65981c7c9c3bccf` | 5,156,850 | 首个生产 updater 版本 |
| 0.1.2 | 5 | `160ab21052f7cf77eea267a188a52bcf18017eb30a637312642b6a7cce36220d` | 5,157,483 | 在线升级链路回归版本 |
| 0.1.3 | 6 | `431330a5271b964805b79519a373276e51b005a88c25b7dd9aa0cc7e57090591` | 5,145,134 | 生产探针 15 秒容错 |
| 0.1.4 | 7 | `70409dcadf005ed7bf27f70057c7902574a6ebaad209603fce49cb1d3863c75c` | 5,150,392 | 更新弹窗视觉与布局修复 |

生产公开接口验证：旧版本请求返回最新 SemVer、远端签名与本地 `.sig` 完全一致、下载产物 SHA-256 与发布记录一致；请求当前 0.1.4 返回 HTTP 204。

## 生产备份

以下备份均非空且 `PRAGMA quick_check` 返回 `ok`：

| 发布前版本 | 备份路径 | SHA-256 |
| --- | --- | --- |
| 0.1.1 | `/opt/wework-update/backups/wework-before-termexa-0.1.1-20260811125155.db` | `89dea49e2989310af6ecd045ff68e7d9d8c6e5335e1a9c9e1e90061ffa861281` |
| 0.1.2 | `/opt/wework-update/backups/wework-before-termexa-0.1.2-20260811131330.db` | `7d27120d190fab7723bf77dd27a25b358b1e361995289cd131d6e34f08b0ab58` |
| 0.1.3 | `/opt/wework-update/backups/wework-before-termexa-0.1.3-20260811135218.db` | `b55f43727ec2740fb6b452584982845ad8975e5877ada409c0ed76b6193f0be0` |
| 0.1.4 | `/opt/wework-update/backups/wework-before-termexa-0.1.4-20260811141021.db` | `af1da4f611c308c59142f605710948f62f1cbed60ee9b01ab074a984b6d2b832` |

## 真实升级与界面验证

- 先以 MSI 安装 0.1.1 作为低版本基线；0.1.1→0.1.2 下载、验签、安装、重启成功。由于测试基线是 MSI、更新包是 NSIS，本次迁移出现一次 Windows Installer 卸载确认，确认后成功切换到当前用户目录。
- 0.1.2→0.1.3 为纯 NSIS→NSIS，应用内更新后自动重启，没有额外卸载或安装确认，历史会话列表保留。
- 0.1.3→0.1.4 再次完成纯 NSIS→NSIS 更新，注册表与可执行文件版本均为 0.1.4，安装路径保持 `C:\Users\fwy12038\AppData\Local\Termexa`。
- 0.1.4 的新弹窗通过临时 0.1.2 Tauri 预览客户端连接真实生产接口验证：完整面板背景、版本胶囊、发布时间、可滚动说明区和独立操作栏均按预期显示；预览客户端与临时配置验证后已移除。
- 生产探针记录了 `update_available / succeeded`、`update_install / started`、`startup / succeeded / 0.1.4`，随后 `update_up_to_date / succeeded / 0.1.4`；客户端 `launch_count=3`。
- 所有更新成功，无需执行破坏性回滚；四份发布前数据库备份和对应哈希保留为恢复材料。回滚恢复本身未在生产库上演练。

## 最终验证

- `node --test --experimental-strip-types tests\\*.test.ts`：175/175 通过，0 失败。
- `cargo test --manifest-path src-tauri\\Cargo.toml`：54 通过，0 失败；4 项既有外部环境 smoke 测试按条件忽略。
- `cargo fmt --manifest-path src-tauri\\Cargo.toml --check`：通过。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `pnpm tauri build`：0.1.4 release、NSIS/MSI bundle 与 updater 签名生成成功。
- `pnpm audit --prod --registry https://registry.npmjs.org`：无已知漏洞。
- 更新弹窗新增 2 项结构回归测试，锁定基础 `.modal` 面板与说明/操作分区。
- `git diff --check`：通过；仅存在 Windows 工作树既有 LF→CRLF 提示。
- 私钥标记的 5 个仓库匹配均是既有测试、私钥导入 UI 文案和校验逻辑；更新配置、发布脚本临时文件及产物目录未包含签名私钥或密码。

## 边界与后续

- 当前稳定版本为 0.1.4，Mya 最新发布记录为 release 7。
- 私钥、密码和生产探针私钥继续只保存在各自受控环境；仓库只保存公开 updater key 和生产探针公钥。
- 若未来需要验证数据库恢复流程，应另开受控维护窗口，在副本或隔离实例演练，不能直接覆盖当前生产库。
- 工作树原有大量用户未提交改动全部保留；本任务未执行 reset、checkout、清理、commit 或 push。

## 生命周期交接

- 轮换原因：当前根任务发生 4 次上下文压缩；`task_health.py` 判定为 `rotate_required`。rollout 约 40.4 MiB，触发因素是压缩次数而非文件大小。
- 当前目标：Mya 在线更新、生产探针、命令授权体验与更新弹窗样式均已完成并验证；本机当前安装并运行 Termexa 0.1.4。
- 已完成与验证证据：见“发布记录”“真实升级与界面验证”“最终验证”；最新生产 release 为 7，0.1.4 公共检查返回 204，签名和下载哈希一致。
- 未完成：没有遗留实现任务；生产数据库恢复演练未执行，必须另开受控维护窗口，不能直接覆盖生产库。
- 关键文件：`src/components/DesktopUpdateDialog.tsx`、`src/App.css`、`src/update/`、`src-tauri/src/desktop_update.rs`、`src-tauri/tauri.conf.json`、`tests/desktopUpdateDialog.test.ts`、`tests/desktopReleaseConfig.test.ts`、本 worklog。
- 下一步：后续任务只读取本文件并核验必要的 0.1.4 当前状态；不要重做已完成发布。收到新的更新、授权或发布反馈后，再从对应回归测试开始最小修改。
- 后续任务标题：`Termexa｜在线更新后续维护`
- 后续任务 ID：`019fef82-32f5-7a21-8774-19e85291f80e`
- 首条消息引用本文件：是
- 旧任务标题已回读确认：`SecureCRT AI｜命令授权体验优化｜已满-旧对话`（`019feeb1-c5f4-78a0-b122-f8fc42417747`）
