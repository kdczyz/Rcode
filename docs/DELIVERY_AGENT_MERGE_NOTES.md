# Delivery Agent Merge Notes

Before merge, validate:

```bash
npm run typecheck
npm run build:server
```

Then manually verify the agent can:

- implement a small change
- fix a failing typecheck
- run `run_tests`
- read `git_status`
- read `git_diff`
- prepare PR content
