---
name: release-readiness
description: Prepare software releases with risk-based verification, migration checks, rollback planning, and concise release notes. Use for 发布 上线 发布检查 release readiness deployment checklist changelog version bump migration rollout rollback or go-live review.
---

# Release Readiness

Turn the current change set into an evidence-backed release decision.

## Workflow

1. Define release scope, target environments, dependencies, and owners.
2. Inspect the actual diff and identify behavior, data, configuration, and permission changes.
3. Run the proportional build, tests, packaging, migration, and smoke checks.
4. Verify secrets, environment variables, feature flags, observability, and support documentation.
5. Define rollout order, success signals, stop conditions, and rollback steps.
6. Produce concise release notes with user impact and known limitations.

## Decision Output

State ready, ready with conditions, or not ready. List the evidence, remaining risks, and the exact condition that changes the decision.

## Guardrails

- Never treat a successful build as complete release verification.
- Do not run production deployment unless the user explicitly requests it.
- Treat irreversible data migrations as high risk and require a recovery plan.
