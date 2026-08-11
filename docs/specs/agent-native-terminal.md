# Agent 原生终端规格

实施任务、依赖关系、能力门禁和测试矩阵见
[`docs/plans/agent-native-terminal-migration.md`](../plans/agent-native-terminal-migration.md)。

## 目标

将 Termexa 从“终端 + 独立 AI 面板”逐步演进为 Agent 原生远程终端：

- 用户在终端内输入命令或自然语言，不必反复手动切换入口。
- Shell 命令、Agent 操作、真实输出和最终结论共享同一个会话上下文。
- 用户与 Agent 对终端的控制权明确、可暂停、可接管、可恢复。
- 多主机、SFTP、端口转发等远程运维能力最终成为 Agent 的类型化工具。
- 默认以终端内联 Agent 工作；用户点击顶部 AI 时保留传统右侧 AI 面板模式。

## 最终交互骨架

参考 Warp 的 surface-scoped input model、Block 时间线和 Agent input footer 思路，
Termexa 最终采用以下结构：

1. **一个终端 Surface 一套状态**：输入模式、Shell Block、Agent Conversation、执行控制和上下文都按标签隔离。
2. **一个统一输入入口**：同一编辑器接受 Shell 命令和自然语言，通过自动检测或手动锁定决定目标。
3. **一个 Block 时间线**：Shell 命令/输出、Agent 回复、命令审批、执行结果和最终总结按发生顺序显示。
4. **一个底部 Footer**：承载 Shell/Agent 模式、上下文、停止/接管、继续任务等控制。
5. **双模式互斥**：默认显示终端内联 Shell/Agent；打开 AI 面板时隐藏内联模式控件，
   两套 conversation/runtime 独立。

### 结构边界

- `TerminalSurfaceModel`：每个终端标签的唯一权威状态，保存模式、Block 顺序、运行态和当前会话身份。
- `TerminalInputModel`：管理输入文本、自动检测、手动锁定和提交目标，不依赖具体视图。
- `AgentRuntime`：负责流式回复、工具调用、暂停、追加要求和 Agent 通道生命周期。
- `TerminalTimeline`：只从 Surface 状态渲染 Block，不直接调用后端。
- `TerminalComposer`：统一输入和 Footer；Shell 与 Agent 共享编辑器但提交动作不同。

主题视觉只参考 `D:\2028\termany` 的背景图片层实现。Termany 的布局、组件、颜色、字体和
Agent Pane 均不属于参考范围；背景图必须位于现有界面之后，并通过遮罩保证终端可读性。

## 当前交付范围

本轮交付以 SSH Agent 闭环为范围：

1. 每个 SSH 终端提供自动感知的 `Shell / Agent` 输入模式。
2. 保留 xterm 和远端 Shell 原生输入、Tab 补全、历史及交互程序。
3. 仅在 Shell Integration 就绪、输入缓冲可靠且用户按下回车时执行路由。
4. 自动模式使用本地规则分类；高置信自然语言进入当前 SSH 会话的 Agent，其余输入进入 Shell。
5. Agent 模式强制将可靠的 Shell 提示符输入交给 Agent；Shell 模式始终交给 Shell。
6. `Ctrl+Shift+I` 在 Agent 与自动模式之间切换。
7. 内联 Agent 与传统 `AiPanel` 使用独立 conversation、Runtime 和执行通道。
8. Execution Policy 固定为 `safe-auto`：只读安全动作自动执行，危险动作始终审批。
9. 本地 PowerShell 保留 Raw Shell；架构预留本地 Agent 执行器，但不作为本轮验收阻塞项。

## 历史第一阶段边界

下方“第一阶段边界矩阵”和第一阶段验收标准保留为迁移历史。当前实现已经进入内联
Block、typed action 和 SSH Shell Integration 阶段；它们不再描述当前能力上限。

## 架构阶段

### Phase 1：统一输入路由

- `TerminalInputRouter`：纯函数分类 Shell/Agent，默认保守回退 Shell。
- `TerminalView`：维护当前行的轻量输入缓冲、提示符状态和手动模式。
- `App`：将终端自然语言请求定向发送到当前会话 Agent。
- `AiPanel`：支持外部请求显式指定 Agent，而不是依赖复选框的旧状态。

### Phase 2：结构化终端 Block

- 先把 Agent 会话/执行状态从 `AiPanel` 视图中抽离为按 terminal surface 隔离的模型。
- 引入稳定的 `TerminalBlock` 身份、顺序和生命周期。
- 接入 shell integration，可靠采集 command、output、exit code、cwd、host 和时间。
- 普通终端 Block 与 Agent Conversation Block 分离可见性，但允许显式附加上下文。

