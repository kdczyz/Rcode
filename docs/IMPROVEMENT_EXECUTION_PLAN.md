# Rcode 主流 Coding Agent 补齐计划

目标：把 Rcode 从“本地 agent runtime 雏形”推进到更成熟的 coding agent，重点补齐项目理解、测试修复闭环、diff/PR 生命周期、任务隔离、规则记忆、插件生态和产品可视化。

## 执行顺序

### 1. 项目索引与上下文引擎

状态：进行中

要做：

- 扫描项目文件树。
- 自动读取 package.json、README、AGENTS.md、RCODE.md、配置文件。
- 提取 scripts、依赖、项目规则和关键文件。
- 注入 agent context。

验收：agent 每次调用前能看到项目摘要，而不是只靠模型盲猜要读哪些文件。

### 2. 项目规则与记忆

状态：进行中

要做：

- 支持 AGENTS.md / RCODE.md / .cursorrules 等规则文件。
- 支持目录级规则优先级。
- 将规则摘要注入 agent context。

验收：agent 能遵守项目级规则、命令和开发规范。

### 3. 测试结果解析与自动修复循环

状态：进行中

要做：

- 解析 TypeScript、ESLint、Jest/Vitest、build output。
- 保留失败输出。
- 把失败结果转成结构化摘要。
- 引导 agent 定位文件、修复、再次验证。

验收：跑测试失败后 agent 能读懂错误并继续修。

### 4. Diff Review 与补丁体验

状态：计划中

要做：

- 文件级 diff 摘要。
- 风险和影响范围识别。
- 输出 PR-ready review summary。
- 后续支持 hunk 接受 / 回滚。

验收：agent 能稳定总结这次改了什么、风险在哪、哪些文件最重要。

### 5. GitHub PR 生命周期

状态：计划中

要做：

- 原生 GitHub API 创建 PR。
- 读取 PR 状态和评论。
- 生成 PR body。
- 后续支持 reviewer comment 修复。

验收：不只依赖本地 gh CLI，也能用 token/API 完成 PR 操作。

### 6. 任务隔离与分支/worktree

状态：计划中

要做：

- 每个任务可创建独立 branch。
- 后续可支持 worktree。
- 避免污染当前工作区。

验收：长任务和并发任务有独立工作区边界。

### 7. 产品化接口与前端可视化

状态：计划中

要做：

- 暴露 project context API。
- 暴露 agent capability API。
- 前端显示 delivery intent、工具时间线、测试结果、diff 摘要。

验收：用户能看见 agent 正在做什么、为什么做、结果是什么。

## 本轮目标

本轮优先完成底层：

- project context engine
- rules loader
- test output parser
- context injection
- project context API
- PR API 基础模块

UI 层后续继续接。
