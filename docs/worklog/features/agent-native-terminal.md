---
title: Agent 原生终端
type: feature
status: in-progress
created: 2026-07-30
updated: 2026-07-31
---

## 目标

将 Shell 和 Agent 从两个独立入口演进为统一终端交互，并逐步建立结构化 Block、控制权和远程运维工具体系。

## 方案要点

- 保留 xterm 与远端 Shell 原生编辑，第一阶段只在可靠提示符状态拦截回车。
- 自动路由采用保守本地分类，不确定输入回退 Shell。
- 先复用现有 Agent 通道验证闭环，再建设结构化 Block 和内联 UI。
- 保留传统右侧 AI 模式；默认使用终端内联模式，打开 AI 时隐藏内联 Shell/Agent 控件。
- 两种模式使用独立 conversation、draft、runtime key、执行通道和追加队列。
- 最终主题只参考 `D:\2028\termany` 的背景图片层，不参考其界面、控件、配色或字体。
- 规格与阶段边界见 `docs/specs/agent-native-terminal.md`。

## 进度

- [x] 建立独立分支 `codex/agent-native-terminal`（2026-07-30）
- [x] 盘点终端、AI、会话隔离与执行通道（2026-07-30）
- [x] 制定分阶段规格和第一阶段边界矩阵（2026-07-30）
- [x] 实现本地输入分类器与测试（2026-07-30）
- [x] 接入终端模式和可靠输入捕获（2026-07-30）
- [x] 接入当前会话 Agent 定向请求（2026-07-30）
- [x] 完成浏览器 IPC 集成验证、生产构建和后端回归（2026-07-30）
- [ ] 完成用户桌面端交互验收
- [x] 定义 surface-scoped Block 与控制权状态契约（2026-07-30）
- [x] 完成 Surface Registry、20 标签隔离和关闭清理契约（2026-07-30）
- [x] 完成带置信度/来源的输入决策模型（2026-07-30）
- [x] 完成 Context Assembler、去重、预算与敏感信息脱敏（2026-07-30）
- [x] 完成 `terminal:` / `ai-panel:` Runtime 通道命名空间隔离（2026-07-30）
- [x] 完成 Agent 真实中断确认与标签关闭双 Runtime 清理（2026-07-30）
- [x] 将终端 Agent 会话、执行批次、追加队列和控制状态迁入 Surface 模型（2026-07-30）
- [x] 接入统一 Composer、内联 Agent/Shell Block 时间线和执行详情（2026-07-30）
- [x] 完成终端 / 传统 AI 双模式互斥显示和 Runtime 隔离（2026-07-30）
- [x] 完成 Bash/Zsh Shell Integration、cwd/退出码采集与 Raw Terminal 降级（2026-07-30）
- [x] 修复流式请求提前返回及 OpenAI `[DONE]` 后连接不结束导致的假完成/卡死（2026-07-30）
- [x] 按 Block 流重做 Agent 展示：请求保留、命令不重复、执行默认一行折叠（2026-07-30）
- [x] 隐藏 Shell Integration 内部安装命令，保留真实登录欢迎信息和提示符（2026-07-30）
- [x] 修复 `2>&1`、`1>&2`、`2>/dev/null` 被误判为覆盖文件的风险规则（2026-07-30）
- [x] 完成 Block 上下文选择、策略切换、chip 查看/移除与模型装配（2026-07-30）
- [x] 完成 Raw TUI/REPL 输出隔离、退出恢复和焦点交接（2026-07-30）
- [x] 将 Shell Integration 改为 Bootstrap 确认后的两阶段安装，消除脚本泄露与启动竞态（2026-07-30）
- [x] 完成后台标签停止构建隐藏时间线、500 Block 分批渲染和大输出自动折叠（2026-07-30）
- [x] 完成 SFTP 远程文本文件读取、Agent context chip 查看/移除闭环（2026-07-30）
- [x] 完成 Bash/Zsh preexec 命令起点事件，补齐 Tab 后真实命令身份与输出边界（2026-07-30）
- [x] 接入本地图片主题库并完成全窗口背景、终端透明渲染和分区可读性遮罩（2026-07-31）
- [x] 完成 stale Runtime 停止幂等收口与传统 AI 隐藏保活（2026-07-31）
- [x] 校正本轮 SSH 范围与固定 safe-auto 执行策略文档（2026-07-31）
- [x] 按原生终端层级重做模式条、Shell 文本流、内联 Agent 区域和提示符输入（2026-07-31）
- [x] 完成自动/固定输入模式、状态指示和终端快捷键闭环（2026-07-31）

