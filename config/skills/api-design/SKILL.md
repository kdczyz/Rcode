---
name: api-design
description: Design stable HTTP or RPC APIs with clear resources, schemas, errors, compatibility, pagination, and idempotency. Use for API 接口 接口设计 REST GraphQL RPC endpoint schema OpenAPI webhook integration or public interface review.
---

# API Design

Design the contract from consumer workflows and failure recovery.

## Workflow

1. Identify consumers, use cases, trust boundaries, and lifecycle operations.
2. Model resources and state transitions before choosing endpoint names.
3. Define request, response, validation, errors, pagination, filtering, and concurrency behavior.
4. Specify authentication, authorization, idempotency, retries, timeouts, and rate limits.
5. Check backward compatibility and provide an evolution or migration strategy.
6. Add examples for the happy path and the most important failure path.

## Guardrails

- Keep transport details separate from domain rules.
- Use consistent error envelopes and stable machine-readable codes.
- Avoid ambiguous optional fields and hidden server defaults.
- Do not break existing consumers without an explicit versioning plan.
