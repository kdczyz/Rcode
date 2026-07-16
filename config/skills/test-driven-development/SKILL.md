---
name: test-driven-development
description: Develop behavior through focused failing tests, minimal implementation, and safe refactoring. Use for 测试驱动 TDD unit tests integration tests regression tests test-first development or requests to add behavior with strong verification.
---

# Test-Driven Development

Use tests to define observable behavior and keep implementation changes small.

## Red Green Refactor

1. Identify the public behavior and its most important boundary case.
2. Add one focused test that fails for the intended reason.
3. Run it and confirm the failure proves missing behavior rather than a broken fixture.
4. Implement the minimum production change that makes the test pass.
5. Run the focused test, then the relevant wider suite.
6. Refactor only while tests remain green.

## Test Quality

- Assert outputs and externally visible effects, not private implementation details.
- Keep fixtures small and deterministic.
- Prefer one reason to fail per test.
- Cover the regression path for every confirmed bug fix.
- Avoid snapshots when a few semantic assertions explain intent better.
