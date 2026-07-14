# Agent Permission Framework

一个可以连接 AI 的本地 agent 桌面框架，目标是向 Codex / Claude Code 一类成熟 coding agent 靠拢。

当前重点能力：

- 跨平台受控执行默认策略：项目内自主执行，联网、越界和危险操作请求审批或阻止；当前不宣称 OS 级沙箱。
- 本地 API token：桌面客户端启动时生成一次性 token，保护 agent 执行接口。
- Cloudflare 账号：Worker + D1 提供注册、登录、会话恢复和退出；桌面端使用系统安全存储保存会话 Token。
- 权限规则：支持 `allow` / `ask` / `deny`，并按 `deny > ask > allow` 处理。
- 工具注册表：内置文件读取、目录检查、文本搜索、patch、shell、长期进程会话、web fetch、git status/diff/branch/stage/commit，并可动态接入 MCP tools。
- SQLite 状态：保存会话消息、审批、审计事件、MCP 配置和 memory。
- 项目上下文：加载 `AGENTS.md`、`.agent/rules/*.md` 和项目 memory。
- 长会话上下文：按用户轮次保留最近消息、压缩早期对话，并截断大型工具输出而不拆散工具调用链。
- 任务工作流：SSE 输出准备、规划、检查、执行、审批和完成阶段；计划模式只暴露只读工具，并可确认计划后一键进入执行。
- MCP / Skills / Hooks 入口：支持 MCP server 配置管理、工具发现/调用、skills 激活和受信任 command hooks。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

打开 Vite 输出的地址，通常是 `http://localhost:5173`。

## 长期进程会话

开发服务器、文件监听器等不会自行退出的命令由 Rcode 托管，不需要也不允许在命令中添加 `&` 或 `nohup`。Agent 可以使用：

- `start_process`：启动长期进程并返回会话 ID、PID 和启动输出。
- `read_process`：读取当前状态和最近输出。
- `write_process`：向标准输入发送内容。
- `stop_process`：停止进程及其子进程树。
- `list_processes`：列出当前项目的托管进程。

聊天输入框底栏的“终端”按钮可查看当前项目的全部长期进程，包含状态、PID、命令、输出和停止操作；聊天中的进程卡片也会同步刷新。Rcode 服务退出时会清理仍在运行的托管进程，重启后不会自动恢复或重新执行旧命令。

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

- `src/`：React 客户端；可复用界面按 `components/chat`、`layout`、`settings`、`sidebar` 分类。
- `server/index.ts`：本地 API 服务入口。
- `server/agent/`：会话编排、项目上下文、hooks、skills 和 subagents。
- `server/providers/`：AI Provider 适配与注册。
- `server/security/`：权限规则、审批决策、路径校验和 shell 风险分析。
- `server/runtime/`：运行配置、受控命令执行和内置工具。
- `server/integrations/`：MCP 等外部集成。
- `server/storage/`：SQLite 会话、审批、审计、MCP 和 memory。
- `server/shared/`：服务端共享类型。
- `cloudflare/auth-worker/`：Cloudflare Worker 认证 API、D1 迁移与部署配置。
- `electron/`：Electron 主进程和预加载脚本。
- `cli/`：轻量 CLI，可运行 `doctor`、`run`、`mcp`。
- `scripts/`：构建、测试和清理脚本。
- `docs/`：项目规划和补充文档。
- `data/`：本地运行数据，不纳入版本控制。
- `config/providers.json`：AI provider 和模型配置。
- `config/agent.toml`：客户端、权限和电脑控制策略。

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
- `GET /api/processes`、`GET /api/processes/:id`：列出或读取托管进程。
- `POST /api/processes/:id/input`、`POST /api/processes/:id/stop`：写入或停止托管进程。
- `GET /api/audit`：查看本地审计事件。
- `GET/POST/DELETE /api/mcp/servers`：管理 MCP server 配置。
- `GET /api/mcp/servers/:id/tools`、`POST /api/mcp/servers/:id/test`、`POST /api/mcp/servers/:id/trust`：测试和信任 MCP server。
- `GET /api/skills`：查看已发现的 skills。
- `GET/POST/DELETE /api/memory`：管理项目 memory。
- `GET /api/agents`：查看已发现的 subagents。
- `GET /api/health`：查看服务和 AI 配置状态。

Agent SSE 流除文本和工具事件外，还会返回 `workflow_state`、`context_snapshot` 和 `task_plan`，客户端可据此展示运行阶段、上下文预算和可确认的任务计划。

受保护接口在桌面打包模式下需要 `x-agent-token` 或 bearer token；Electron 会自动注入。

## Cloudflare 账号服务

线上认证服务：`https://rcode-auth.kdczyz0728-994.workers.dev`

```bash
npm run dev:auth             # 本地 Worker，端口 8788
npm run auth:migrate:local   # 应用本地 D1 迁移
npm run auth:deploy:dry      # 部署前检查
npm run auth:deploy          # 发布 Worker
npm run auth:migrate:remote  # 应用线上 D1 迁移
```

认证 API：

- `POST /v1/auth/register`：创建账号并签发会话。
- `POST /v1/auth/login`：邮箱或用户名登录。
- `GET /v1/auth/me`：恢复当前会话。
- `POST /v1/auth/logout`：撤销当前会话。

本地调试可用 `VITE_AUTH_API_URL` 覆盖浏览器端地址；Electron 可用 `RCODE_AUTH_API_URL` 覆盖主进程地址。

这个结构的目标是方便继续扩展：可以新增工具、接入更多模型供应商、把审批策略替换成更细的权限系统，或者封装成 Electron/Tauri 桌面应用。
