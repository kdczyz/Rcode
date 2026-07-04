# Delivery Agent Implementation Status

## Implemented

- Delivery intent detection.
- Context budgeting and compaction.
- Skill hint injection.
- Delivery workflow injection.
- Dedicated Git status tool.
- Dedicated Git diff tool.
- Dedicated test runner tool.
- GitHub CLI based PR creation tool.
- Permission policy for new tools.
- Runtime config entries for new tools.
- Documentation for delivery workflow and PR review.

## Not yet implemented

- Native GitHub API PR creation inside the app runtime.
- Frontend display of delivery intent.
- Structured test output parser.
- Commit creation tool.
- Automatic project index.

## Recommended validation

Run:

```bash
npm run typecheck
npm run build:server
```

Then test agent prompts:

```text
实现一个小功能并跑测试
修复这个报错并说明根因
检查当前 diff 并生成 PR 描述
开一个 draft PR
```