## 验证结果

- `node --experimental-strip-types --test tests/inputRouter.test.ts`：8 项通过。
- `npm run build`：TypeScript 与 Vite 生产构建通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：17 项通过，3 项需显式 Docker 环境的 smoke test 被忽略。
- 浏览器 IPC mock：Shell 命令进入 PTY；中文自然语言清除当前 Shell 行并定向发送到当前会话 Agent；Agent 模式自动开启。
- 阶段 1 纯逻辑测试：28 项通过，覆盖 Surface Registry、20 标签隔离、输入决策、上下文
  去重/预算/脱敏和跨主机隔离。
- `npm run build`：阶段 1 新增状态、决策与上下文代码通过 TypeScript 和 Vite 生产构建。
- 双模式基础回归：31 项通过，覆盖同一 Surface 下 `terminal:` 与 `ai-panel:` 通道独立、
  单侧关闭不影响另一侧、危险动作审批前不建通道及 20 Surface 隔离。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
  interrupt_request_waits_for_runtime_acknowledgement -- --nocapture`：1 项通过，
  验证停止操作会等待远端 Agent Runtime 确认。
- `node --test --experimental-strip-types tests\*.test.ts`：52 项通过，覆盖输入路由、
  Surface 隔离、上下文、typed action 风险、批量执行、追加、停止和续期。
- `cargo test --lib`：22 项通过，3 项需 Docker 的传输 smoke test 被忽略。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- 桌面实机：连接已保存的 `38.244.23.117:18454`，自然语言自动进入 Agent，一轮
  批量执行 5 条只读诊断命令并正常结束；执行详情可展开，随后输入 `uptime` 自动进入
  Shell Block，退出码与输出正确，Composer 可继续输入。
- 重启后登录首屏复测：欢迎信息与真实提示符正常，内部 `stty -echo` 安装命令不再显示。
- 风险策略实机复测：Agent 自动执行
  `if command -v iostat >/dev/null 2>&1; then ...; else vmstat ...; fi`，
  未弹危险确认并完成 3 条只读磁盘 IO 检查；真实文件覆盖仍由单元测试保持审批要求。
- 上下文实机复测：在 `38.244.23.117:18454` 选择输出
  `CONTEXT_TOKEN_7319` 的 Shell Block，再执行干扰 Block 后询问 Agent；Agent 只回答
  所选标识，证明 `selected-blocks` 不会误取最新 Block。
- `node --test --experimental-strip-types tests\*.test.ts`：56 项通过；新增覆盖显式上下文
  策略和交互式 Shell Block 不复制 ANSI 全屏输出。
- `cargo test --manifest-path src-tauri\Cargo.toml --lib`：25 项通过，3 项需 Docker 的
  传输 smoke test 被忽略；新增 Bootstrap 确认标记解析回归。
- Raw TUI 实机复测：`38.244.23.117:18454` 中两次运行 `top`，全屏交互正常，
  `Ctrl+C` 后恢复统一 Composer；时间线仅保留折叠单行，未写入全屏输出。
- Tab 接管实机复测：`172.18.71.52:22` 中从 Composer 输入 `ec` 后按 Tab 进入原生
  Shell，`Ctrl+C` 取消后恢复 Composer，不产生伪 Block。
- 双主机握手实机复测：`38.244.23.117:18454` 与 `172.18.71.52:22` 均完成
  Bootstrap/Ready，登录屏不再显示 Shell Integration 安装脚本。
- `node --test --experimental-strip-types tests\*.test.ts`：65 项通过；新增覆盖 500 Block
  首屏只渲染最近 120 条、分批加载、12 KB 以上 Shell 输出自动折叠和远程文件附件装配。
- `cargo test --manifest-path src-tauri\Cargo.toml --lib`：28 项通过，3 项需 Docker 的传输
  smoke test 被忽略；新增覆盖 UTF-8 远程文本、字符边界截断及二进制拒绝。
- 双标签性能实机复测：`38.244.23.117:18454` 执行约 13 KB 输出后只显示折叠摘要；
  `172.18.71.52:22` 的命令 Block 和未发送草稿在来回切换后保持独立并完整恢复。
- SFTP 文件上下文实机复测：从 `38.244.23.117:18454` 的 SFTP 右键添加
  `/root/.bash_logout`，SSH Composer 显示 `.bash_logout` chip；点击可查看真实路径与内容，
  点击移除后 Composer 高度和策略显示恢复正常。
- Tab 文件名补全实机复测：在 `172.18.71.52:22` 输入 `cat /etc/hostn` 后按 Tab，
  原生 Shell 补全并执行 `cat /etc/hostname`；Shell Block 标题使用完整命令，输出仅为
  `proxy_52`，不再混入提示符重绘，Composer 随后恢复可输入。
- 长命令补全实机复测：执行约 200 字符、跨终端物理行的命令并在末尾补全
  `/etc/hostname`；Bash DEBUG preexec 在 Readline 最终回显后划定输出边界，Block 只保留
  命令真实输出和 `proxy_52`，不再收集跨行重绘。
- 退出码独立实测：通过系统 SSH 打开隔离 Bash PTY，依次执行 `false`、`true` 和
  `sh -c 'exit 7'`，prompt marker 分别采集 `1`、`0`、`7`；DEBUG preexec 不再覆盖 `$?`。
- Agent 时间线实机复测：在 `172.18.71.52:22` 输入“分析当前服务器性能，检查负载、
  内存和磁盘并给出简洁结论”；用户请求全程保留，4 条只读命令折叠为一行，最终结论返回，
  控制状态恢复为空闲，Composer 可继续输入。
- Agent 请求保留与收口复测：在 `38.244.23.117:18454` 输入“请检查当前服务器的运行
  时间和根分区使用率，完成后用两行总结”；请求以独立 Block 持续显示，两条只读命令折叠
  为一行，最终总结返回后 Composer 恢复可输入。
- 危险审批实机复测：请求直接执行
  `rm -rf /tmp/termai-approval-probe-test` 后出现“拒绝 / 修改 / 执行”；点击拒绝后远端
  未执行命令，折叠行明确显示“已拒绝”，最终回复同步说明操作未执行。
- Agent 停止实机复测：启动 20 秒采样任务后点击“停止”，运行中的
  `timeout 25 top -b -n 10 -d 2` 折叠行切换为“已停止”，控制状态回到空闲，
  Composer 立即恢复。
- 双模式实机复测：顶部 AI 打开后只显示传统右侧 AI 面板，内联 Shell/Agent 控件隐藏；
  关闭传统 AI 后原内联 Block、停止状态和 Composer 完整恢复。
- 双主机并发实机复测：在 `172.18.71.52:22` 与 `38.244.23.117:18454` 分别启动
  12 秒和 8 秒 Agent 任务；切换标签时两个输入与控制状态互不锁定，任务分别返回
  `proxy_52` 和 `USykAmnA2`。
- 三主题桌面复测：深色、极夜和浅色均可实时切换；浅色下请求、执行状态和 Composer
  对比度正常，验证后恢复深色。
- 混合输入路由实机复测：输入“直接执行命令
  `ps aux --sort=-%cpu | head -3`，不要预检查”时不再因管道符误入 Shell；请求以 Agent
  Block 保留，只读命令自动执行并返回总结。
- 安全自动执行策略从危险命令黑名单收紧为保守只读白名单；`bash -c`、`sh -c`、
  `find -delete/-exec`、`sed -i`、脚本解释器写文件、`docker exec`、`ip link set`、
  `sysctl -w` 和命令替换均必须确认，复合只读诊断仍可自动执行。
- 拒绝语义实机复测：对 `bash -c 'echo termai-safe-auto-probe'` 点击拒绝后，Runtime
  直接显示“任务已停止”，不会让模型改写成等价命令继续执行；只有用户主动追加新要求才会
  重新规划。
- `node --test --experimental-strip-types tests\executionPresentation.test.ts
  tests\terminalAgentRuntime.test.ts`：17 项通过；新增覆盖“已拒绝 / 已停止 / 执行失败”
  状态标签及危险审批拒绝状态。
- `node --test --experimental-strip-types tests\*.test.ts`：80 项通过。
- `cargo test --manifest-path src-tauri\Cargo.toml --lib`：30 项通过，3 项需显式 Docker
  环境的传输 smoke test 被忽略。
- `pnpm build` 与 `git diff --check` 通过。
- 传统右侧 Agent 卡死复现：模型返回 typed action JSON 后，旧面板只按 Markdown 命令卡
  处理，既显示了内部协议，也没有进入执行 Runtime。现已统一解析 typed action、隐藏协议
  数据，并在模型结束后进入风险判断和执行批次。
- 传统右侧 Agent 实机复测：`172.18.71.52:22` 完成服务器性能诊断并返回最终总结；
  `172.18.71.66:22` 执行 `vmstat 1 20` 期间点击停止，折叠行立即显示“已停止 / 已中断”，
  18 秒后无迟到结果覆盖。证据见 `output/dev/legacy-agent-returned.jpg` 和
  `output/dev/legacy-agent-stopped.jpg`。
- 统一终端上下文实机复测：执行 `cat /etc/hostname` 后询问“这台服务器的主机名是什么”，
  Agent 直接引用最近 Shell Block 回答 `kvm_crawler_proxy`，未重复探测；用户请求始终保留。
- 双标签并发实机复测：`172.18.71.66:22` 重新采样 `vmstat 1 20` 期间切换至
  `172.18.71.52:22`，另一标签可独立执行 `hostname` 并返回 `proxy_52`；切回后原任务已
  独立完成。证据见 `output/dev/inline-concurrent-host52.jpg` 和
  `output/dev/inline-concurrent-host66.jpg`。
- 执行中追加实机复测：`vmstat 1 15` 运行期间追加“只总结 CPU 和内存”，请求显示为等待
  当前步骤完成，随后按新要求输出且不再分析磁盘。证据见
  `output/dev/inline-agent-append.jpg`。
- Tab 接管实机复测：Agent 执行 `vmstat 1 20` 时输入 `cat /etc/hostna` 并按 Tab，
  当前 Agent 动作落成“已停止”，原生 Bash 补全为 `cat /etc/hostname`；回车后生成成功的
  Shell Block，输出 `kvm_crawler_proxy`。证据见 `output/dev/inline-tab-takeover.jpg`。
- 修复模型结束与命令批次启动之间的停止竞态、执行中占位状态和 AbortController 生命周期；
  停止后不再出现延迟启动、空白回复或永久“执行中”。
- 最终回归：Node 全量 `97/97` 通过；`pnpm build` 通过；Rust `33` 项通过、3 项 Docker
  传输 smoke test 按环境要求忽略；`git diff --check` 通过；最新 Tauri stderr 无 panic
  或运行时错误。
- 图片主题桌面实测：主题背景只在 `.app-shell` 绘制一次，连续覆盖工具栏、主机栏、
  SSH xterm、传统 AI、状态栏和 SFTP；左右栏使用向中心减弱的方向性遮罩，避免形成两块
  不透明黑色面板。SSH `172.18.71.52:22` 登录信息、提示符和光标在背景上保持清晰，
  SFTP 双栏增加统一工作区遮罩后文件名、大小和修改时间可读。
- `node --test --experimental-strip-types tests\*.test.ts`：105 项通过；新增覆盖图片主题
  开启前后的 xterm 背景策略及运行时主题对象更新。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `cargo test --manifest-path src-tauri\Cargo.toml`：37 项通过，3 项需 Docker 的传输
  smoke test 按环境要求忽略；本次没有 Rust 回归失败。
- 代码审查收口：主题设置页不再用 `Promise.all` 一次性读取最多 100 张 Base64 预览，
  改为 `IntersectionObserver` 可视区懒加载，避免主题库较大时设置窗口出现内存峰值和卡顿；
  改动后 `pnpm build` 与 `git diff --check` 通过。
- 生命周期代码审查：`TerminalAgentRuntime.stop()` 改为幂等收口；即使 Runtime entry
  已因异常路径丢失，也会将 Surface 从 `executing` 恢复为 `idle` 并尝试中断独立通道。
  传统 AI 面板首次打开后隐藏只改变可见性，不再卸载并丢失运行态；真正卸载时会 Abort
  请求并关闭 `ai-panel:` 通道。
- `node --test --experimental-strip-types tests\*.test.ts`：108 项通过，新增覆盖 stale
  Surface 停止恢复、空 Surface 清理、传统 AI 隐藏保活和图片主题运行时更新。
- `cargo test --manifest-path src-tauri\Cargo.toml`：37 项通过，3 项需要显式 Docker
  环境变量的传输 smoke test 按条件忽略。
- `pnpm build` 与 `git diff --check`：通过；当前 dev 进程确认来自
  `D:\2060\secureCRTAi\src-tauri\target\debug\termai.exe`，最新 stderr 未发现
  panic、error 或 failed。
- 1280×800 桌面被动复核：图片主题连续覆盖双分屏和内联 Agent 时间线，两个 pane
  保持独立滚动与可读内容；该尺寸已接近双列分屏的信息密度下限，配合折叠主机栏或关闭
  传统 AI 面板使用。
- 1280×800 桌面视觉复核：会话标签下方只保留紧凑 `Shell / Agent` 模式条，已移除
  终端工具图标和“当前任务”胶囊；Shell 命令与输出使用无卡片终端文本，用户自然语言
  保留在提示符后，Agent 回复改为带状态标题的横向扁平区域，底部不再显示独立输入框、
  Footer 或发送按钮。
- 本轮呈现层收口后全量回归：Node `108/108` 通过；`pnpm build` 通过；Rust `37`
  项通过、3 项 Docker 传输 smoke test 按环境条件忽略；`git diff --check` 通过。
- 首条中文自然语言误入 Bash 的根因是输入路由只读取键盘捕获缓冲；IME、补全或
  Shell Integration 握手期间该缓冲可能为空，而 xterm 当前提示符后已经存在完整文本。
  现改为从可见提示符行恢复提交文本，并允许握手 `pending` 阶段进行 Agent 分类；
  只有明确进入 Raw Terminal 后才强制回退 Shell。
- 性能诊断未执行的根因是 typed action 解析器将“动作数量超过上限 5”同时当作致命错误：
  虽已保留前 5 项，Runtime 随后仍将整个动作批次清空。现将超限降为警告，执行前 5 项
  有界检查并继续依据结果规划；JSON 损坏、动作字段无效等真正的协议错误仍保持 fail-closed。
- 新增中文提示符恢复和超限计划执行回归测试；最终回归为 Node `110/110` 通过，
  `pnpm build` 通过，Rust `37` 项通过、3 项 Docker 传输 smoke test 按环境条件忽略，
  `git diff --check` 通过。
- 首次 SSH 打开出现双提示符的根因是 Shell Integration 安装产生的临时提示符位于
  `Ready` 事件前，而 Bash 正式提示符位于 `Ready` 事件后，两者分属不同数据批次。
  现仅在握手完成时丢弃安装阶段的临时提示符；握手超时或降级 Raw Terminal 时保留原始
  缓存，避免吞掉可交互提示符。新增 ANSI 着色提示符回归样本。
- Composer 从绝对定位底栏移入 Agent 时间线末尾；任务结束后下一条提示符紧跟总结，
  执行详情展开时随内容自然下移。模式条高度和字号进一步压缩，计划回复标记为“执行计划”，
  只有最终回复显示“分析完成”。
- 本轮回归：Node `110/110` 通过；`pnpm build` 通过；Rust `39` 项通过、3 项 Docker
  传输 smoke test 按环境条件忽略；`git diff --check` 通过。
- 修复 `ss -tuan | column -t` 被误判为危险命令：`column` 作为只读取标准输入的格式化
  工具加入只读执行集合，管道仍逐段校验，重定向写文件和未知命令仍要求确认。
- Agent 完整回复超过 1000 字符、16 行，或 Markdown 表格达到 10 行时默认折叠到
  300px；标题行提供“展开/收起”，简短总结保持完整显示。
- 新增只读格式化管道和长消息阈值测试；Node 全量 `112/112`、`pnpm build` 和
  `git diff --check` 通过。本轮未改 Rust，沿用紧邻上一轮 Rust `39` 项通过的结果。
- 修复带 `|| (...)` / `{ ...; }` 分组的复合只读诊断被误判：分组符现在作为 Shell
  语法处理，组内命令仍逐段执行只读白名单和危险规则。截图中的
  `uptime/free/top/df/iostat/cat` 完整命令可 safe-auto；新增括号包裹 `rm` 和花括号包裹
  `systemctl restart` 的反例，仍必须确认。Node 全量 `112/112`、`pnpm build` 和
  `git diff --check` 通过。
- 模式条收敛为仅 `Shell / Agent` 两个线性图标标签，移除快捷键、“自动”和“本次覆盖”
  文案；实际发送目标成为唯一选中状态，选中标签底部用 4px 呼吸圆点表示。空草稿保留
  最近一次语义判断，新输入命令或自然语言时实时切换，Provider 不可用时强制回到 Shell。
- 传统右侧 AI 面板在 SSH 会话中默认开启 Agent；用户明确关闭后当前标签保持关闭，
  本地终端仍不开放 Agent。显示状态和发送路径共用同一纯函数，避免复选框与实际模式不一致。
- 自然语言回复显式使用中文 UI 阅读字体和更舒展行距，Shell 命令、输出、路径、行内代码
  与代码块继续使用等宽字体。CSS 实际计算值和 4px 模式状态点已通过 dev 视觉夹具复核，
  证据见 `output/termai-mode-css-probe.png`。
- 输入路由升级为每标签稳定的 `auto / shell / agent` 三态：自动模式以呼吸圆点跟随语义，
  固定 Shell/Agent 以实线下划线表示；清空时间线、Shell Prompt 到达和标签切换均保持状态
  一致。固定 Shell 直接写入 PTY，不再执行语义分类，提交和中断边界会清理旧捕获缓冲。
- `Ctrl+Shift+I` 在自动与固定 Agent 间切换，Provider 不可用和 Raw Terminal 状态不会留下
  无效固定模式；`Ctrl+Shift+Y` 打开传统命令助手、切到非 Agent 对话并聚焦输入框，不发送
  空请求。快捷键提示已放入 Agent 图标和顶部 AI 按钮 tooltip。
- 桌面 dev 实测：在保存的 `38.244.23.117:18454` 标签点击固定 Shell 后，下划线状态和
  “固定模式”可访问文案同步出现；执行 `printf 'FIXED_SHELL_OK\n'` 返回预期输出，提交后
  固定 Shell 保持不变。复核期间检测到用户正在使用桌面，未继续抢占焦点测试快捷键。
- 最终回归：Node `126/126` 通过；`pnpm build` 通过；Rust `42` 项通过、4 项需显式
  Provider/Docker 环境的 smoke test 按条件忽略；`git diff --check` 通过。独立代码审查
  发现并修复 Provider 不可用快捷键脏状态和 Shell Prompt 覆盖固定 Agent 两项问题，
  修复后二次审查无剩余必须修项。
- 代码审查修复两项状态边界：内联 Composer 不继承旧 xterm 捕获可靠性；AI Provider
  关闭后不会保留禁用的 Agent 选中态。Node 全量 `117/117`、`pnpm build` 与
  `git diff --check` 通过。
- 2026-07-31 增加上下文与工具调用大回归：验证当前 Surface 只装配本标签的服务器环境、
  最近 Shell Block 和显式附件，跨主机内容不泄漏，凭据在进入模型前脱敏。远程输出、
  日志、文件和 Block 作为必须分析的诊断证据进入模型，但证据内容不具备指令优先级或
  执行授权；任何后续动作仍需根据用户目标独立生成并经过 typed-action 与风险校验。
- 增加默认忽略、显式环境变量开启的真实 AI/SSH smoke test。使用当前已配置 Provider，
  在 3 个已保存 SSH 会话分别执行严格限定的 `uptime`、`df -h /`，再把真实输出交给
  Provider 总结；同时验证双通道并发、单通道中断恢复和提示注入拒绝。真实测试 1/1 通过，
  未打印 API Key，未向服务器发送危险命令。
- 本轮最终回归：Node `119/119` 通过；`pnpm build` 通过；Rust `39` 项通过，真实 AI
  smoke 与 3 项 Docker 传输 smoke 默认忽略；单独启用真实 AI smoke 后 1/1 通过；
  `src-tauri/src/ai.rs` 格式检查和 `git diff --check` 通过。全量 Rust 格式检查仍会报告
  工作区已有文件的格式差异，本轮未批量格式化，避免改动用户已有代码。
- 主题选择从 WebView `localStorage` 迁移到桌面配置文件 `store.json`：
  `themePreferences.colorTheme` 和 `backgroundThemeId` 分别原子保存。首次启动会迁移旧值并
  删除旧缓存；后续选择在配置写入成功后才更新 UI，保存失败明确提示。图片主题文件失效时
  自动回退到纯色并清理失效配置。新增配置写盘/重载、字段互不覆盖和非法值拒绝测试；
  Rust `42` 项通过、4 项条件 smoke 忽略，Node `119/119` 与 `pnpm build` 通过。最新
  桌面 dev 启动后已确认 `%APPDATA%\TermAI\store.json` 写入 `themePreferences`。
- 收敛远程证据的安全语义：相关错误、状态、建议和操作提示必须参与推理；内容可信度需要
  模型结合上下文判断；证据本身永远不能授权执行命令。边界标签改为“终端/远程诊断证据”，
  不再用笼统的“不可信数据”弱化真实错误信息。
- Provider 返回无法解析的 typed action 时，Runtime 使用独立格式修复提示最多重试一次；
  修复阶段不打开 Agent SSH 通道、不执行服务器命令，也不得新增原响应未表达的命令。
  修复结果仍重新经过 typed-action 解析和本地风险策略，第二次失败即安全停止。
- Shell/Agent 模式条移除可见文字，保留两个线性图标、选中呼吸圆点和悬停提示，缩短模式条
  占用宽度；屏幕阅读器继续通过 `aria-label` 和 `aria-pressed` 获得完整语义。
- 新增格式修复成功/失败、真实修复建议驱动重规划、混合提示注入不获授权等协议回归；
  再以本地等价性校验阻止修复阶段新增或改变原动作。Agent 协议与 Runtime 定向测试
  `28/28`、Node 全量 `124/124`、Rust `42` 项通过（4 项条件 smoke 忽略），
  `pnpm build` 通过。
- 2026-07-31 桌面真机复核：当前 dev 客户端连接保存的 SSH 会话后，模式栏只显示 Shell
  与 Agent 两个图标，UI Automation 可读取对应悬停/无障碍名称，未再出现可见文字占位。
- 真实 DeepSeek + 3 个保存 SSH 会话 smoke 首次暴露简化测试提示没有给完整 schema，
  Provider 因而会省略 `type` 或返回 YAML。产品主提示和真实 smoke 现均明确要求严格 JSON、
  完整 type、禁止 YAML/尾逗号/追加文字，并要求输出前自检；正常计划与诊断重规划最终都
  首次解析成功，格式修复调用次数为 0。
- 修复器继续作为最后防线：此前真实 malformed fence/JSON 已验证最多只修复一次；命令必须
  仍存在于原响应，修复结果还需重新通过 typed-action 与风险策略，之后才允许打开 SSH 通道。
- 真机 smoke 在 3 个会话分别执行限定只读命令 `uptime`、`df -h /`，并在首个会话生成
  真实退出码 1 的端口占用诊断输出。Provider 正确采纳其中 `ss -ltnp` 建议，混入的
  `rm -rf /` 未进入动作计划；后续只执行 `ss -ltnp`。双 SSH 通道并发、中断和恢复、
  最终总结均通过。复核后 Node `124/124`、Rust `42` 项、`pnpm build` 继续通过。

## 最终验收证据矩阵

| 能力 | 自动化证据 | 桌面证据 | 状态 |
| --- | --- | --- | --- |
| Shell/Agent 自动感知与固定模式 | `inputRouter`、`inputDecisionModel` 测试 | 自动圆点、固定 Shell 下划线和真实命令实测 | 已验证 |
| Shell/Agent/审批/执行/总结统一 Block 时间线 | Runtime、Renderer、Block protocol 测试 | 双主机真实 Agent 诊断与危险拒绝实测 | 已验证 |
| typed action 与固定 safe-auto | 风险白名单、协议 fail-closed 测试 | 只读自动执行、危险命令审批实测 | 已验证 |
| 执行中追加、停止、12 轮续期 | Runtime 队列、停止、续期测试 | `vmstat` 追加、停止和继续实测 | 已验证 |
| 标签隔离与双模式隔离 | 20 Surface、双 Runtime channel 测试 | 双主机并发和 AI/内联切换实测 | 已验证 |
| 标签关闭和异常停止清理 | dispose、request gate、stale stop 测试 | dev 无悬空错误日志 | 已验证 |
| Bash/Zsh Shell Integration 与 Raw TUI | marker、Block、Raw command 测试 | Tab、Top、长命令、非零退出码实测 | 已验证 |
| 上下文附件、预算、脱敏与跨主机隔离 | Context Assembler 全路径测试 | selected Block、SFTP 文件 chip 实测 | 已验证 |
| 500 Block、大输出与主题库性能 | 分页、折叠、主题懒加载测试/审查 | 双标签大输出和图片主题实测 | 已验证 |
| 全窗口图片主题与左右栏遮罩 | xterm 透明主题测试 | 主界面、SSH、SFTP、分屏被动复核 | 待用户视觉确认 |
| 本地 PowerShell Agent | 本轮不适用 | 保持 Raw Shell | 后续能力 |
| Docker 大文件/目录传输 smoke | 3 项条件测试未执行 | 既有真实传输证据 | 非本轮阻塞 |

## 遗留问题

- 当前 Shell Integration 只覆盖 SSH Bash/Zsh；本地 PowerShell 仍保持 Raw Shell。
- 用户桌面端视觉和交互验收尚未完成，验收前不提交、不打正式包。
