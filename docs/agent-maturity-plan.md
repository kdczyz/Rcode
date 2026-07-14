# Rcode 成熟化补齐计划

本文档把当前项目与 Codex、Claude Code 等主流 coding agent 的差距转成可执行路线。目标不是一次性堆功能，而是把 Rcode 补成一个可信、可扩展、可持续演进的本地 agent 平台。

## 当前状态

已具备：

- 桌面端、CLI 入口和本地 Express agent server。
- 工作区路径 canonical 校验、权限规则、审批流和审计事件。
- 内置工具注册表：文件读取、目录检查、搜索、patch、shell、web fetch、git status/diff。
- SQLite 保存会话、审批、审计、MCP 配置和 memory。
- `AGENTS.md`、`.agent/rules/*.md`、memory 注入。
- MCP 配置管理、Skills 扫描、`rcode` 终端入口。

主要缺口：

- `server/security/sandbox.ts` 仍是路径/命令分析，不是 OS 级沙箱；`run_shell` 仍通过 `zsh -lc` 执行。
- MCP 只有配置存储和 UI/CLI 管理，没有 stdio/http JSON-RPC client、tools/resources/prompts 接入。
- Skills 只扫描元数据，没有 `$skill` 显式调用、description 匹配、资源/脚本加载和工具约束。
- Hooks、Subagents 已有初步入口；上下文已具备按轮次压缩、工具输出收敛和预算快照，持久化摘要与 Git/PR/CI 闭环仍需继续实现。
- `apply_patch` 只是 `oldText -> newText` 替换，不支持多 hunk、冲突恢复和更强用户改动保护。

## 主流 Agent 基准

设计基准来自这些公开能力：

- Codex 把 sandbox 作为技术边界，且 shell、git、包管理器、测试命令都继承同一 sandbox 边界。
- Codex / Claude Code 都把 MCP 作为第三方工具和上下文生态，支持 stdio、HTTP、认证、server instructions、tools/resources/prompts。
- Codex Skills 使用 progressive disclosure：先暴露 name/description，触发后再加载完整 `SKILL.md` 和资源。
- Codex / Claude hooks 在 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop` 等生命周期运行确定性脚本，并要求本地 hook 信任。
- Claude Code subagents 使用独立上下文、独立工具权限、独立模型和独立 memory，适合 review/debug/research 等任务分工。

参考：

- <https://developers.openai.com/codex/concepts/sandboxing>
- <https://developers.openai.com/codex/mcp>
- <https://developers.openai.com/codex/skills>
- <https://developers.openai.com/codex/hooks>
- <https://code.claude.com/docs/en/mcp>
- <https://code.claude.com/docs/en/memory>
- <https://code.claude.com/docs/en/sub-agents>

## 阶段 1：可信执行边界

目标：把“策略检查”升级为“实际可约束执行”的安全底座。

实施内容：

- 新增 `SandboxExecutor` adapter 层：
  - `DarwinSandboxExecutor`：优先用 macOS sandbox-exec/Seatbelt profile 限制文件写入和网络。
  - `PortableSandboxExecutor`：Linux/Windows 暂时只做强审批降级，不宣称真沙箱。
  - 所有 shell、git、package manager、test runner 都必须通过 executor。
- 权限决策改为两层：
  - policy decision：`allow | ask | deny`。
  - enforcement decision：`sandboxed | denied | requires_user_approval | unavailable`。
- 加强路径安全：
  - 对文件、cwd、命令参数中出现的绝对路径做 realpath 校验。
  - 对 symlink、hardlink、父目录不存在、新文件创建路径分别覆盖测试。
- 加强 shell 分析：
  - 从字符串扫描升级为命令元数据提取。
  - 记录 argv、cwd、环境变量、是否联网、是否写出工作区、是否触碰敏感路径。
- 生产默认策略：
  - `workspace_write` 为默认。
  - `full_access` 需要二次确认并写入审计。
  - sandbox 不可用时，高风险工具一律进入人工审批。

验收标准：

- shell 在工作区外创建文件失败。
- shell 访问网络默认审批。
- `npm test`、`git diff` 等工作区内命令可在 sandbox 中运行。
- 审计事件包含 sandbox adapter、profile、cwd、exit code、duration、permission reason。
- 测试覆盖路径逃逸、symlink 逃逸、危险命令、网络命令、sandbox 不可用降级。

## 阶段 2：完整 MCP 工具生态

目标：让 MCP server 真的变成 agent 可调用工具，而不是只在设置页登记。

实施内容：

- 新增 MCP client manager：
  - stdio transport：启动进程、发送 JSON-RPC、管理生命周期、捕获 stderr。
  - streamable HTTP transport：支持 bearer token、headers、timeout。
  - 初始化流程：`initialize -> tools/list -> resources/list -> prompts/list`。
  - 缓存 server instructions，并注入 agent system context。
- 将 MCP tools 注册进现有工具注册表：
  - 命名：`mcp__server__tool`。
  - 每个 MCP tool 都有 source、risk、defaultApproval、inputSchema。
  - 权限规则支持 server 级和 tool 级匹配。
- CLI/UI 能力：
  - `rcode mcp test <id>`。
  - `rcode mcp tools <id>`。
  - 设置页显示连接状态、instructions、tools/resources/prompts。
- 安全：
  - MCP server 第一次连接需要信任确认。
  - 外部内容提示注入风险提示。
  - MCP elicitation 初版先走终端/桌面审批弹窗。

验收标准：

- 能添加 Context7 这类 stdio MCP 并调用其工具。
- 能添加一个 HTTP MCP 并列出 tools。
- MCP tool 调用进入统一审批、审计和 SSE 事件流。
- 禁用 MCP server 后工具不再暴露给模型。
- MCP server 崩溃后 agent 给出可理解错误，不拖死主进程。

## 阶段 3：Skills、Hooks 与项目规则

目标：把项目从“有配置入口”升级为“可复用工作流平台”。

实施内容：

- Skills activation：
  - 支持 `$skill-name` 显式调用。
  - 基于 description 做隐式匹配。
  - 触发后加载完整 `SKILL.md`、references、scripts。
  - 支持 skill 声明 allowed tools、required MCP、mode preference。
- Hooks runner：
  - 事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop`。
  - 初版只支持 command hooks。
  - hook 定义位置：用户目录、项目 `.agent/hooks.json`。
  - 项目 hook 需要 trust hash；内容变化后重新信任。
