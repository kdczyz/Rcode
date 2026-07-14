import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskPlan } from "./agent";

test("task plan parser extracts a bounded executable checklist", () => {
  const plan = parseTaskPlan(`先检查现状，再以最小变更完成目标。\n\n## 执行计划\n1. [ ] 梳理状态边界\n2. [ ] 重构上下文选择\n3. [x] 补充验证`);
  assert.equal(plan?.summary, "先检查现状，再以最小变更完成目标。");
  assert.deepEqual(plan?.steps.map((step) => step.status), ["pending", "pending", "completed"]);
  assert.equal(plan?.steps[1].title, "重构上下文选择");
});

test("task plan parser ignores unstructured or single-step answers", () => {
  assert.equal(parseTaskPlan("普通回答，没有计划。"), undefined);
  assert.equal(parseTaskPlan("## 执行计划\n1. [ ] 只有一步"), undefined);
});