### Phase 3：内联 Agent 时间线

- 将用户请求、Agent 说明、命令提议、执行状态和总结渲染在终端工作区。
- 过程默认折叠为一行，重要结论展开，详细输出按需查看。
- 在时间线底部提供统一输入和 Agent Footer。
- 完成消息、表格、命令、审批、追加、停止、续期和错误态能力对等。
- 保留右侧 AI 模式；打开时隐藏内联 Shell/Agent 控件，关闭时恢复。

### Phase 4：Agent 工具与控制权

- 类型化工具调用替代 Markdown 代码块提取。
- 引入 `USER_CONTROL / AGENT_CONTROL / WAITING_APPROVAL / PAUSED` 状态机。
- 支持交互程序的读取、写入、等待、用户接管和交还。
- 按工具和风险分级权限，而不是只按命令字符串确认。

### Phase 5：远程运维工具

- SFTP 上传、下载、服务器间传输。
- 服务、日志、端口、转发和远程文件操作。
- 多主机目标选择、逐主机结果与失败恢复。

## 第一阶段边界矩阵

| 场景 | 自动模式 | Shell 模式 | Agent 模式 |
| --- | --- | --- | --- |
| 明确 Shell 命令 | Shell | Shell | Agent |
| 高置信自然语言 | Agent | Shell | Agent |
| 单个词、路径、未知输入 | Shell | Shell | Agent |
| 未检测到提示符 | Shell | Shell | Shell |
| 使用 Tab/方向键编辑后 | Shell | Shell | Shell |
| `vim`/`top`/`psql` 等交互程序 | Shell | Shell | Shell |
| 无 AI Provider | Shell | Shell | Shell |
| 本地终端 | Shell | Shell | 不可用 |
| SSH 终端 | 当前会话 Agent | Shell | 当前会话 Agent |

## 数据边界

- 输入模式和当前输入缓冲只保存在终端组件内存中，按标签隔离。
- Agent 对话继续使用现有按终端标签隔离的内存状态。
- 第一阶段不新增持久化、不新增同步数据、不复制 API Key。
- 终端输出仍由现有后端 Channel 和前端输出缓冲维护。

## 安全边界

- 分类不确定时必须进入 Shell，不能误触发 Agent。
- 未确认处于 Shell 提示符时不能拦截输入，避免破坏密码输入和交互程序。
- Agent 自动执行继续经过现有危险命令检查和用户确认。
- 关闭标签时继续清理 Agent 通道和会话运行态。

## 测试策略

- Node 原生测试覆盖输入分类、提示符识别和输入缓冲编辑。
- `pnpm run build` 验证 TypeScript 与生产构建。
- `cargo test` 验证后端既有终端与 Agent 行为未回归。
- Playwright/Tauri dev 验证模式切换、Shell 命令、自然语言路由、标签隔离和 Tab 补全。

## 第一阶段验收标准

- [ ] 默认自动模式下，`ls -la`、`df -h`、路径和单词不会被 Agent 拦截。
- [ ] 默认自动模式下，“分析下服务器性能问题”进入当前 SSH 会话 Agent。
- [ ] Shell 模式永远不自动切换到 Agent。
- [ ] Agent 模式仅在可靠的 Shell 提示符输入阶段接管。
- [ ] Tab、方向键、密码提示和交互程序输入保持原终端行为。
- [ ] 不同终端标签的输入模式和 Agent 会话互不污染。
- [ ] 构建、单元测试和桌面端定向交互验证通过。

## 最终验收标准

- [ ] 默认进入终端内联模式；点击顶部 AI 可恢复传统右侧面板。
- [ ] AI 面板打开时不显示终端内联 Shell/Agent 模式栏和 Composer。
- [ ] 两套模式的对话、草稿、Runtime、执行通道和队列互不污染。
- [ ] Shell 和自然语言共用终端底部的同一个输入编辑器。
- [ ] Agent 回复、工具调用、审批、输出和总结按顺序出现在当前终端时间线。
- [ ] Agent 运行时仍可追加要求、停止、接管终端和继续超过轮次限制的任务。
- [ ] 每个标签的对话、执行通道、草稿、Block 和控制权完全隔离。
- [ ] 关闭标签时取消流式请求并关闭 Agent/PTY 通道，不保留悬空任务。
- [ ] Tab 补全、历史、复制粘贴、Vim/Top 等交互式终端行为不回归。
