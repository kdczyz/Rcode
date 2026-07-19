import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { requestedWorkImageModel, shouldGenerateWorkImage } from "../src/work-ai";

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
  it("distinguishes direct image requests from image-related questions", () => {
    expect(shouldGenerateWorkImage("生成一个安静的湖边夜景")).toBe(true);
    expect(shouldGenerateWorkImage("帮我画一只戴围巾的猫")).toBe(true);
    expect(shouldGenerateWorkImage("Create a cinematic night scene image")).toBe(true);
    expect(shouldGenerateWorkImage("解释怎么通过 API 生成图片")).toBe(false);
    expect(shouldGenerateWorkImage("用 Mermaid 画一个系统架构图")).toBe(false);
  });

  it("resolves an explicitly requested image model alias", () => {
    const models = ["gpt-image-1", "gpt-image-2"];
    expect(requestedWorkImageModel("用 image2 生成一个日出的照片", models)).toEqual({ model: "gpt-image-2", reference: "gpt-image-2" });
    expect(requestedWorkImageModel("using gpt-image-1 create a photo", models)).toEqual({ model: "gpt-image-1", reference: "gpt-image-1" });
    expect(requestedWorkImageModel("用 image3 生成一张照片", models)).toEqual({ reference: "image3" });
  });

  it("encrypts per-user Work AI configuration and never returns the API key", async () => {
    const register = await call("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "work@example.com",
        username: "work_user",
        displayName: "Work User",
        password: "StrongPass123"
      })
    });
    expect(register.status).toBe(201);
    const session = await responseJson(register);
    const authorization = { authorization: `Bearer ${String(session.token)}`, "content-type": "application/json" };

    const empty = await call("/v1/work/ai-config", { headers: authorization });
    expect(await responseJson(empty)).toEqual({ configured: false, providers: [] });

    const discoveryUpstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [{ id: "work-model" }, { id: "gpt-image-test" }, { id: "work-model-mini" }, { id: "work-model" }]
    }), { headers: { "content-type": "application/json" } }));
    const discovered = await call("/v1/work/ai-discover", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ baseUrl: "https://api.example.com/v1", apiKey: "sk-sensitive-test-key" })
    });
    expect(discovered.status).toBe(200);
    const discoveredBody = await responseJson(discovered);
    expect(discoveredBody).toMatchObject({
      displayName: "example.com",
      baseUrl: "https://api.example.com/v1",
      chatCompletionsPath: "/chat/completions",
      model: "work-model",
      models: ["work-model", "work-model-mini"],
      defaultImageModel: "gpt-image-test",
      imageModels: ["gpt-image-test"]
    });
    expect(String(discoveryUpstream.mock.calls[0]?.[0])).toBe("https://api.example.com/v1/models");
    expect(JSON.stringify(discoveredBody)).not.toContain("sk-sensitive-test-key");
    discoveryUpstream.mockRestore();

    const saved = await call("/v1/work/ai-config", {
      method: "PUT",
      headers: authorization,
      body: JSON.stringify({
        providerId: "desktop-main",
        displayName: "电脑接口",
        baseUrl: "https://api.example.com/v1",
        chatCompletionsPath: "/chat/completions",
        imageGenerationPath: "/images/generations",
        model: "work-model",
        models: ["work-model", "work-model-mini"],
        defaultImageModel: "gpt-image-test",
        imageModels: ["gpt-image-test", "gpt-image-2"],
        apiKey: "sk-sensitive-test-key"
      })
    });
    expect(saved.status).toBe(200);
    const savedBody = await responseJson(saved);
    expect(savedBody).toMatchObject({
      configured: true,
      selectedProviderId: "desktop-main",
      displayName: "电脑接口",
      model: "work-model",
      models: ["work-model", "work-model-mini"],
      defaultImageModel: "gpt-image-test",
      imageModels: ["gpt-image-test", "gpt-image-2"],
      apiKeyPreview: "••••-key"
    });
    expect(savedBody.providers).toHaveLength(1);
    expect(JSON.stringify(savedBody)).not.toContain("sk-sensitive-test-key");

    const db = (env as unknown as { DB: D1Database }).DB;
    const stored = await db.prepare("SELECT api_key_ciphertext FROM work_ai_providers LIMIT 1").first<{ api_key_ciphertext: string }>();
    expect(stored?.api_key_ciphertext).toBeTruthy();
    expect(stored?.api_key_ciphertext).not.toContain("sk-sensitive-test-key");

    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response([
        'data: {"model":"work-model-mini","choices":[{"delta":{"content":"实时"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"回复"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        '',
        'data: [DONE]',
        ''
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }));
    const streamed = await call("/v1/work/chat", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        providerId: "desktop-main",
        model: "work-model-mini",
        thinkingMode: "deep",
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const streamText = await streamed.text();
    expect(streamText).toContain('"type":"delta","delta":"实时"');
    expect(streamText).toContain('"type":"delta","delta":"回复"');
    expect(streamText).toContain('"type":"done","model":"work-model-mini"');
    const upstreamRequest = upstream.mock.calls[0]?.[1];
    expect(String(upstreamRequest?.body)).toContain('"model":"work-model-mini"');
    expect(String(upstreamRequest?.body)).toContain('"stream":true');
    expect(String(upstreamRequest?.body)).toContain('"reasoning_effort":"high"');
    upstream.mockRestore();

    const encodedImage = btoa("generated-image-bytes");
    const imageUpstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: encodedImage, revised_prompt: "A test image" }]
    }), { headers: { "content-type": "application/json" } }));
    const generated = await call("/v1/work/images", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ providerId: "desktop-main", model: "gpt-image-test", prompt: "Draw a test image" })
    });
    expect(generated.status).toBe(200);
    expect(await responseJson(generated)).toMatchObject({
      providerId: "desktop-main",
      model: "gpt-image-test",
      images: [{ mimeType: "image/jpeg", dataUrl: `data:image/jpeg;base64,${encodedImage}`, revisedPrompt: "A test image" }]
    });
    expect(String(imageUpstream.mock.calls[0]?.[0])).toBe("https://api.example.com/v1/images/generations");
    expect(String(imageUpstream.mock.calls[0]?.[1]?.body)).toContain('"output_format":"jpeg"');
    imageUpstream.mockRestore();

    const automaticImageUpstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: encodedImage, revised_prompt: "A quiet lake at night" }]
    }), { headers: { "content-type": "application/json" } }));
    const automaticImage = await call("/v1/work/chat", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        providerId: "desktop-main",
        model: "work-model-mini",
        imageModel: "gpt-image-test",
        autoImage: true,
        stream: true,
        messages: [{ role: "user", content: "用 image2 生成一个安静的湖边夜景" }]
      })
    });
    expect(automaticImage.status).toBe(200);
    const automaticImageStream = await automaticImage.text();
    expect(automaticImageStream).toContain('"type":"image"');
    expect(automaticImageStream).toContain('"model":"gpt-image-2"');
    expect(automaticImageStream).toContain(`data:image/jpeg;base64,${encodedImage}`);
    expect(String(automaticImageUpstream.mock.calls[0]?.[0])).toBe("https://api.example.com/v1/images/generations");
    expect(String(automaticImageUpstream.mock.calls[0]?.[1]?.body)).toContain('"model":"gpt-image-2"');
    automaticImageUpstream.mockRestore();

    const removed = await call("/v1/work/ai-config", { method: "DELETE", headers: authorization });
    expect(await responseJson(removed)).toEqual({ configured: false, providers: [] });
    const chat = await call("/v1/work/chat", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
    });
    expect(chat.status).toBe(409);
    expect(await responseJson(chat)).toMatchObject({ code: "work_ai_not_configured" });
  });

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
