#!/usr/bin/env node
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const readline = require("node:readline/promises");

const projectRoot = path.resolve(__dirname, "..");
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m"
};

let baseUrl = process.env.AGENT_CONSOLE_URL || "http://127.0.0.1:8787";
let token = process.env.AGENT_LOCAL_TOKEN || "";
let managedServer;

const state = {
  conversationId: undefined,
  mode: process.env.AGENT_CONSOLE_MODE || "workspace_write",
  model: process.env.AGENT_CONSOLE_MODEL || "",
  thinkingMode: process.env.AGENT_CONSOLE_THINKING || "balanced",
  projectPath: process.env.AGENT_PROJECT_PATH || process.cwd(),
  autoStart: process.env.AGENT_CONSOLE_AUTO_START !== "0"
};

function paint(color, text) {
  return `${colors[color] || ""}${text}${colors.reset}`;
}

function headers(json = false) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(token ? { "x-agent-token": token } : {})
  };
}

async function fetchJson(apiPath, options = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function pingServer() {
  try {
    return await fetchJson("/api/health");
  } catch {
    return undefined;
  }
}

function serverEntrypoint() {
  const bundled = path.join(projectRoot, "dist-server-bundle", "index.cjs");
  if (fs.existsSync(bundled)) return { command: process.execPath, args: [bundled] };
  return { command: "npm", args: ["run", "dev:server"] };
}

async function ensureServer() {
  const health = await pingServer();
  if (health) return health;
  if (!state.autoStart) throw new Error(`Agent server is not running at ${baseUrl}`);

  token ||= crypto.randomBytes(32).toString("base64url");
  const entry = serverEntrypoint();
  managedServer = spawn(entry.command, entry.args, {
    cwd: projectRoot,
    env: { ...process.env, AGENT_LOCAL_TOKEN: token, HOST: "127.0.0.1", PORT: "8787" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  managedServer.stdout.on("data", (chunk) => {
    if (process.env.AGENT_CONSOLE_DEBUG) process.stderr.write(chunk);
  });
  managedServer.stderr.on("data", (chunk) => {
    if (process.env.AGENT_CONSOLE_DEBUG) process.stderr.write(chunk);
  });

  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const started = await pingServer();
    if (started) return started;
  }
  throw new Error("Timed out waiting for Agent server to start");
}

async function* parseSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      yield JSON.parse(line.slice(6));
    }
  }
}

function summarizeArgs(args = {}) {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ").slice(0, 100)}`)
    .join(" ");
}

async function streamAgent(endpoint, body, rl) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  let pendingApprovals = [];
  for await (const event of parseSse(response)) {
    if (event.type === "run_started") {
      state.conversationId = event.conversationId || state.conversationId;
      process.stderr.write(paint("dim", `\nconversation ${String(state.conversationId).slice(0, 8)}\n`));
    } else if (event.type === "text_delta") {
      process.stdout.write(event.content || "");
    } else if (event.type === "tool_call") {
      process.stderr.write(paint("cyan", `\n\ntool ${event.toolCall.name} ${summarizeArgs(event.toolCall.arguments)}\n`));
    } else if (event.type === "permission_decision") {
      process.stderr.write(paint("dim", `permission ${event.effect}: ${event.reason}\n`));
    } else if (event.type === "tool_result") {
      const status = event.result.ok ? paint("green", "ok") : paint("red", "fail");
      process.stderr.write(`result ${event.result.name}: ${status}\n`);
      if (!event.result.ok) process.stderr.write(paint("red", `${event.result.content}\n`));
    } else if (event.type === "diff_created") {
      const summary = (event.diffs || []).map((diff) => `${path.basename(diff.filePath)} +${diff.addedLines}/-${diff.removedLines}`).join(", ");
      process.stderr.write(paint("yellow", `diff ${summary}\n`));
    } else if (event.type === "approval_required") {
      pendingApprovals = event.approvals || [];
      state.conversationId = event.conversationId || state.conversationId;
    } else if (event.type === "completed") {
      state.conversationId = event.conversationId || state.conversationId;
    } else if (event.type === "error") {
      process.stderr.write(paint("red", `\nerror: ${event.message}\n`));
    }
  }

  for (const approval of pendingApprovals) {
    if (!rl) {
      process.stderr.write(paint("yellow", "\napproval required; rerun in chat mode to approve from the terminal.\n"));
      continue;
    }
    process.stderr.write(paint("yellow", `\napproval required: ${approval.reason}\n`));
    process.stderr.write(`${summarizeArgs(approval.toolCall.arguments)}\n`);
    const answer = (await rl.question("Allow this tool call? [y/N] ")).trim().toLowerCase();
    const allow = answer === "y" || answer === "yes";
    await streamAgent("/api/agent/approve", {
      approvalId: approval.id,
      allow,
      mode: state.mode,
      model: state.model || undefined,
      thinkingMode: state.thinkingMode,
      projectPath: state.projectPath
    }, rl);
  }
}

