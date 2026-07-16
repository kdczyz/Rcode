const baseUrl = process.env.BASE_URL || "https://rcode-remote-server.kdczyz0728-994.workers.dev";
const smokeId = process.env.SMOKE_ID;

if (!smokeId || !/^smoke_[0-9]+$/.test(smokeId)) {
  throw new Error("Set SMOKE_ID to a value such as smoke_123456");
}

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    }, { once: true });
  });
}

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 10_000);
    const handler = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", handler);
      resolve(message);
    };
    socket.addEventListener("message", handler);
  });
}

const session = await api("/v1/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: `${smokeId}@example.com`,
    username: smokeId,
    displayName: "Deployment Smoke Test",
    password: "SmokePass123"
  })
});
const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };

const controllerTicket = await api("/v1/remote/ticket", {
  method: "POST",
  headers,
  body: JSON.stringify({ role: "controller" })
});
const controller = await openSocket(controllerTicket.url);
await nextMessage(controller, "remote.ready");

const snapshotPromise = nextMessage(controller, "remote.snapshot");
const agentTicket = await api("/v1/remote/ticket", {
  method: "POST",
  headers,
  body: JSON.stringify({
    role: "agent",
    device: { id: "smoke-device", name: "Smoke Device", platform: "test", ready: true }
  })
});
const agent = await openSocket(agentTicket.url);
await nextMessage(agent, "remote.ready");
await snapshotPromise;

const acceptedPromise = nextMessage(controller, "command.accepted");
const executePromise = nextMessage(agent, "command.execute");
controller.send(JSON.stringify({
  type: "command.create",
  requestId: `request-${smokeId}`,
  deviceId: "smoke-device",
  action: "agent.run",
  payload: { prompt: "deployment smoke test", mode: "plan" }
}));
await acceptedPromise;
const execute = await executePromise;
const commandId = execute.command.id;

const completedUpdate = nextMessage(controller, "command.updated");
const completedEvent = nextMessage(controller, "command.event");
agent.send(JSON.stringify({
  type: "command.event",
  commandId,
  event: { type: "completed", answer: "ok" }
}));
await completedUpdate;
await completedEvent;

await api("/v1/auth/logout", { method: "POST", headers });
agent.close(1000, "done");
controller.close(1000, "done");
console.log(JSON.stringify({ status: "ok", user: smokeId, commandId }));
