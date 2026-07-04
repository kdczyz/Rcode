import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TaskBranchPlan {
  branchName: string;
  baseBranch: string;
  commands: string[];
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

export function buildTaskBranchPlan(prompt: string, baseBranch = "main"): TaskBranchPlan {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = slugify(prompt);
  const branchName = `rcode/${date}-${slug}`;

  return {
    branchName,
    baseBranch,
    commands: [
      `git fetch origin ${baseBranch}`,
      `git checkout -B ${branchName} origin/${baseBranch}`
    ]
  };
}

export async function createTaskBranch(cwd: string, prompt: string, baseBranch = "main") {
  const plan = buildTaskBranchPlan(prompt, baseBranch);
  const output: string[] = [];

  for (const command of plan.commands) {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], { cwd, timeout: 60000 });
    output.push(`$ ${command}`);
    if (stdout) output.push(stdout.trim());
    if (stderr) output.push(stderr.trim());
  }

  return {
    ...plan,
    output: output.join("\n")
  };
}
