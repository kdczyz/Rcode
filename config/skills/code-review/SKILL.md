---
name: code-review
description: Review code changes for correctness, regressions, maintainability, and missing tests. Use for 代码审查 代码评审 pull request PR review diff review or when the user asks to inspect a patch before merging.
---

# Code Review

Review changes as a correctness investigation, not a style performance.

## Workflow

1. Read the requested diff and the surrounding code that defines its contracts.
2. Identify changed behavior, data flow, trust boundaries, and compatibility impact.
3. Trace failure paths: empty input, partial state, concurrency, retries, permissions, and cleanup.
4. Check whether tests prove the new behavior and protect against regressions.
5. Report only actionable findings that are supported by specific code evidence.

## Finding Format

For each finding provide severity, location, failure scenario, impact, and the smallest credible fix. Keep summaries separate from findings. If no material issue is found, say so and name any residual testing gap.

## Guardrails

- Prioritize functional defects and security risks over naming preferences.
- Do not claim a bug without a concrete execution path.
- Avoid reviewing generated files unless they are the source of behavior.
- Do not edit code unless the user also asks for fixes.
