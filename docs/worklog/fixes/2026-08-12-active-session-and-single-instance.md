---
title: 当前主机高亮与重复托盘图标
type: fix
status: done
created: 2026-08-12
updated: 2026-08-12
---

## 现象

1. 顶部切换 SSH 标签后，侧栏只能看到哪些会话已打开，无法快速辨认当前活动标签对应的主机。
2. 主窗口关闭到托盘后，再次通过任务栏或快捷方式启动应用会创建新进程；每个进程创建一个托盘图标，图标可持续累加。

## 根因

侧栏仅接收临时的“保存后高亮”与已连接会话集合，没有接收当前活动 SSH 窗格的稳定会话 ID。桌面后端创建托盘并拦截关闭事件，但没有单实例门禁，因此隐藏窗口与再次启动之间没有关联。

## 修复方式

- 从活动分屏窗格推导当前 SSH 会话 ID，传入侧栏并使用现有主题变量生成常驻选中背景、左侧强调线和悬停态；本地终端及 SFTP 页面不冒充当前 SSH 主机。
- 侧栏状态点由 8px 收敛为 6px，并同步缩小在线发光、健康状态外圈和脉冲范围，避免状态点抢过当前主机高亮的视觉层级。
- 按 Tauri 2 官方 Single Instance 插件接入方式，将单实例插件注册为第一个插件。第二次启动时不创建新窗口或托盘，只调用既有 `show_main_window` 取消最小化、显示并聚焦主窗口。
- 版本同步到 `0.1.6`；先通过本机 Dev 预览供用户验收，用户确认无明显问题后进入正式发布流程。

## 回归验证

- 前端全量测试：196/196 通过，0 失败。
- 核心分流定向回归：25/25 通过；覆盖固定 Agent、自动模式、明确命令、命令形态歧义、中文/英文自然语言和自然语言提及命令。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `cargo fmt --manifest-path src-tauri\Cargo.toml --check`：通过。
- `cargo test --manifest-path src-tauri\Cargo.toml`：55 通过、0 失败，4 项外部环境 smoke 测试按条件忽略。
- Windows 候选程序真实启动两次：第一次 1 个候选进程，第二次仍为同一进程，第二启动器退出；验证后仅停止候选进程，未停止用户当前运行的 3 个 0.1.5 进程。
- 本机 NSIS 测试包：`src-tauri/target/release/bundle/nsis/Termexa_0.1.6_x64-setup.exe`，5,238,669 字节，SHA-256 `6510E16BEE9C39D2D97617086E0AF6F067FBD5164556DE93E309DE825CA5E465`。
- 打包时通过临时覆盖关闭 updater 产物生成，临时文件已删除；未读取发布签名私钥，未上传 GitHub/Mya，未创建生产 Release。
- 用户已于 2026-08-12 完成本机 Dev 预览并确认无明显问题，授权提交 GitHub、创建 GitHub Release 并发布 Mya stable。

## 参考

- Tauri 2 Single Instance 官方文档：https://v2.tauri.app/plugin/single-instance/
