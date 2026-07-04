# Rcode MCP Server

Rcode 内置 MCP server，用来把 Rcode 的项目理解、交付工作流、测试解析、diff review、任务分支计划和上下文压缩能力暴露给外部 MCP 客户端。

## 启动

```bash
npm run mcp:server
```

调试：

```bash
npm run mcp:inspect
```

## 配置示例

见：

```text
config/mcp.servers.example.json
```

示例：

```json
{
  "mcpServers": {
    "rcode": {
      "command": "npm",
      "args": ["run", "mcp:server"],
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

## 暴露的 Tools

### rcode.project_context

构建项目上下文快照，包括：

- 文件树
- package scripts
- README 摘要
- AGENTS.md / RCODE.md / CLAUDE.md / .cursorrules / Copilot instructions
- config 文件
- likely stack

### rcode.prepare_agent_context

复用 Rcode agent context 逻辑，输出：

- delivery intent
- skill hints
- project context
- compacted messages
- context stats

### rcode.delivery_workflow

根据任务 prompt 判断：

- feature
- bugfix
- test
- review
- pr
- general

并输出推荐工具、行为规则和完成标准。

### rcode.parse_test_result

解析测试、类型检查、lint、build 输出，支持：

- TypeScript
- ESLint
- Jest
- Vitest
- build error
- runtime stack
- unknown failure

### rcode.diff_review

把 unified git diff 转成：

- 文件级变更摘要
- 增删行统计
- 风险等级
- 风险原因

### rcode.task_branch_plan

根据任务 prompt 生成隔离分支名和分支创建命令。

### rcode.compact_messages

把 agent messages 按 Rcode 上下文预算压缩，输出 prepared messages 和 stats。

## Resources

### rcode://project/context

返回当前工作目录的 Project Context Snapshot。

### rcode://agent/capabilities

返回 Rcode MCP server 暴露的能力清单。

## Prompts

### delivery-first-coding-agent

面向直接交付功能、修 bug、跑测试、生成 PR 摘要的 coding agent prompt。

### fix-failing-tests

面向测试失败解析和修复循环的 prompt。

### pr-review-summary

面向 diff review 和 PR summary 的 prompt。

## 当前实现说明

当前 MCP server 使用轻量 JSON-RPC stdio 实现，没有引入外部 MCP SDK，避免增加依赖。后续可以替换为 `@modelcontextprotocol/sdk` 的 `StdioServerTransport`，以获得更完整的协议兼容性。

## 后续改进

- 增加 streamable HTTP MCP transport。
- 把 MCP tools 和 Rcode 前端工具市场打通。
- 支持第三方 MCP server 管理、启停和权限配置。
- 增加 MCP tool call 审计日志。
- 增加 OAuth / token 管理。
