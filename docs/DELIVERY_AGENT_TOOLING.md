# Delivery Agent Tooling

## Tools added

- `git_status`
- `git_diff`
- `run_tests`
- `open_pull_request`

## Why

Mature coding agents should not only chat. They should inspect project state, change files, validate the result, and prepare PR-ready output.

## Notes

`open_pull_request` uses GitHub CLI in the local runtime. A future version should use native GitHub API integration.