- 规则管理：
  - `AGENTS.md` 继续作为上下文，不作为安全边界。
  - `.agent/rules/*.md` 支持按路径匹配加载。
  - `/memory` 或设置页可查看当前加载的规则、skills、hooks。

验收标准：

- 输入 `$some-skill` 会加载该 skill 的完整说明并体现在模型请求里。
- description 匹配能自动触发合适 skill，且不超过上下文预算。
- PreToolUse hook 可以阻止指定 shell 命令。
- PostToolUse hook 可以记录或校验工具结果。
- 未信任的项目 hook 不会运行，并在 UI/CLI 明确提示。

## 阶段 4：上下文压缩、记忆与长任务

目标：让 agent 能稳定处理长会话和大项目，而不是靠全量消息堆上下文。

实施内容：

- Context manager 升级：
  - 每轮估算 token。
  - 对历史消息做 turn-level summary。
  - 工具完整输出存 artifact，只把摘要放回上下文。
  - 搜索、读文件、MCP resources 都有预算和优先级。
- Memory：
  - 自动保存构建命令、测试命令、用户偏好、项目约定、失败修复经验。
  - 按 recency + importance + current task relevance 排序召回。
  - 支持 `rcode memory list/add/remove` 和桌面设置页。
- Artifacts：
  - 保存完整 stdout/stderr、大 diff、MCP resource 内容。
  - UI/CLI 可按 audit id 查看。

验收标准：

- 100+ turn 会话不会无限增长请求上下文。
- 大 shell 输出不会完整塞回模型。
- 用户说“记住本项目用 pnpm”后，后续任务能自动采用。
- `rcode memory list` 能查看当前项目 memory。
- summary 生成失败时不丢原始记录，最多退回更保守上下文。

## 阶段 5：Subagents 与工程闭环

