import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activateSkills } from "./skills";

test("auto-learning can be activated explicitly without occupying every task context", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "rcode-skills-"));
  const skillRoot = path.join(projectPath, ".agent", "skills", "auto-learning");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(path.join(skillRoot, "agents"), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), `---
name: auto-learning
description: Capture verified reusable lessons.
---

# Auto Learning

Call record_learning after verified work.
`);
  await writeFile(path.join(skillRoot, "agents", "openai.yaml"), `interface:
  display_name: "自动学习测试"
  short_description: "Capture verified reusable lessons in a project record"
  default_prompt: "Use $auto-learning after verified work."
`);

  try {
    const ordinarySkills = await activateSkills("answer an ordinary question", projectPath);
    assert.equal(ordinarySkills.some((skill) => skill.name === "auto-learning"), false);
    const skills = await activateSkills("use $auto-learning after this verified task", projectPath);
    assert.equal(skills[0]?.name, "auto-learning");
    assert.equal(skills[0]?.displayName, "自动学习测试");
    assert.match(skills[0]?.content ?? "", /record_learning/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test("skills are selected automatically by task semantics", async () => {
  const cases = [
    ["请审查这个 PR 的回归风险", "code-review"],
    ["这个 bug 会崩溃，先调试并定位根因", "systematic-debugging"],
    ["采用测试驱动方式实现这个功能", "test-driven-development"],
    ["检查认证授权和输入处理的安全风险", "security-audit"],
    ["重新设计这个页面的 UI 和响应式布局", "frontend-design"],
    ["为新业务设计 REST 接口", "api-design"],
    ["优化慢查询和页面性能", "performance-optimization"],
    ["检查这个版本能否发布上线", "release-readiness"]
  ] as const;

  for (const [prompt, expectedSkill] of cases) {
    const activated = await activateSkills(prompt, process.cwd());
    assert.ok(
      activated.some((skill) => skill.name === expectedSkill),
      `${expectedSkill} should activate for: ${prompt}; got ${activated.map((skill) => skill.name).join(", ")}`
    );
  }
});
