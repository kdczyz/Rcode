# PR: Delivery-first coding agent runtime

## Summary

This PR upgrades Rcode from a tool-calling local agent prototype into a delivery-first coding agent runtime focused on:

- shipping features
- fixing bugs
- running tests
- reviewing diffs
- preparing and opening PRs

## Key changes

### Delivery workflow

- Added `server/deliveryWorkflow.ts`.
- Detects delivery intent from the user prompt:
  - feature
  - bugfix
  - test
  - review
  - pr
  - general
- Injects task-specific done criteria into the agent context.

### Optimized agent context

- Added `server/agentContext.ts`.
- Adds context budgeting, tool-output trimming, history compaction, skill hint injection, and delivery workflow injection.

### Optimized agent invocation

- Added `server/agentInvoker.ts`.
- Routes model calls through `prepareAgentContext(...)` before calling the provider.
- Logs context stats and delivery intent.

### Server-side skill hints

- Added `server/agentSkillHints.ts`.
- Provides server-safe skill hints without importing client-side `src/skills`.

### Delivery tools

Added new tool types and implementations:

- `git_status`
- `git_diff`
- `run_tests`
- `open_pull_request`

Updated:

- `server/types.ts`
- `server/tools.ts`
- `server/permissions.ts`
- `config/agent.toml`

### Skill library and mainstream skill packs

Adds a built-in skill library and mainstream coding agent skill packs for planning, coding, review, testing, PR, docs, integrations, and maintenance workflows.

## Tests

Not run in this GitHub connector environment. The runtime now includes a dedicated `run_tests` tool that defaults to `npm run typecheck` when available.

## Risks

- `open_pull_request` depends on GitHub CLI (`gh`) being installed and authenticated in the user's local environment.
- The delivery workflow uses keyword intent detection first; future versions should support model-based intent classification.
- Server and client skill registries currently have separate representations to avoid server build rootDir issues.

## Follow-ups

- Expose delivery intent and context stats in the frontend stream.
- Add structured test result parsing.
- Add commit tooling.
- Replace GitHub CLI PR creation with native GitHub API integration.
