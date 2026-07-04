# 改进项完成状态

## 已完成

### 1. 项目索引与上下文引擎

- 新增 `server/projectContext.ts`。
- 自动扫描文件树、README、规则文件、配置文件、package scripts、技术栈。
- 已注入 `server/agentContext.ts`。
- 新增 `/api/project/context`。

### 2. 项目规则与记忆

- 支持读取 `AGENTS.md`、`RCODE.md`、`CLAUDE.md`、`.cursorrules`、`.github/copilot-instructions.md`。
- 规则文件会进入 Project Context Snapshot。

### 3. 测试结果解析与修复闭环基础

- 新增 `server/testResultParser.ts`。
- 支持 TypeScript、ESLint、Jest/Vitest、build、runtime stack 解析。
- 已接入 `run_tests` 输出。

### 4. Diff Review 基础

- 新增 `server/diffReview.ts`。
- 可以按文件统计 diff、风险等级和原因。

### 5. GitHub PR 生命周期基础

- 新增 `server/githubPr.ts`。
- `open_pull_request` 优先使用 `GITHUB_TOKEN` / `GH_TOKEN` 走 GitHub API。
- 没有 token 时回退到本地 `gh pr create`。

### 6. 任务隔离基础

- 新增 `server/taskWorkspace.ts`。
- 可以为任务生成独立分支名和分支创建命令。

### 7. 产品化接口基础

- 新增 `/api/project/context`，供前端展示项目上下文。

## 仍需后续接 UI / 深化

- diffReview 需要接入 `git_diff` 输出或新增 API。
- taskWorkspace 需要接入工具系统或任务创建 API。
- 前端还需要显示 delivery intent、项目上下文、测试摘要、diff 风险。
- GitHub PR 评论读取、CI 状态读取、review comment 修复仍未做。
- MCP / 插件系统仍是规划阶段。
