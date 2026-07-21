---
name: memory-management
description: Manage durable and short-term memory when the user asks to remember, recall, forget, or configure memory; compatible with open-source memory workflows through explicit memory tools.
allowed_tools: memory_search memory_store memory_forget
---

# Memory management

Use the host application's project-scoped memory tools as the durable storage adapter.

## Contract

- Call `memory_search` before answering questions that explicitly depend on previously remembered preferences, decisions, or project facts.
- Call `memory_store` only for stable, reusable information or when the user explicitly says to remember something.
- Call `memory_forget` only with an exact ID returned by `memory_search`, and only after an explicit request to forget it.
- Never store credentials, authentication data, private raw logs, transient task state, or unverified guesses.
- Prefer a concise, self-contained memory. Set `kind` to `preference`, `decision`, `project`, `workflow`, or `note`, and set importance from 1 to 5.
- Use `ttlDays` for information that will become stale. Omit it for truly durable facts.

Open-source memory skills may delegate their storage operations to these tools. The tool result IDs are the canonical identifiers for deletion.
