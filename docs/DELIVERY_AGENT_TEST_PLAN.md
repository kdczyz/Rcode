# Delivery Agent Test Plan

## Commands

```bash
npm run typecheck
npm run build:server
```

## Manual prompts

```text
帮我实现一个小功能并跑测试
帮我修复这个报错并说明根因
检查当前 diff 并生成 PR 描述
开一个 draft PR
```

## Expected behavior

- Agent should prefer implementation over long discussion.
- Agent should call `run_tests` for validation.
- Agent should use `git_status` and `git_diff` before PR work.
- Agent should explain failed validation output and continue fixing when possible.
