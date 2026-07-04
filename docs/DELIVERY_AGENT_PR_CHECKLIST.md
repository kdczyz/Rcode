# Delivery Agent PR Checklist

Use this checklist before merging the `rog` branch.

## Runtime

- [ ] Agent detects delivery intent correctly.
- [ ] Feature prompts push the agent toward implementation.
- [ ] Bug prompts push the agent toward root-cause fix.
- [ ] Test prompts use `run_tests` where possible.
- [ ] PR prompts read `git_status` and `git_diff` before opening a PR.

## Tools

- [ ] `git_status` works in a project folder.
- [ ] `git_diff` returns a useful trimmed diff.
- [ ] `run_tests` preserves stdout/stderr on failure.
- [ ] `open_pull_request` fails gracefully when GitHub CLI is missing or unauthenticated.

## Permissions

- [ ] `git_status` is low risk.
- [ ] `git_diff` is medium risk.
- [ ] `run_tests` is high risk.
- [ ] `open_pull_request` is high risk and approval-gated.

## Follow-up

- [ ] Expose delivery intent in the frontend.
- [ ] Add structured test log parser.
- [ ] Add native GitHub API PR creation.
- [ ] Add commit tool.
