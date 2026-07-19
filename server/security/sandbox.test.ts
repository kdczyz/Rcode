import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyzeShellCommand, resolveWorkspacePath } from "./sandbox";
import { evaluatePermission } from "./permissionRules";
import { executeTool } from "../runtime/tools";
import { portableExecutor } from "../runtime/executor";
import { managedProcessManager } from "../runtime/processManager";

test("resolveWorkspacePath marks workspace files as inside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  await writeFile(path.join(root, "a.txt"), "hello", "utf8");
  const resolved = await resolveWorkspacePath("a.txt", root);
  assert.equal(resolved.insideWorkspace, true);
  assert.equal(resolved.canonicalPath, await realpath(path.join(root, "a.txt")));
});

test("resolveWorkspacePath handles files in missing nested directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const resolved = await resolveWorkspacePath("css/style.css", root);
  assert.equal(resolved.insideWorkspace, true);
  assert.equal(resolved.canonicalPath, path.join(await realpath(root), "css", "style.css"));
});

test("resolveWorkspacePath detects paths outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-console-outside-"));
  await mkdir(path.join(root, "nested"));
  const resolved = await resolveWorkspacePath(path.join(outside, "x.txt"), root);
  assert.equal(resolved.insideWorkspace, false);
});

test("write_file creates missing parent directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const result = await executeTool(
    { id: "call-test", name: "write_file", arguments: { path: "css/style.css", content: "body { color: red; }" } },
    root
  );

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(root, "css", "style.css"), "utf8"), "body { color: red; }");
});

test("analyzeShellCommand flags network and destructive commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const analysis = await analyzeShellCommand("curl https://example.com && rm -rf build", undefined, root);
  assert.equal(analysis.mayUseNetwork, true);
  assert.equal(analysis.destructive, true);
});

test("shell analysis classifies approval-bound operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const analysis = await analyzeShellCommand("npm install && npm run db:migrate && wrangler deploy --env production", undefined, root);
  assert.equal(analysis.installsDependencies, true);
  assert.equal(analysis.databaseMigration, true);
  assert.equal(analysis.deployment, true);
  assert.equal(analysis.productionOperation, true);
  const wrappedDeploy = await analyzeShellCommand("npm run remote:deploy", undefined, root);
  const packageRunner = await analyzeShellCommand("npx eslint .", undefined, root);
  assert.equal(wrappedDeploy.deployment, true);
  assert.equal(packageRunner.installsDependencies, true);
});

test("permission policy allows routine checks and asks for risky mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const routine = await evaluatePermission("workspace_write", { id: "routine", name: "run_shell", arguments: { command: "npm run typecheck" } }, root);
  const install = await evaluatePermission("workspace_write", { id: "install", name: "run_shell", arguments: { command: "npm install" } }, root);
  const destructive = await evaluatePermission("full_access", { id: "delete", name: "run_shell", arguments: { command: "rm -rf data/cache" } }, root);
  assert.equal(routine.effect, "allow");
  assert.equal(install.effect, "ask");
  assert.equal(destructive.effect, "ask");
});

test("permission policy automatically allows user-requested image generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const image = await evaluatePermission("workspace_write", {
    id: "image",
    name: "generate_image",
    arguments: { prompt: "A quiet city at night" }
  }, root);
  assert.equal(image.effect, "allow");
  assert.equal(image.requiresApproval, false);
});

test("permission policy denies credential and personal-file access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const credential = await evaluatePermission("full_access", {
    id: "credential",
    name: "run_shell",
    arguments: { command: "security find-generic-password -s example -w" }
  }, root);
  const outside = await evaluatePermission("workspace_write", {
    id: "outside",
    name: "read_file",
    arguments: { path: path.join(os.homedir(), "personal.txt") }
  }, root);
  assert.equal(credential.effect, "deny");
  assert.equal(outside.effect, "deny");
});

test("full access allows ordinary paths and shell commands outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-console-outside-"));
  const outsideFile = path.join(outside, "note.txt");
  await writeFile(outsideFile, "visible from full access", "utf8");

  const fileDecision = await evaluatePermission("full_access", {
    id: "outside-file",
    name: "read_file",
    arguments: { path: outsideFile }
  }, root);
  const shellDecision = await evaluatePermission("full_access", {
    id: "outside-shell",
    name: "run_shell",
    arguments: { command: `/bin/ls -la ${outside}` }
  }, root);
  const fileResult = await executeTool({
    id: "outside-file-execution",
    name: "read_file",
    arguments: { path: outsideFile }
  }, root, { permissionMode: "full_access", permissionEffect: "allow" });
  const shellResult = await portableExecutor.run({
    command: "pwd",
    cwd: outside,
    projectPath: root,
    allowOutsideWorkspace: true
  });

  assert.equal(fileDecision.effect, "allow");
  assert.equal(fileDecision.requiresApproval, false);
  assert.equal(shellDecision.effect, "allow");
  assert.equal(fileResult.ok, true);
  assert.equal(fileResult.content, "visible from full access");
  assert.equal(shellResult.ok, true);
  assert.equal(shellResult.stdout.trim(), await realpath(outside));
});

