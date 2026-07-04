# Agent 调用与上下文优化

本次优化目标是让 Rcode 的 agent 调用更接近主流 coding agent：先整理上下文，再调用模型，而不是把完整会话无差别塞进 provider。

## 新增模块

```text
server/agentContext.ts      上下文预算、压缩、摘要和 Skill hint 注入
server/agentInvoker.ts      统一的优化后模型调用入口
server/agentSkillHints.ts   server 侧轻量 Skill 匹配器
```

## 调用链变化

旧链路：

```text
server/agent.ts -> callAiStream(conversation.messages, options)
```

新链路：

```text
server/agent.ts -> callAgentStreamOptimized(conversation.messages, options)
                 -> prepareAgentContext(...)
                 -> callAiStream(prepared.messages, options)
```

## 上下文处理策略

### 1. 上下文预算

默认限制：

- maxMessages: 32
- maxTotalChars: 42000
- maxToolResultChars: 6000
- maxAssistantChars: 9000
- keepRecentMessages: 18

### 2. Tool 输出裁剪

过长 tool result 会保留头部和尾部，中间用 trimmed 标记替代，避免长日志或大文件内容撑爆上下文。

### 3. 历史摘要

当消息数量或总字符数超出预算，会把较早消息压成一个 system summary，并保留最近消息。

### 4. Skill hint 注入

根据最近一条用户消息匹配 server 侧 skill hints，把对应工作方式注入 system addendum。

例如：

- 实现方案规划
- 项目上下文理解
- 功能开发
- Bug 追踪修复
- 代码审查
- 测试与构建反馈
- Git / PR 协作
- Provider 配置
- 安全审查
- 文档生成

### 5. 调用日志

`agentInvoker.ts` 会输出上下文统计：

```text
[AgentContext] stream: messages 40->20, chars 86000->35000, skills=feature-builder,test-runner
```

## 目前已接入

`server/agent.ts` 已经改为通过 `callAgentStreamOptimized` 调用模型。

## 后续建议

1. 把 context stats 通过 SSE 事件回传给前端。
2. 在设置页暴露上下文预算选项。
3. 把 server 侧 skill hints 和前端 skill library 做统一生成，避免双份维护。
4. 增加项目级记忆，例如 AGENTS.md、README、package scripts 摘要。
5. 增加工具结果结构化摘要，比如 build/test/lint 专用 parser。
