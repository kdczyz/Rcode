# Agent Permission Framework

一个可以连接 AI 的本地 agent 桌面框架，目标是向 Codex / Claude Code 一类成熟 coding agent 靠拢。

当前重点能力：

- 跨平台受控执行默认策略：项目内自主执行，联网、越界和危险操作请求审批或阻止；当前不宣称 OS 级沙箱。
- 本地 API token：桌面客户端启动时生成一次性 token，保护 agent 执行接口。
- 权限规则：支持 `allow` / `ask` / `deny`，并按 `deny > ask > allow` 处理。
- 工具注册表：内置文件读取、目录检查、文本搜索、patch、shell、web fetch、git status/diff/branch/stage/commit，并可动态接入 MCP tools。
- SQLite 状态：保存本地账号、会话消息、审批、审计事件、MCP 配置和 memory。
- 项目上下文：加载 `AGENTS.md`、`.agent/rules/*.md` 和项目 memory。
- MCP / Skills / Hooks 入口：支持 MCP server 配置管理、工具发现/调用、skills 激活和受信任 command hooks。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

打开 Vite 输出的地址，通常是 `http://localhost:5173`。

## AI 配置

后端使用 OpenAI-compatible Chat Completions 接口。你可以在 `.env` 中配置：

```bash
AI_API_KEY=你的密钥
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
```

本项目也已经内置 Xiaomi MiMo 配置：

- `config/providers.json`：配置 `https://api.xiaomimimo.com/v1` 和默认模型。
- `config/agent.toml`：配置客户端模式、权限策略和电脑控制工具。
- `.env.local`：本地密钥文件，已加入 `.gitignore`。

MiMo 的密钥变量名是：

```bash
AI_API_KEY=你的 MiMo API Key
```

如果没有配置 `AI_API_KEY`，应用仍可启动，并会提示框架已就绪。

## 架构

- `src/App.tsx`：Agent 控制台 UI，包含权限模式、任务输入、审批卡片和工具结果。
- `server/index.ts`：本地 API 服务。
- `server/agent.ts`：会话、审批和工具调用编排。
- `server/permissions.ts` / `server/permissionRules.ts`：权限模式、规则匹配和审批决策。
- `server/sandbox.ts` / `server/executor.ts`：工作区路径 canonical 校验、shell 风险分析和 portable guarded execution。
- `server/tools.ts`：内置工具注册与执行。
- `server/localDatabase.ts`：SQLite 本地账号、会话、审批、审计、MCP 和 memory。
- `server/contextManager.ts`：项目规则和 memory 注入。
- `server/skills.ts`：项目/用户 skills 扫描。
- `config/providers.json`：AI provider 和模型配置。
- `config/agent.toml`：客户端、权限和电脑控制策略。
- `server/aiProvider.ts`：AI Provider 适配层。
- `cli/agent-console.cjs`：轻量 CLI，可运行 `doctor`、`run`、`mcp`。

## CLI 终端

```bash
npm run build:server
rcode
```

常用命令：

```bash
rcode doctor
rcode run "检查这个项目"
rcode tools
rcode audit
rcode mcp list
rcode mcp add context7 "npx -y @upstash/context7-mcp"
rcode mcp test context7
rcode mcp tools context7
rcode memory list
rcode agents
```

交互模式内支持：

- `/mode workspace_write`：切换权限模式。
- `/project /path/to/project`：切换项目根目录。
- `/model model-id`：切换模型。
- `/tools`、`/audit`、`/mcp`、`/memory`、`/agents`、`/doctor`：查看平台状态。
- `/clear`：清空当前 CLI 会话上下文。
- `/exit`：退出。

如果本地服务未启动，CLI 会优先尝试启动 `dist-server-bundle/index.cjs`；没有构建产物时会回退到 `npm run dev:server`。

## 成熟化路线

后续补齐 Codex / Claude Code 等主流 agent 能力的计划见：

- [Rcode 成熟化补齐计划](docs/agent-maturity-plan.md)

## API

- `POST /api/agent/run`：运行一次 agent 任务。
- `POST /api/agent/approve`：批准或拒绝待执行工具。
- `GET /api/tools`：查看工具注册表。
- `GET /api/audit`：查看本地审计事件。
- `GET/POST/DELETE /api/mcp/servers`：管理 MCP server 配置。
- `GET /api/mcp/servers/:id/tools`、`POST /api/mcp/servers/:id/test`、`POST /api/mcp/servers/:id/trust`：测试和信任 MCP server。
- `GET /api/skills`：查看已发现的 skills。
- `GET/POST/DELETE /api/memory`：管理项目 memory。
- `GET /api/agents`：查看已发现的 subagents。
- `GET /api/health`：查看服务和 AI 配置状态。

受保护接口在桌面打包模式下需要 `x-agent-token` 或 bearer token；Electron 会自动注入。

这个结构的目标是方便继续扩展：可以新增工具、接入更多模型供应商、把审批策略替换成更细的权限系统，或者封装成 Electron/Tauri 桌面应用。
