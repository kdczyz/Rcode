import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeShellCommand, resolveWorkspacePath } from "./sandbox";
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
