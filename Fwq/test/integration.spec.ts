import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface JsonMessage {
  type?: string;
  [key: string]: unknown;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`http://example.com${path}`, init));
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json<Record<string, unknown>>();
}

async function connectTicket(url: string): Promise<WebSocket> {
  const fetchUrl = new URL(url);
  fetchUrl.protocol = fetchUrl.protocol === "wss:" ? "https:" : "http:";
  const response = await exports.default.fetch(new Request(fetchUrl, { headers: { Upgrade: "websocket" } }));
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing WebSocket");
  socket.accept();
  return socket;
}

function nextMessage(socket: WebSocket, type: string): Promise<JsonMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3_000);
    const onMessage = (event: MessageEvent) => {
      let value: unknown;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      if (typeof value !== "object" || value === null || Array.isArray(value) || (value as JsonMessage).type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(value as JsonMessage);
    };
    socket.addEventListener("message", onMessage);
  });
}

describe("Rcode remote server", () => {
  it("handles auth and relays a complete controller-agent task", async () => {
    const health = await call("/health");
    expect(health.status).toBe(200);
    expect(await responseJson(health)).toMatchObject({ status: "ok" });

    const register = await call("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "mobile@example.com",
        username: "mobile_user",
        displayName: "Mobile User",
        password: "StrongPass123"
      })
    });
    expect(register.status).toBe(201);
    const session = await responseJson(register);
    expect(typeof session.token).toBe("string");
    expect(typeof session.expiresAt).toBe("string");
    expect(typeof (session.user as Record<string, unknown>).createdAt).toBe("string");
    const token = String(session.token);
    const authorization = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const me = await call("/v1/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    const restoredSession = await responseJson(me);
    expect(restoredSession).toMatchObject({ user: { username: "mobile_user" } });
    expect(typeof restoredSession.expiresAt).toBe("string");

    const controllerTicketResponse = await call("/v1/remote/ticket", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ role: "controller" })
    });
    expect(controllerTicketResponse.status).toBe(200);
    const controllerTicket = await responseJson(controllerTicketResponse);
    const controller = await connectTicket(String(controllerTicket.url));
    const controllerReady = await nextMessage(controller, "remote.ready");
    expect(controllerReady.snapshot).toMatchObject({ devices: [], commands: [] });

    const snapshotPromise = nextMessage(controller, "remote.snapshot");
    const agentTicketResponse = await call("/v1/remote/ticket", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        role: "agent",
        device: { id: "mac-1", name: "MacBook Pro", platform: "darwin", ready: true, projectName: "Rcode" }
      })
    });
    const agentTicket = await responseJson(agentTicketResponse);
    const agent = await connectTicket(String(agentTicket.url));
    const agentReady = await nextMessage(agent, "remote.ready");
    expect(agentReady.snapshot).toBeDefined();
    const snapshot = await snapshotPromise;
    expect(snapshot.snapshot).toMatchObject({ devices: [{ id: "mac-1", online: true, ready: true }] });

    const acceptedPromise = nextMessage(controller, "command.accepted");
    const executePromise = nextMessage(agent, "command.execute");
    controller.send(JSON.stringify({
      type: "command.create",
      requestId: "request-1",
      deviceId: "mac-1",
      action: "agent.run",
      payload: { prompt: "检查构建", mode: "plan" }
    }));
    const accepted = await acceptedPromise;
    const execute = await executePromise;
    expect(accepted.command).toMatchObject({ requestId: "request-1", status: "queued" });
    expect(execute.payload).toMatchObject({ prompt: "检查构建", mode: "plan" });
    const commandId = String((execute.command as Record<string, unknown>).id);

    const runningPromise = nextMessage(controller, "command.updated");
    agent.send(JSON.stringify({ type: "command.updated", command: { id: commandId, status: "running" } }));
    expect(await runningPromise).toMatchObject({ command: { id: commandId, status: "running" } });

    const completedUpdatePromise = nextMessage(controller, "command.updated");
    const completedEventPromise = nextMessage(controller, "command.event");
    agent.send(JSON.stringify({ type: "command.event", commandId, event: { type: "completed", answer: "构建正常" } }));
    expect(await completedUpdatePromise).toMatchObject({ command: { id: commandId, status: "completed" } });
    expect(await completedEventPromise).toMatchObject({ commandId, event: { type: "completed", answer: "构建正常" } });

    agent.close(1000, "done");
    controller.close(1000, "done");
  });
});