async function runPrompt(prompt, rl) {
  await ensureServer();
  await streamAgent("/api/agent/run", {
    prompt,
    mode: state.mode,
    conversationId: state.conversationId,
    model: state.model || undefined,
    thinkingMode: state.thinkingMode,
    projectPath: state.projectPath
  }, rl);
  process.stdout.write("\n");
}

async function doctor() {
  const health = await ensureServer();
  const tools = await fetchJson("/api/tools");
  const mcp = await fetchJson("/api/mcp/servers");
  const ai = await fetchJson("/api/ai/providers").catch(() => ({ providers: [], activeProviderId: health.provider }));
  const hooks = await fetchJson(`/api/hooks/trust?projectPath=${encodeURIComponent(state.projectPath)}`).catch(() => ({ exists: false }));
  console.log(paint("bold", "Rcode CLI"));
  console.log(`Server: ${baseUrl}`);
  console.log(`Provider: ${health.provider} / ${health.model} (${health.providerConfigured ? "configured" : "missing key"})`);
  console.log(`AI interfaces: ${ai.providers.length} (active: ${ai.activeProviderId || health.provider})`);
  console.log(`Local API token: ${health.localApiProtected ? "required" : "not required"}`);
  console.log(`Executor: ${health.executor || "portable-guarded-execution"}`);
  console.log(`Mode: ${state.mode}`);
  console.log(`Project: ${state.projectPath}`);
  console.log(`Tools: ${tools.tools.length}`);
  console.log(`MCP servers: ${mcp.servers.length}`);
  console.log(`Project hooks: ${hooks.exists ? (hooks.trusted ? "trusted" : `untrusted (${hooks.hash})`) : "none"}`);
}

async function listTools() {
  await ensureServer();
  const data = await fetchJson("/api/tools");
  for (const tool of data.tools) {
    console.log(`${tool.name.padEnd(14)} ${tool.risk.padEnd(6)} ${tool.defaultApproval.padEnd(5)} ${tool.description}`);
  }
}

async function audit() {
  await ensureServer();
  const data = await fetchJson("/api/audit");
  for (const event of data.events.slice(0, 30)) {
    const ok = event.ok === false ? paint("red", "fail") : paint("green", "ok");
    console.log(`${event.createdAt} ${ok} ${event.toolName || "event"} ${event.permissionEffect || ""} ${event.outputSummary || event.permissionReason || ""}`);
  }
}

async function mcp(args) {
  await ensureServer();
  const action = args[0] || "list";
  if (action === "list") {
    const data = await fetchJson("/api/mcp/servers");
    if (data.servers.length === 0) {
      console.log("No MCP servers configured.");
      return;
    }
    for (const server of data.servers) {
      console.log(`${server.id}\t${server.enabled ? "on" : "off"}\t${server.transport}\t${server.name}\t${server.url || server.command || ""}`);
    }
    return;
  }
  if (action === "test") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console mcp test <id>");
    const data = await fetchJson(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: "POST" });
    console.log(`MCP ${id}: ${data.ok ? "ok" : "failed"} (${(data.tools || []).length} tools)`);
    return;
  }
  if (action === "tools") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console mcp tools <id>");
    const data = await fetchJson(`/api/mcp/servers/${encodeURIComponent(id)}/tools`);
    for (const tool of data.tools || []) {
      console.log(`${tool.name}\t${tool.description || ""}`);
    }
    return;
  }
  if (action === "add") {
    const name = args[1];
    const target = args.slice(2).join(" ");
    if (!name || !target) throw new Error("Usage: agent-console mcp add <name> <command-or-url>");
    const isHttp = /^https?:\/\//.test(target);
    const data = await fetchJson("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify({
        name,
        transport: isHttp ? "http" : "stdio",
        url: isHttp ? target : undefined,
        command: isHttp ? undefined : target,
        enabled: true,
        defaultApproval: "ask"
      })
    });
    console.log(`Added ${data.server.name} (${data.server.id})`);
    return;
  }
  if (action === "remove") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console mcp remove <id>");
    await fetchJson(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
    console.log(`Removed ${id}`);
    return;
  }
  throw new Error(`Unknown mcp action: ${action}`);
}

