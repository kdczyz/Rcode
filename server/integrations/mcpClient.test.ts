import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { requestHttpMcp, setMcpRuntimeBearerToken, StdioMcpSession } from "./mcpClient";

test("stdio MCP session preserves initialization across requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcode-mcp-"));
  const serverPath = path.join(root, "mock-mcp.cjs");
  await writeFile(serverPath, `
    const readline = require("node:readline");
    let initialized = false;
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        initialized = true;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
      } else if (request.method === "tools/list") {
        const response = initialized
          ? { jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "click", inputSchema: { type: "object" } }] } }
          : { jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "not initialized" } };
        process.stdout.write(JSON.stringify(response) + "\\n");
      }
    });
  `, "utf8");

  const session = new StdioMcpSession(process.execPath, [serverPath], () => undefined);
  try {
    await session.initialize();
    const result = await session.request("tools/list") as { tools: Array<{ name: string }> };
    assert.equal(result.tools[0]?.name, "click");
  } finally {
    session.dispose();
  }
});

test("HTTP MCP uses the bound bearer token and preserves its initialized session", async () => {
  const seen: Array<{ authorization?: string; sessionId?: string; method?: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: string; method?: string };
      seen.push({
        authorization: request.headers.authorization,
        sessionId: typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined,
        method: message.method
      });
      if (message.method === "initialize") response.setHeader("mcp-session-id", "session-1");
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === "tools/list"
        ? { tools: [{ name: "repository_read", inputSchema: { type: "object" } }] }
        : { protocolVersion: "2024-11-05", capabilities: {} };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    setMcpRuntimeBearerToken("github-test", "oauth-test-token");
    const result = await requestHttpMcp(
      "github-test",
      `http://127.0.0.1:${address.port}/mcp`,
      "TEST_GITHUB_MCP_TOKEN",
      "tools/list"
    ) as { tools: Array<{ name: string }> };
    assert.equal(result.tools[0]?.name, "repository_read");
    assert.deepEqual(seen.map((item) => item.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert(seen.every((item) => item.authorization === "Bearer oauth-test-token"));
    assert.equal(seen[1]?.sessionId, "session-1");
    assert.equal(seen[2]?.sessionId, "session-1");
  } finally {
    server.close();
    setMcpRuntimeBearerToken("github-test");
  }
});
