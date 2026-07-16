---
name: systematic-debugging
description: Diagnose bugs through reproducible evidence, hypothesis testing, and root-cause isolation. Use for 调试 排错 崩溃 根因 定位 bug debugging crash failure flaky behavior error investigation or when a symptom must be explained before fixing.
---

# Systematic Debugging

Find the earliest incorrect state instead of patching the final symptom.

## Workflow

1. Restate the observed behavior and the expected behavior.
2. Reproduce the failure with the smallest reliable command, input, or test.
3. Gather evidence from relevant logs, state, code paths, and environment boundaries.
4. Form a small set of falsifiable hypotheses and test the cheapest discriminator first.
5. Isolate the root cause, then describe the causal chain from input to symptom.
6. If a fix is requested, make the narrowest change and add a regression check.

## Guardrails

- Do not change code during diagnosis unless the request includes implementation.
- Separate facts, inferences, and unknowns.
- Treat intermittent failures as timing or shared-state problems until evidence says otherwise.
- Verify the fix against the original reproduction, not only a new happy-path test.
