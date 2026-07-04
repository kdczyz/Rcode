# Rcode Skill 库

Skill 库用于把 Rcode 的 agent 能力沉淀成可注册、可检索、可组合的能力单元。

它不是简单 prompt 模板，而是 Rcode 对标 Codex 等主流 agent 时的能力组织层。

## 目录

```text
src/skills/
  types.ts          Skill 类型定义
  builtinSkills.ts  内置 Skill 列表
  registry.ts       Skill 查询与匹配方法
  index.ts          统一导出
```

## 当前内置 Skill

- 任务规划
- 项目上下文理解
- 代码编辑
- 代码审查
- 测试与构建反馈
- Git 工作流
- 模型 Provider 配置
- 文档生成

## Skill 结构

每个 Skill 包含：

- id
- name
- category
- summary
- description
- trigger
- capabilities
- requiredTools
- riskLevel
- systemHint
- enabledByDefault

## 设计目标

1. 让 agent 在执行前知道应该使用哪类能力。
2. 让设置页可以展示和开关不同 Skill。
3. 让后续多 agent、MCP、插件系统有统一能力描述。
4. 让主流 coding agent 的能力模块化，而不是散落在 prompt 里。

## 后续接入点

- 在 agent run 前根据用户 prompt 匹配 skill。
- 把匹配到的 skill systemHint 注入 system prompt。
- 在设置页展示所有 skill。
- 允许用户禁用或启用某些 skill。
- 支持项目级 skill 配置。
- 支持第三方 skill 包。

## 示例

```ts
import { findSkillsForPrompt, getSkillSystemHints } from "./skills";

const skills = findSkillsForPrompt("帮我重构这个项目并跑测试");
const hints = getSkillSystemHints(skills);
```

## 产品定位

Rcode 的 Skill 库服务于本地 coding agent 产品定位，目标是持续补齐 Codex 等主流 agent 的能力结构。
