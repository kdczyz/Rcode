# Rcode 主流 Skill Pack

这个 Skill Pack 用来把市面主流 coding agent 的高频能力沉淀成 Rcode 项目自带 skill 库。

## 参考方向

主流 agent 的常见能力集中在：

- 需求规划与任务拆解
- 代码实现与 bug 修复
- 重构与依赖维护
- PR / diff 审查
- 安全、性能、可访问性审查
- 单元测试、端到端测试、CI 修复
- Git、提交、PR 描述、review 回复
- README、API 文档、遗留代码解释
- Provider、MCP、插件和设置页
- 日志分析、lint 修复、项目健康检查

## 代码文件

```text
src/skills/mainstreamSkillPacks.ts
```

## 分组

### 1. 规划与产品组

- 实现方案规划
- Issue 转任务简报
- 多 Agent 任务拆分

### 2. 编码与重构组

- 功能开发
- Bug 追踪修复
- 重构助手
- 前端体验打磨
- API 集成开发
- 依赖升级维护

### 3. 审查质量与安全组

- PR / Diff 审查
- 安全审查
- 性能审查
- 可访问性审查

### 4. 测试与 CI 组

- 单元测试生成
- 端到端测试规划
- CI 失败修复

### 5. Git / PR 协作组

- 提交信息生成
- PR 描述生成
- Review 回复助手
- 发布说明生成

### 6. 文档与知识组

- README 生成与更新
- API 文档生成
- 遗留代码解释
- 项目规则生成

### 7. 工具与集成组

- Provider 接入向导
- MCP 连接规划
- 设置页体验设计

### 8. 维护与自动化组

- Lint 批量修复
- 日志分析
- 项目健康检查

## 导出方法

```ts
import {
  mainstreamSkillPackGroups,
  mainstreamSkills,
  listMainstreamSkillGroups,
  listMainstreamSkillsByCategory,
  listMainstreamSkillsByGroup
} from "../src/skills/mainstreamSkillPacks";
```

## 下一步接入

1. 把 mainstreamSkills 合并进 builtinSkills。
2. 在设置页展示 Skill Pack 分组。
3. 在 agent run 前根据 prompt 匹配 builtinSkills + mainstreamSkills。
4. 给每个项目增加 skill 开关。
5. 支持第三方 skill 包导入。
