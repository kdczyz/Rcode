---
name: performance-optimization
description: Measure and improve application performance using profiles, budgets, and before-after evidence. Use for 性能优化 profiling latency throughput memory CPU bundle size database query speed web performance or slow application diagnosis.
---

# Performance Optimization

Optimize measured bottlenecks and protect the result with a repeatable benchmark.

## Workflow

1. Define the user-visible metric, workload, environment, and acceptable budget.
2. Capture a reproducible baseline before changing code.
3. Profile to locate the dominant cost across CPU, memory, I/O, network, rendering, or database work.
4. Change the smallest high-leverage bottleneck.
5. Repeat the same measurement and compare median and tail behavior.
6. Run correctness tests and document the tradeoff introduced.

## Guardrails

- Do not optimize from intuition alone.
- Avoid benchmarks dominated by startup noise or caches unless that is the target behavior.
- Preserve correctness, accessibility, and maintainability.
- Prefer removing work over making unnecessary work slightly faster.