async function ai(args) {
  await ensureServer();
  const action = args[0] || "list";
  if (action === "list") {
    const data = await fetchJson("/api/ai/providers");
    if (!data.providers.length) {
      console.log("No AI providers configured.");
      return;
    }
    for (const provider of data.providers) {
      const active = provider.active ? "*" : " ";
      const configured = provider.configured ? "configured" : "missing-key";
      console.log(`${active} ${provider.id}\t${provider.source || "user"}\t${configured}\t${provider.defaultModel}\t${provider.baseUrl}`);
    }
    return;
  }
  if (action === "add") {
    const [id, baseUrlArg, modelArg, apiKeyArg] = args.slice(1);
    if (!id || !baseUrlArg || !modelArg) throw new Error("Usage: agent-console ai add <id> <baseUrl> <model> [apiKey]");
    const data = await fetchJson("/api/ai/providers", {
      method: "POST",
      body: JSON.stringify({
        id,
        displayName: id,
        baseUrl: baseUrlArg,
        defaultModel: modelArg,
        apiKey: apiKeyArg,
        enabled: true
      })
    });
    console.log(`Added AI provider ${data.provider?.id || id}`);
    return;
  }
  if (action === "activate") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console ai activate <id>");
    await fetchJson(`/api/ai/providers/${encodeURIComponent(id)}/activate`, { method: "POST" });
    console.log(`Activated AI provider ${id}`);
    return;
  }
  if (action === "test") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console ai test <id>");
    const data = await fetchJson(`/api/ai/providers/${encodeURIComponent(id)}/test`, { method: "POST" });
    console.log(`AI ${id}: ${data.ok ? "ok" : "failed"} (${data.modelCount || 0} models)${data.error ? ` ${data.error}` : ""}`);
    return;
  }
  if (action === "remove") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console ai remove <id>");
    await fetchJson(`/api/ai/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    console.log(`Removed AI provider ${id}`);
    return;
  }
  throw new Error(`Unknown ai action: ${action}`);
}

async function memory(args) {
  await ensureServer();
  const action = args[0] || "list";
  if (action === "list") {
    const data = await fetchJson(`/api/memory?projectPath=${encodeURIComponent(state.projectPath)}`);
    for (const item of data.memories || []) {
      console.log(`${item.id}\t${item.kind}\t${item.importance}\t${item.content}`);
    }
    return;
  }
  if (action === "add") {
    const content = args.join(" ").replace(/^add\s+/, "").trim();
    if (!content) throw new Error("Usage: agent-console memory add <content>");
    const data = await fetchJson("/api/memory", {
      method: "POST",
      body: JSON.stringify({ projectPath: state.projectPath, kind: "note", content, importance: 1 })
    });
    console.log(`Added memory ${data.id}`);
    return;
  }
  if (action === "remove") {
    const id = args[1];
    if (!id) throw new Error("Usage: agent-console memory remove <id>");
    await fetchJson(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
    console.log(`Removed memory ${id}`);
    return;
  }
  throw new Error(`Unknown memory action: ${action}`);
}

async function agents() {
  await ensureServer();
  const data = await fetchJson(`/api/agents?projectPath=${encodeURIComponent(state.projectPath)}`);
  if (!data.agents?.length) {
    console.log("No subagents discovered.");
    return;
  }
  for (const agent of data.agents) {
    console.log(`${agent.name}\t${agent.scope}\t${agent.description}`);
  }
}

function parseOptions(args) {
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode") state.mode = args[++i] || state.mode;
    else if (arg === "--model") state.model = args[++i] || state.model;
    else if (arg === "--thinking") state.thinkingMode = args[++i] || state.thinkingMode;
    else if (arg === "--project") state.projectPath = path.resolve(args[++i] || state.projectPath);
    else if (arg === "--url") baseUrl = args[++i] || baseUrl;
    else if (arg === "--token") token = args[++i] || token;
    else if (arg === "--no-start-server") state.autoStart = false;
    else rest.push(arg);
  }
  return rest;
}

function printHelp() {
  const binName = path.basename(process.argv[1] || "rcode");
  console.log(`Rcode CLI

Usage:
  ${binName} chat [--project <path>] [--mode <mode>] [--model <id>]
  ${binName} run "task" [--project <path>]
  ${binName} doctor
  ${binName} tools
  ${binName} audit
  ${binName} ai list
  ${binName} ai add <id> <baseUrl> <model> [apiKey]
  ${binName} ai activate <id>
  ${binName} ai test <id>
  ${binName} ai remove <id>
  ${binName} mcp list
  ${binName} mcp add <name> <command-or-url>
  ${binName} mcp test <id>
  ${binName} mcp tools <id>
  ${binName} mcp remove <id>
  ${binName} memory list
  ${binName} memory add <content>
  ${binName} memory remove <id>
  ${binName} agents
  ${binName} serve

Chat slash commands:
  /help              Show commands
  /exit              Quit
  /mode <mode>       default | plan | workspace_write | custom | full_access
  /model <id>        Set model
  /thinking <mode>   fast | balanced | deep
  /project <path>    Set project root
  /tools             List tools
  /audit             Show recent audit events
  /ai                List AI providers
  /mcp               List MCP servers
  /memory            List project memory
  /agents            List subagent definitions
  /doctor            Show health
`);
}

async function handleSlash(input, rl) {
  const [command, ...args] = input.slice(1).trim().split(/\s+/);
  if (!command || command === "help") {
    printHelp();
    return true;
  }
  if (command === "exit" || command === "quit") return false;
  if (command === "mode") {
    if (args[0]) state.mode = args[0];
    console.log(`mode=${state.mode}`);
    return true;
  }
  if (command === "model") {
    state.model = args.join(" ");
    console.log(`model=${state.model || "default"}`);
    return true;
  }
  if (command === "thinking") {
    if (args[0]) state.thinkingMode = args[0];
    console.log(`thinking=${state.thinkingMode}`);
    return true;
  }
  if (command === "project") {
    if (args[0]) state.projectPath = path.resolve(args.join(" "));
    console.log(`project=${state.projectPath}`);
    return true;
  }
  if (command === "tools") {
    await listTools();
    return true;
  }
  if (command === "audit") {
    await audit();
    return true;
  }
  if (command === "mcp") {
    await mcp(args.length ? args : ["list"]);
    return true;
  }
  if (command === "ai") {
    await ai(args.length ? args : ["list"]);
    return true;
  }
  if (command === "memory") {
    await memory(args.length ? args : ["list"]);
    return true;
  }
  if (command === "agents") {
    await agents();
    return true;
  }
  if (command === "doctor") {
    await doctor();
    return true;
  }
  if (command === "clear") {
    state.conversationId = undefined;
    console.log("conversation cleared");
    return true;
  }
  console.log(`Unknown command: /${command}`);
  return true;
}

async function chat() {
  await ensureServer();
  console.log(paint("bold", "Rcode Terminal"));
  console.log(paint("dim", `project=${state.projectPath} mode=${state.mode} thinking=${state.thinkingMode}`));
  console.log(paint("dim", "Type /help for commands, /exit to quit.\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const input = (await rl.question(paint("blue", "agent> "))).trim();
      if (!input) continue;
      if (input.startsWith("/")) {
        const keepGoing = await handleSlash(input, rl);
        if (!keepGoing) break;
        continue;
      }
      await runPrompt(input, rl);
    }
  } finally {
    rl.close();
  }
}

async function serve() {
  state.autoStart = true;
  await ensureServer();
  console.log(`Agent server is running at ${baseUrl}`);
  console.log("Press Ctrl+C to stop this CLI-managed server.");
  if (!managedServer) return;
  await new Promise((resolve) => managedServer.once("exit", resolve));
}

async function main() {
  const args = parseOptions(process.argv.slice(2));
  const [command = "chat", ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "chat") return chat();
  if (command === "run") return runPrompt(rest.join(" "), undefined);
  if (command === "doctor") return doctor();
  if (command === "tools") return listTools();
  if (command === "audit") return audit();
  if (command === "ai") return ai(rest);
  if (command === "mcp") return mcp(rest);
  if (command === "memory") return memory(rest);
  if (command === "agents") return agents();
  if (command === "serve") return serve();
  return runPrompt(args.join(" "), undefined);
}

process.on("exit", () => {
  if (managedServer && !managedServer.killed) managedServer.kill();
});

process.on("SIGINT", () => {
  if (managedServer && !managedServer.killed) managedServer.kill();
  process.exit(130);
});

main().catch((error) => {
  console.error(paint("red", error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
