# Rcode

Rcode 是一个本地 Agent Console 原型，用来把 AI 对话、项目会话、工具调用和权限审批放到同一个客户端里。它通过 React/Vite 前端和 Express 本地服务连接 OpenAI-compatible Chat Completions 接口，让模型可以在受控策略下读取文件、写入文件、获取网页内容或执行必要的 Shell 命令。

项目重点不是某个单一模型供应商，而是验证本地 agent 的工作流：如何在项目上下文中运行任务、展示工具执行过程、生成文件 diff，并通过权限模式控制 AI 对电脑和文件系统的访问边界。

## 核心能力

- 本地 Agent 控制台：支持项目、会话、聊天消息、任务输入和工具执行结果展示。
- 三种权限模式：请求批准、替我审批、完全访问。
- 工具调用链路：支持读文件、写文件、网页获取和 Shell 命令执行。
- 审批机制：高风险或越界操作可以进入人工审批，自动审批模式下可由当前模型辅助判断风险。
- 文件变更可视化：写文件时会生成行级 diff，方便查看 agent 修改了什么。
- Provider 配置：通过配置文件接入 OpenAI-compatible 模型接口，方便替换不同模型供应商。
- 桌面端雏形：项目已包含 Electron 启动和打包脚本，可继续扩展为完整桌面客户端。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

打开 Vite 输出的地址，通常是：

```text
http://localhost:5173
```

如果要以桌面客户端方式运行：

```bash
npm run client
```

## AI 配置

后端使用 OpenAI-compatible Chat Completions 接口。你可以在 `.env` 中配置：

```bash
AI_API_KEY=你的密钥
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
```

也可以通过配置文件管理 provider：

- `config/providers.json`：配置模型供应商、接口地址、默认模型和能力声明。
- `config/agent.toml`：配置客户端模式、默认 provider、权限策略和电脑控制工具。
- `.env.local`：本地密钥文件，已加入 `.gitignore`，不要提交真实密钥。

当前仓库里保留了 Xiaomi MiMo 的 provider 配置，主要用于测试 OpenAI-compatible 接入流程。它不是项目的核心卖点；如果要换成其他兼容接口，只需要调整 `config/providers.json`、`config/agent.toml` 和对应环境变量即可。

如果没有配置 `AI_API_KEY`，应用仍可启动，并会提示框架已就绪。

## 权限模式

- 请求批准：项目内文件操作直接执行，项目外操作请求审批。
- 替我审批：由当前模型自动审核工具风险并决定是否执行，失败时回退到人工审批。
- 完全访问：允许所有工具操作直接执行，适合受信任的本地测试环境。

## 架构

- `src/App.tsx`：Agent 控制台 UI，包含项目、会话、权限模式、任务输入、审批卡片、工具结果和 diff 展示。
- `server/index.ts`：本地 API 服务。
- `server/agent.ts`：会话管理、流式对话、工具调用队列和审批编排。
- `server/permissions.ts`：权限模式、路径边界判断和工具风险规则。
- `server/tools.ts`：本地工具注册与执行，包括读文件、写文件、网页获取和 Shell 命令。
- `server/aiProvider.ts`：AI Provider 适配层，负责模型调用、流式输出和工具调用解析。
- `config/providers.json`：模型 provider 配置。
- `config/agent.toml`：客户端、AI、权限和电脑控制策略配置。
- `electron/main.cjs`：Electron 桌面端入口。

## API

- `POST /api/agent/run`：运行一次 agent 任务。
- `POST /api/agent/approve`：批准或拒绝待执行工具。
- `GET /api/health`：查看服务和 AI 配置状态。

## 适合继续扩展的方向

- 增加更多本地工具，例如项目搜索、终端任务、截图、应用打开等。
- 细化权限策略，例如按工具、目录、命令类型或风险等级配置审批规则。
- 增加多 provider 切换和模型列表管理。
- 完善桌面端体验，封装成 Electron 或 Tauri 客户端。
- 补充任务记录、执行日志、失败恢复和更完整的 diff/patch 工作流。