目标：从单 agent 聊天变成可以完成真实工程任务的工作台。

实施内容：

- Subagents：
  - 支持 `.agent/agents/*.md` 和用户目录 agents。
  - frontmatter 字段：name、description、prompt、tools、model、permissionMode、maxTurns。
  - 主 agent 可派发 research、review、debug、test-fix 子任务。
  - 子 agent 独立上下文，最终只回传 summary、findings、artifacts。
- Git 工作流：
  - 创建/切换分支。
  - stage、commit、生成提交信息。
  - PR 摘要生成。
  - 默认不自动 push。
- Review 模式：
  - findings-first 输出。
  - 文件/行号定位。
  - 严格区分 bug、risk、test gap、style suggestion。
- CI/测试：
  - 解析 test output。
  - 自动定位失败测试。
  - 可运行“修复 -> 测试 -> diff -> 总结”的闭环。
- CLI/TUI：
  - `rcode review`。
  - `rcode task` 长任务模式。
  - `/agents`、`/git`、`/memory`、`/hooks`。

验收标准：

- review 模式能输出带文件行号的 findings。
- debug 子 agent 能搜索日志和文件，主上下文只收到摘要。
- 能完成一个小 bugfix：创建分支、打 patch、跑测试、展示 diff、生成 commit message。
- 子 agent 权限不能超过主任务授权边界。

## 阶段 6：产品化、治理与质量

目标：从个人工具走向可分发、可诊断、可团队使用的软件。

实施内容：

- 配置层级：
  - user config。
  - project config。
  - managed/admin config。
  - precedence 明确并可诊断。
- Doctor：
  - 检查 provider、API key、sandbox、MCP、hooks trust、SQLite、端口、CLI link。
  - 输出可复制诊断报告。
- 可观测性：
  - traces：每轮模型调用、工具调用、审批、hook、MCP call。
  - 本地 dashboard：失败率、耗时、token、审批次数。
- 打包：
  - 签名、公证、自动更新。
  - 密钥进入 keychain，不放 app bundle。
  - Windows/Linux 后续打包。
- 测试体系：
  - 单元测试：权限、沙箱、MCP client、skills、hooks、context。
  - 集成测试：agent run SSE、审批恢复、CLI。
  - E2E：Electron smoke test。

验收标准：

- `rcode doctor` 能定位 90% 常见环境问题。
- release 包不包含 `.env.local` 或敏感配置。
- 所有新增模块有测试覆盖。
- Electron smoke test 能启动 app、进入本机模式、发送一次只读任务。

## 推荐实施顺序

1. 真实 sandbox executor。
2. MCP client manager 和 MCP tools 接入。
3. hooks runner 和 trust。
4. skills activation。
5. context compaction + memory 管理。
6. patch 引擎升级。
7. subagents。
8. Git/PR/CI 工作流。
9. doctor、trace、E2E、打包签名。

## 风险与取舍

- 真沙箱是最大风险项，但也是和主流 agent 拉齐信任模型的前提。
- MCP 需要严格处理 prompt injection 和 server trust，否则工具越多风险越大。
- Skills/hooks/subagents 都会增加上下文和执行复杂度，必须配合 trace 和审计。
- 不建议继续扩展 UI 细节，直到 sandbox、MCP、hooks 三个控制平面完成。

## 下一步可直接开工的任务包

### Task A：SandboxExecutor v1

- 新增 executor interface。
- 将 `run_shell`、`git_status`、`git_diff` 改为 executor 执行。
- macOS 增加 sandbox profile。
- 增加 sandbox 集成测试。

### Task B：MCP Client v1

- 新增 stdio client。
- 实现 initialize、tools/list、tools/call。
- 将 MCP tools 暴露到 `/api/tools`。
- CLI 增加 `rcode mcp test/tools`。

### Task C：Hooks v1

- 新增 hooks config parser。
- 实现 PreToolUse、PostToolUse、PermissionRequest。
- 增加 hook trust hash。
- UI/CLI 展示待信任 hook。

### Task D：Skills v1

- `$skill` 显式触发。
- description 简单匹配。
- 加载完整 `SKILL.md` 到项目上下文。
- 支持 skill allowed tools。
