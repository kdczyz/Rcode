# Delivery Agent Review Guide

Review these files first:

- `server/deliveryWorkflow.ts`
- `server/agentContext.ts`
- `server/tools.ts`
- `server/permissions.ts`
- `server/types.ts`
- `config/agent.toml`

Focus review on:

- whether tool risks are correct
- whether tests preserve failed output
- whether PR creation should remain CLI-based or move to GitHub API
- whether delivery workflow prompts are too aggressive
