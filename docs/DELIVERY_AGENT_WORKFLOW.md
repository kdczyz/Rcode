# 成熟 Coding Agent 交付工作流

这一版把 Rcode 的 agent 从“能调用工具的聊天 agent”推进成“交付型 coding agent”。重点不是多解释，而是直接交付功能、修 bug、跑测试、准备 PR。

## 核心目标

- 用户要功能：直接定位文件、实现代码、查看 diff、跑验证、总结交付。
- 用户要修 bug：定位根因、做最小修复、跑测试、说明结果。
- 用户要跑测试：使用专用测试工具，保留失败输出，继续修复。
- 用户要开 PR：读取状态和 diff，生成 PR body，尝试通过 GitHub CLI 创建 PR。

## 新增后端模块

```text
server/deliveryWorkflow.ts
```

它负责识别用户任务意图：

- feature
- bugfix
- test
- review
- pr
- general

并把对应的交付规则注入 agent 上下文。

## 新增工具

### git_status

读取当前分支、工作区状态和 upstream 信息。适合提交前、PR 前和审查前使用。

### git_diff

读取当前工作区 diff 或 staged diff。适合改动后 review 和生成 PR summary。

### run_tests

运行项目验证命令。默认选择：

1. package.json 里有 typecheck：`npm run typecheck`
2. 有 test：`npm test -- --runInBand`
3. 有 build：`npm run build`
4. 兜底：`npm test -- --runInBand`

测试失败时会保留 stdout/stderr，方便 agent 继续修复。

### open_pull_request

通过 GitHub CLI 创建 PR。PR body 应包含：

- Summary
- Tests
- Risks

该工具风险等级为 high。

## 权限策略

- git_status：low
- git_diff：medium
- run_tests：high
- open_pull_request：high

在 request_approval 模式下：

- 项目内 git_status / git_diff 可以直接执行。
- open_pull_request 始终需要审批。
- run_tests 如果命令或 cwd 指向项目外，需要审批。

## Agent 行为变化

现在 agent 上下文会注入：

- delivery intent
- recommended tools
- done criteria
- feature / bugfix / test / review / PR 对应行为规则

例如用户说“帮我修这个报错并开 PR”，agent 会优先进入：

1. bugfix / pr 意图识别
2. 读取相关文件
3. 修改代码
4. run_tests 验证
5. git_diff 总结
6. open_pull_request 创建 PR

## 后续建议

1. 前端显示 delivery intent 和当前阶段。
2. 增加 PR body 生成器。
3. 增加 test result parser，把长日志结构化成错误列表。
4. 增加 commit 工具：自动生成 commit message 并提交。
5. 接入 GitHub API，替代本地 gh CLI 作为 PR 创建后端。