test("analyzeShellCommand marks cwd outside workspace as blocked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-console-outside-"));
  const analysis = await analyzeShellCommand("pwd", outside, root);
  assert.equal(analysis.cwdInsideWorkspace, false);
  assert.equal(analysis.blockedReason, "Command cwd is outside the workspace.");
});

test("analyzeShellCommand flags redirection outside workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-console-outside-"));
  const analysis = await analyzeShellCommand(`echo hello > ${path.join(outside, "x.txt")}`, undefined, root);
  assert.equal(analysis.redirectsOutsideWorkspace, true);
});

test("portable executor blocks unsafe cwd before spawning shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-console-outside-"));
  const result = await portableExecutor.run({ command: "pwd", cwd: outside, projectPath: root });
  assert.equal(result.ok, false);
  assert.equal(result.blockedReason, "Command cwd is outside the workspace.");
});

test("portable executor injects allowlisted secret references and redacts output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "rcode-test-secret-value";
  try {
    const result = await portableExecutor.run({
      command: "node -e \"process.stdout.write(process.env.CLOUDFLARE_API_TOKEN)\"",
      projectPath: root,
      secretRefs: ["CLOUDFLARE_API_TOKEN"]
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "[REDACTED]");
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous;
  }
});

test("portable executor rejects secret references that are not allowlisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  await assert.rejects(
    portableExecutor.run({ command: "true", projectPath: root, secretRefs: ["AI_API_KEY"] }),
    /not allowlisted/
  );
});

test("managed process sessions capture output and can stop the process tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const started = await managedProcessManager.start({
    command: "node -e \"console.log('server ready'); setInterval(() => {}, 1000)\"",
    projectPath: root,
    startupWaitMs: 200
  });

  assert.equal(started.status, "running");
  assert.match(started.output, /server ready/);
  const stopped = await managedProcessManager.stop(started.id);
  assert.equal(stopped.status, "stopped");
});

test("managed process sessions reject user-managed background syntax", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  await assert.rejects(
    managedProcessManager.start({ command: "python3 -m http.server 8765 &", projectPath: root }),
    /start_process manages the process lifecycle/
  );
});

test("managed process redaction covers secrets split across output chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "split-secret-value";
  try {
    const processResult = await managedProcessManager.start({
      command: "node -e \"const s=process.env.CLOUDFLARE_API_TOKEN; process.stdout.write(s.slice(0,7)); setTimeout(() => process.stdout.write(s.slice(7)), 25)\"",
      projectPath: root,
      startupWaitMs: 150,
      secretRefs: ["CLOUDFLARE_API_TOKEN"]
    });
    assert.match(processResult.output, /\[REDACTED\]/);
    assert.doesNotMatch(processResult.output, /split-secret-value/);
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous;
  }
});

test("run_shell stores large output as artifact summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const result = await executeTool(
    { id: "call-large", name: "run_shell", arguments: { command: "node -e \"process.stdout.write('x'.repeat(13000))\"" } },
    root,
    { conversationId: "test-conversation" }
  );
  assert.equal(result.ok, true);
  assert.ok(result.artifacts?.length);
  assert.ok(result.content.includes("Full output saved as artifacts"));
});

test("sqlite_query reads workspace databases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const database = new DatabaseSync(path.join(root, "demo.sqlite"));
  database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('safe');");
  database.close();
  const result = await executeTool({
    id: "sqlite-read",
    name: "sqlite_query",
    arguments: { path: "demo.sqlite", query: "SELECT name FROM items" }
  }, root);
  assert.equal(result.ok, true);
  assert.match(result.content, /safe/);
});

test("apply_patch supports unified multi-hunk edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-console-"));
  const filePath = path.join(root, "demo.txt");
  await writeFile(filePath, "one\ntwo\nthree\nfour\nfive", "utf8");
  const patch = [
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -4,2 +4,2 @@",
    " four",
    "-five",
    "+FIVE"
  ].join("\n");
  const result = await executeTool(
    { id: "call-patch", name: "apply_patch", arguments: { path: "demo.txt", patch } },
    root
  );
  assert.equal(result.ok, true);
  assert.equal(await readFile(filePath, "utf8"), "one\nTWO\nthree\nfour\nFIVE");
});
