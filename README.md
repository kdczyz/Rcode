# Agent Permission Framework

一个可以连接 AI 的本地 agent 框架原型，重点实现三种权限模式：

- 请求批准：编辑外部文件和使用互联网时始终询问。
- 替我审批：低风险操作自动执行，高风险操作请求批准。
- 完全访问权限：允许 agent 直接访问工具。

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

本项目也已经内置 NVIDIA NIM 配置：

- `config/providers.json`：配置 `https://integrate.api.nvidia.com/v1` 和默认模型。
- `config/agent.toml`：配置客户端模式、权限策略和电脑控制工具。
- `.env.local`：本地密钥文件，已加入 `.gitignore`。

NVIDIA 的密钥变量名是：

```bash
NVIDIA_API_KEY=你的 NVIDIA API Key
```

如果没有配置 `AI_API_KEY`，应用仍可启动，并会提示框架已就绪。

## 架构

- `src/App.tsx`：Agent 控制台 UI，包含权限模式、任务输入、审批卡片和工具结果。
- `server/index.ts`：本地 API 服务。
- `server/agent.ts`：会话、审批和工具调用编排。
- `server/permissions.ts`：权限模式与风险规则。
- `server/tools.ts`：本地工具注册与执行，目前包括读文件、写文件、网页获取。
- `config/providers.json`：AI provider 和模型配置。
- `config/agent.toml`：客户端、权限和电脑控制策略。
- `server/aiProvider.ts`：AI Provider 适配层。

## API

- `POST /api/agent/run`：运行一次 agent 任务。
- `POST /api/agent/approve`：批准或拒绝待执行工具。
- `GET /api/health`：查看服务和 AI 配置状态。

这个结构的目标是方便继续扩展：可以新增工具、接入更多模型供应商、把审批策略替换成更细的权限系统，或者封装成 Electron/Tauri 桌面应用。
