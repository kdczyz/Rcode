import { AuthenticatedUser, authenticate } from "./auth";
import { corsHeaders, HttpError, isObject, json, readJsonObject, requiredString } from "./http";

type WorkEnv = Env & { AI_CONFIG_SECRET?: string };
const MAX_UPSTREAM_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_JSON_BYTES = 14 * 1024 * 1024;
const MAX_STREAM_TEXT_LENGTH = 32_000;

interface WorkAiProviderRow {
  user_id: string;
  provider_id: string;
  display_name: string;
  base_url: string;
  chat_completions_path: string;
  image_generation_path: string;
  model: string;
  models_json: string;
  default_image_model: string | null;
  image_models_json: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_preview: string;
  created_at: number;
  updated_at: number;
}

interface WorkMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

type ThinkingMode = "fast" | "balanced" | "deep";

function thinkingMode(value: unknown): ThinkingMode {
  return value === "fast" || value === "deep" || value === "balanced" ? value : "balanced";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(env: WorkEnv): Promise<CryptoKey> {
  const secret = env.AI_CONFIG_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, "服务器尚未配置 AI 加密密钥", "ai_secret_unavailable");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptApiKey(value: string, env: WorkEnv): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(value));
  return { ciphertext: bytesToBase64Url(new Uint8Array(encrypted)), iv: bytesToBase64Url(iv) };
}

async function decryptApiKey(row: WorkAiProviderRow, env: WorkEnv): Promise<string> {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(row.api_key_iv) },
      await encryptionKey(env),
      base64UrlToBytes(row.api_key_ciphertext)
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new HttpError(503, "AI 配置无法解密，请重新保存 API Key", "ai_config_decrypt_failed");
  }
}

function normalizedBaseUrl(value: unknown): string {
  const raw = requiredString(value, "Base URL", { max: 500 });
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "Base URL 格式不正确", "invalid_ai_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "Base URL 必须是安全的 HTTPS 地址", "invalid_ai_url");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local")) {
    throw new HttpError(400, "Base URL 不能指向本机地址", "invalid_ai_url");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizedPath(value: unknown): string {
  const path = value === undefined ? "/chat/completions" : requiredString(value, "Chat Completions 路径", { max: 200 });
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
    throw new HttpError(400, "Chat Completions 路径格式不正确", "invalid_ai_path");
  }
  return path;
}

function normalizedImagePath(value: unknown): string {
  const path = value === undefined ? "/images/generations" : requiredString(value, "图片生成路径", { max: 200 });
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
    throw new HttpError(400, "图片生成路径格式不正确", "invalid_ai_image_path");
  }
  return path;
}

function normalizedProviderId(value: unknown): string {
  return requiredString(value ?? "default", "接口 ID", { max: 100, pattern: /^[a-zA-Z0-9._:-]+$/ });
}

function normalizedModelList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 160)
    .slice(0, 80))];
}

function normalizedModels(value: unknown, defaultModel: string): string[] {
  return [...new Set([defaultModel, ...normalizedModelList(value)])];
}

function discoveredModels(value: Record<string, unknown> | undefined): string[] {
  const source = Array.isArray(value?.data) ? value.data : Array.isArray(value?.models) ? value.models : [];
  return [...new Set(source.flatMap((item) => {
    if (typeof item === "string") return [item.trim()];
    if (isObject(item) && typeof item.id === "string") return [item.id.trim()];
    if (isObject(item) && typeof item.name === "string") return [item.name.trim()];
    return [];
  }).filter((model) => model.length > 0 && model.length <= 160))].slice(0, 80);
}

const imageModelPattern = /(?:^|[-_.\/])(gpt-image|dall-e|image|imagen|flux|sdxl|stable-diffusion|recraft|seedream)(?:$|[-_.\/\d])/i;

export function inferWorkImageModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model && imageModelPattern.test(model)))];
}

function compactModelReference(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelAliases(model: string): string[] {
  const tail = model.split(/[\/:]/).pop() || model;
  const compact = compactModelReference(model);
  const compactTail = compactModelReference(tail);
  const shortTail = compactTail.replace(/^(?:openai|gpt)/, "");
  return [...new Set([compact, compactTail, shortTail].filter((alias) => alias.length >= 4))];
}

function looksLikeImageModel(reference: string): boolean {
  const compact = compactModelReference(reference);
  return /^(?:gpt)?image|dalle|imagen|flux|sdxl|stablediffusion|recraft|seedream|midjourney/.test(compact)
    || (/[a-z]/.test(compact) && /\d/.test(compact));
}

function isDirectImageRequest(prompt: string): boolean {
  return /(?:生图|(?:用|使用|通过).{0,48}(?:生成|画|绘制|创作|渲染|制作|出图))|(?:using|with).{0,48}(?:generate|create|draw|paint|render)/i.test(prompt);
}

export function requestedWorkImageModel(prompt: string, models: string[]): { model?: string; reference?: string } {
  const references = prompt.normalize("NFKC").match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  const compactReferences = new Set(references.map(compactModelReference));
  for (const model of models) {
    if (modelAliases(model).some((alias) => compactReferences.has(alias))) return { model, reference: model };
  }

  const explicit = prompt.match(/(?:用|使用|通过|using|with)\s*[“”"'`]?([A-Za-z0-9][A-Za-z0-9._:/-]*)/i)?.[1];
  return explicit && looksLikeImageModel(explicit) && isDirectImageRequest(prompt) ? { reference: explicit } : {};
}

function providerIdFor(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 52) || "provider";
  return `${host}-${crypto.randomUUID().slice(0, 8)}`;
}

function modelDiscoveryEndpoints(baseUrl: string): string[] {
  const direct = `${baseUrl}/models`;
  if (/\/v\d+$/i.test(new URL(baseUrl).pathname)) return [direct];
  return [direct, `${baseUrl}/v1/models`];
}

function rowModels(row: WorkAiProviderRow): string[] {
  try {
    return normalizedModels(JSON.parse(row.models_json), row.model);
  } catch {
    return [row.model];
  }
}

function rowImageModels(row: WorkAiProviderRow): string[] {
  let configured: string[] = [];
  try {
    configured = row.default_image_model
      ? normalizedModels(JSON.parse(row.image_models_json), row.default_image_model)
      : [];
  } catch { configured = row.default_image_model ? [row.default_image_model] : []; }
  return [...new Set([...configured, ...inferWorkImageModels(rowModels(row))])];
}

function publicProvider(row: WorkAiProviderRow) {
  const imageModels = rowImageModels(row);
  const models = rowModels(row).filter((model) => !imageModels.includes(model));
  return {
    id: row.provider_id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    chatCompletionsPath: row.chat_completions_path,
    imageGenerationPath: row.image_generation_path,
    model: models.includes(row.model) ? row.model : models[0] || row.model,
    models,
    defaultImageModel: row.default_image_model ?? imageModels[0],
    imageModels,
    apiKeyPreview: row.api_key_preview,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function publicConfig(rows: WorkAiProviderRow[], selectedProviderId?: string) {
  if (rows.length === 0) return { configured: false, providers: [] };
  const selected = rows.find((row) => row.provider_id === selectedProviderId) ?? rows[0]!;
  return {
    configured: true,
    selectedProviderId: selected.provider_id,
    ...publicProvider(selected),
    providers: rows.map(publicProvider)
  };
}

async function providersForUser(db: D1Database, userId: string): Promise<WorkAiProviderRow[]> {
  const result = await db.prepare(`
    SELECT user_id, provider_id, display_name, base_url, chat_completions_path, image_generation_path, model,
           models_json, default_image_model, image_models_json, api_key_ciphertext, api_key_iv, api_key_preview, created_at, updated_at
      FROM work_ai_providers WHERE user_id = ? ORDER BY updated_at DESC
  `).bind(userId).all<WorkAiProviderRow>();
  return result.results;
}

async function providerForUser(db: D1Database, userId: string, providerId?: string): Promise<WorkAiProviderRow | null> {
  if (providerId) {
    return db.prepare(`
      SELECT user_id, provider_id, display_name, base_url, chat_completions_path, image_generation_path, model,
             models_json, default_image_model, image_models_json, api_key_ciphertext, api_key_iv, api_key_preview, created_at, updated_at
        FROM work_ai_providers WHERE user_id = ? AND provider_id = ?
    `).bind(userId, providerId).first<WorkAiProviderRow>();
  }
  return db.prepare(`
    SELECT user_id, provider_id, display_name, base_url, chat_completions_path, image_generation_path, model,
           models_json, default_image_model, image_models_json, api_key_ciphertext, api_key_iv, api_key_preview, created_at, updated_at
      FROM work_ai_providers WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1
  `).bind(userId).first<WorkAiProviderRow>();
}

async function authenticated(request: Request, env: WorkEnv): Promise<AuthenticatedUser> {
  return authenticate(request, env.DB);
}

export async function getWorkAiConfig(request: Request, env: WorkEnv): Promise<Response> {
  const auth = await authenticated(request, env);
  const selectedProviderId = new URL(request.url).searchParams.get("providerId") || undefined;
  return json(publicConfig(await providersForUser(env.DB, auth.user.id), selectedProviderId));
}

export async function discoverWorkAiModels(request: Request, env: WorkEnv): Promise<Response> {
  await authenticated(request, env);
  const body = await readJsonObject(request);
  const baseUrl = normalizedBaseUrl(body.baseUrl);
  const apiKey = requiredString(body.apiKey, "API Key", { min: 8, max: 512 });
  let lastStatus = 502;
  let lastError = "无法从上游获取模型列表";

  for (const endpoint of modelDiscoveryEndpoints(baseUrl)) {
    let upstream: Response;
    try {
      upstream = await fetch(endpoint, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      lastError = error instanceof Error && error.name === "TimeoutError" ? "上游模型列表请求超时" : "无法连接上游模型服务";
      continue;
    }
    lastStatus = upstream.status;
    const result = await readUpstreamJson(upstream);
    if (!upstream.ok) {
      lastError = upstreamError(result, upstream.status);
      continue;
    }
    const models = discoveredModels(result);
    if (models.length === 0) {
      lastError = "上游未返回可用模型";
      continue;
    }
    const imageModels = inferWorkImageModels(models);
    const textModels = models.filter((model) => !imageModels.includes(model));
    if (textModels.length === 0) {
      lastError = "上游未返回可用聊天模型";
      continue;
    }
    const hostname = new URL(baseUrl).hostname;
    return json({
      providerId: providerIdFor(baseUrl),
      displayName: hostname.replace(/^api\./, ""),
      baseUrl,
      chatCompletionsPath: "/chat/completions",
      model: textModels[0],
      models: textModels,
      defaultImageModel: imageModels[0],
      imageModels
    });
  }

  throw new HttpError(502, lastError.slice(0, 500), lastStatus === 401 || lastStatus === 403 ? "ai_key_rejected" : "ai_models_unavailable");
}

export async function saveWorkAiConfig(request: Request, env: WorkEnv): Promise<Response> {
  const auth = await authenticated(request, env);
  const body = await readJsonObject(request);
  const providerId = normalizedProviderId(body.providerId);
  const baseUrl = normalizedBaseUrl(body.baseUrl);
  const chatCompletionsPath = normalizedPath(body.chatCompletionsPath);
  const imageGenerationPath = normalizedImagePath(body.imageGenerationPath);
  const requestedModel = requiredString(body.model, "模型", { max: 160 });
  const displayName = typeof body.displayName === "string" && body.displayName.trim()
    ? requiredString(body.displayName, "接口名称", { max: 120 })
    : new URL(baseUrl).hostname;
  const discovered = normalizedModels(body.models, requestedModel);
  const configuredDefaultImageModel = typeof body.defaultImageModel === "string" && body.defaultImageModel.trim()
    ? requiredString(body.defaultImageModel, "图片模型", { max: 160 })
    : undefined;
  const configuredImageModels = normalizedModelList(body.imageModels);
  const imageModels = [...new Set([configuredDefaultImageModel, ...configuredImageModels, ...inferWorkImageModels(discovered)].filter((candidate): candidate is string => Boolean(candidate)))];
  const models = discovered.filter((candidate) => !imageModels.includes(candidate));
  const model = models.includes(requestedModel) ? requestedModel : models[0];
  if (!model) throw new HttpError(400, "当前接口没有可用聊天模型", "chat_model_not_configured");
  const defaultImageModel = configuredDefaultImageModel || imageModels[0];
  const current = await providerForUser(env.DB, auth.user.id, providerId);
  const suppliedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!current && suppliedKey.length < 8) throw new HttpError(400, "首次配置必须填写 API Key", "api_key_required");
  if (suppliedKey.length > 512) throw new HttpError(400, "API Key 格式不正确", "invalid_api_key");
  const encrypted = suppliedKey ? await encryptApiKey(suppliedKey, env) : undefined;
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO work_ai_providers (
      user_id, provider_id, display_name, base_url, chat_completions_path, image_generation_path, model,
      models_json, default_image_model, image_models_json, api_key_ciphertext, api_key_iv, api_key_preview, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider_id) DO UPDATE SET
      display_name = excluded.display_name,
      base_url = excluded.base_url,
      chat_completions_path = excluded.chat_completions_path,
      image_generation_path = excluded.image_generation_path,
      model = excluded.model,
      models_json = excluded.models_json,
      default_image_model = excluded.default_image_model,
      image_models_json = excluded.image_models_json,
      api_key_ciphertext = excluded.api_key_ciphertext,
      api_key_iv = excluded.api_key_iv,
      api_key_preview = excluded.api_key_preview,
      updated_at = excluded.updated_at
  `).bind(
    auth.user.id,
    providerId,
    displayName,
    baseUrl,
    chatCompletionsPath,
    imageGenerationPath,
    model,
    JSON.stringify(models),
    defaultImageModel ?? null,
    JSON.stringify(imageModels),
    encrypted?.ciphertext ?? current?.api_key_ciphertext,
    encrypted?.iv ?? current?.api_key_iv,
    suppliedKey ? `••••${suppliedKey.slice(-4)}` : current?.api_key_preview,
    current?.created_at ?? now,
    now
  ).run();
  return json(publicConfig(await providersForUser(env.DB, auth.user.id), providerId));
}

export async function deleteWorkAiConfig(request: Request, env: WorkEnv): Promise<Response> {
  const auth = await authenticated(request, env);
  const rawProviderId = new URL(request.url).searchParams.get("providerId");
  if (rawProviderId) {
    const providerId = normalizedProviderId(rawProviderId);
    await env.DB.prepare("DELETE FROM work_ai_providers WHERE user_id = ? AND provider_id = ?").bind(auth.user.id, providerId).run();
  } else {
    await env.DB.prepare("DELETE FROM work_ai_providers WHERE user_id = ?").bind(auth.user.id).run();
    await env.DB.prepare("DELETE FROM work_ai_configs WHERE user_id = ?").bind(auth.user.id).run();
  }
  return json(publicConfig(await providersForUser(env.DB, auth.user.id)));
}

function parseMessages(value: unknown): WorkMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new HttpError(400, "聊天消息数量不正确", "invalid_messages");
  }
  let total = 0;
  return value.map((raw) => {
    if (!isObject(raw)) throw new HttpError(400, "聊天消息格式不正确", "invalid_messages");
    const role = raw.role === "system" || raw.role === "assistant" || raw.role === "user" ? raw.role : undefined;
    const content = requiredString(raw.content, "消息内容", { max: 12_000 });
    if (!role) throw new HttpError(400, "聊天消息角色不正确", "invalid_messages");
    total += content.length;
    if (total > 48_000) throw new HttpError(413, "聊天上下文过长", "context_too_large");
    return { role, content };
  });
}

export function shouldGenerateWorkImage(content: string): boolean {
  const prompt = content.trim();
  if (!prompt) return false;
  if (/(?:流程图|架构图|时序图|图表|曲线图|统计图|mermaid|flowchart|sequence diagram)/i.test(prompt)) return false;

  const visualNoun = /(?:图片|图像|插画|海报|壁纸|头像|照片|画面|场景|夜景|风景|概念图|效果图|宣传图|封面|logo|标志|image|picture|photo|illustration|poster|wallpaper|portrait|scene|landscape|artwork|logo)/i;
  const directChineseDrawing = /(?:生图|来一张|出一张)|(?:^|[，。！？\s])(?:请|帮我|给我|为我|替我|直接|现在|马上)?\s*(?:画|绘制)(?!法)[^，。！？\n]{1,40}/i;
  const directChineseVisual = /(?:生成|创作|渲染|制作|设计|创建|做)(?:一|1|几|多)?(?:张|幅|个|套)?[^，。！？\n]{0,16}(?:图片|图像|插画|海报|壁纸|头像|照片|画面|场景|夜景|风景|概念图|效果图|宣传图|封面|logo|标志)/i;
  const directEnglish = /\b(?:generate|create|draw|paint|render|design|make)\b[^.!?\n]{0,28}\b(?:image|picture|photo|illustration|poster|wallpaper|portrait|scene|landscape|artwork|logo)\b/i;
  const isDirectRequest = directEnglish.test(prompt) || directChineseDrawing.test(prompt) || (directChineseVisual.test(prompt) && visualNoun.test(prompt));
  if (!isDirectRequest) return false;

  const asksAboutGeneration = /(?:怎么|如何|为什么|教程|文档|代码|接口|api|模型|功能|按钮|报错|错误|解释|分析|介绍|原理|配置|调用).{0,18}(?:生图|生成|画|绘制)|(?:生图|生成图片|生成图像|绘制图片).{0,18}(?:怎么|如何|教程|代码|接口|api|模型|原理)|\b(?:how|why|tutorial|documentation|code|api|model|explain|configure)\b[^.!?\n]{0,36}\b(?:generate|create|draw|image generation)\b/i;
  const imperative = /^(?:请|帮我|给我|为我|替我|直接|现在|马上)?\s*(?:生成|画|绘制|创作|渲染|制作|设计|创建|做|生图|来一张|出一张)|^(?:please\s+)?(?:generate|create|draw|paint|render|design|make)\b/i;
  return !asksAboutGeneration.test(prompt) || imperative.test(prompt);
}

function assistantContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (isObject(item) && typeof item.text === "string") return [item.text];
    return [];
  }).join("\n");
  return text || undefined;
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  return {
    promptTokens: Number(value.prompt_tokens) || 0,
    completionTokens: Number(value.completion_tokens) || 0,
    totalTokens: Number(value.total_tokens) || 0
  };
}

async function readUpstreamJson(response: Response, maxBytes = MAX_UPSTREAM_JSON_BYTES): Promise<Record<string, unknown> | undefined> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > maxBytes) throw new HttpError(502, "AI 服务返回内容过大", "ai_response_too_large");
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new HttpError(502, "AI 服务返回内容过大", "ai_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function upstreamError(result: Record<string, unknown> | undefined, status: number): string {
  const nested = isObject(result?.error) ? result.error : undefined;
  return (typeof nested?.message === "string" ? nested.message
    : typeof result?.error === "string" ? result.error
      : `AI 请求失败 (${status})`).slice(0, 500);
}

function completionFromJson(result: Record<string, unknown> | undefined, fallbackModel: string) {
  const choices = Array.isArray(result?.choices) ? result.choices : [];
  const first = isObject(choices[0]) ? choices[0] : undefined;
  const message = isObject(first?.message) ? first.message : undefined;
  const content = assistantContent(message?.content);
  if (!content) throw new HttpError(502, "AI 服务未返回文本内容", "invalid_ai_response");
  return {
    content: content.slice(0, MAX_STREAM_TEXT_LENGTH),
    model: typeof result?.model === "string" ? result.model : fallbackModel,
    usage: tokenUsage(result?.usage)
  };
}

function reasoningControls(baseUrl: string, model: string, mode: ThinkingMode): Record<string, unknown> {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  const modelId = model.toLowerCase().split("/").pop() ?? model.toLowerCase();
  const fast = mode === "fast";
  const effort = mode === "deep" ? "high" : mode === "balanced" ? "medium" : "low";
  if (hostname.endsWith("xiaomimimo.com") || /^mimo[-_.]/.test(modelId)) {
    return { thinking: { type: fast ? "disabled" : "enabled" } };
  }
  if (hostname.endsWith("deepseek.com") || /^deepseek[-_.]/.test(modelId)) {
    return fast
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: mode === "deep" ? "max" : "high" };
  }
  if (hostname.endsWith("moonshot.cn") || hostname.endsWith("moonshot.ai") || /^(?:kimi|moonshot)[-_.]/.test(modelId)) {
    return { thinking: { type: fast ? "disabled" : "enabled" } };
  }
  return { reasoning_effort: effort };
}

function mayRejectReasoning(status: number, result: Record<string, unknown> | undefined): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /reasoning|thinking|effort|unknown|unsupported|extra field/i.test(JSON.stringify(result ?? {}));
}

function streamHeaders(): Headers {
  const headers = corsHeaders();
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-store");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  return headers;
}

function encodeEvent(encoder: TextEncoder, event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function completedStream(completion: { content: string; model: string; usage?: TokenUsage }): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeEvent(encoder, { type: "delta", delta: completion.content }));
      controller.enqueue(encodeEvent(encoder, { type: "done", model: completion.model, usage: completion.usage }));
      controller.close();
    }
  }), { headers: streamHeaders() });
}

function completedImageStream(result: { providerId: string; model: string; images: ReturnType<typeof generatedImages> }): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeEvent(encoder, { type: "image", model: result.model, images: result.images }));
      controller.enqueue(encodeEvent(encoder, { type: "done", model: result.model }));
      controller.close();
    }
  }), { headers: streamHeaders() });
}

function relayCompletionStream(upstream: Response, fallbackModel: string): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!upstream.body) {
        controller.enqueue(encodeEvent(encoder, { type: "error", error: "AI 服务未返回响应内容" }));
        controller.close();
        return;
      }
      const reader = upstream.body.getReader();
      let buffer = "";
      let totalLength = 0;
      let model = fallbackModel;
      let usage: TokenUsage | undefined;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        controller.enqueue(encodeEvent(encoder, { type: "done", model, usage }));
      };

      const processLine = (source: string) => {
        const line = source.trim();
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload) return;
        if (payload === "[DONE]") {
          finish();
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(payload); } catch { return; }
        if (!isObject(parsed)) return;
        if (isObject(parsed.error)) {
          controller.enqueue(encodeEvent(encoder, { type: "error", error: String(parsed.error.message || "AI 流式响应失败").slice(0, 500) }));
          finished = true;
          return;
        }
        if (typeof parsed.model === "string") model = parsed.model;
        usage = tokenUsage(parsed.usage) ?? usage;
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const first = isObject(choices[0]) ? choices[0] : undefined;
        const delta = isObject(first?.delta) ? assistantContent(first.delta.content) : undefined;
        const finalMessage = isObject(first?.message) ? assistantContent(first.message.content) : undefined;
        const text = delta ?? finalMessage;
        if (!text || finished) return;
        totalLength += text.length;
        if (totalLength > MAX_STREAM_TEXT_LENGTH) {
          controller.enqueue(encodeEvent(encoder, { type: "error", error: "AI 回复内容过长" }));
          finished = true;
          return;
        }
        controller.enqueue(encodeEvent(encoder, { type: "delta", delta: text }));
      };

      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        }
        buffer += decoder.decode();
        if (buffer) processLine(buffer);
        if (!finished) finish();
      } catch (error) {
        controller.enqueue(encodeEvent(encoder, { type: "error", error: error instanceof Error ? error.message : "AI 流式响应中断" }));
      } finally {
        controller.close();
        // Some OpenAI-compatible providers keep their upstream SSE socket open
        // briefly after `[DONE]`. Do not make the client wait for that socket's
        // cancellation handshake before closing our sanitized downstream stream.
        void reader.cancel().catch(() => undefined);
      }
    },
    async cancel() {
      await upstream.body?.cancel().catch(() => undefined);
    }
  }), { headers: streamHeaders() });
}

export async function workChat(request: Request, env: WorkEnv): Promise<Response> {
  const auth = await authenticated(request, env);
  const body = await readJsonObject(request);
  const messages = parseMessages(body.messages);
  const providerId = typeof body.providerId === "string" && body.providerId.trim() ? normalizedProviderId(body.providerId) : undefined;
  const config = await providerForUser(env.DB, auth.user.id, providerId);
  if (!config) throw new HttpError(409, providerId ? "所选 AI 接口不存在" : "请先在设置中配置聊天 AI 接口", "work_ai_not_configured");
  const selectedModel = typeof body.model === "string" && body.model.trim()
    ? requiredString(body.model, "模型", { max: 160 })
    : config.model;
  const wantsStream = body.stream === true;
  const selectedThinkingMode = thinkingMode(body.thinkingMode);
  const apiKey = await decryptApiKey(config, env);
  const latestUserPrompt = [...messages].reverse().find((message) => message.role === "user")?.content || "";
  if (body.autoImage === true && shouldGenerateWorkImage(latestUserPrompt)) {
    const requestedImage = requestedWorkImageModel(latestUserPrompt, rowImageModels(config));
    if (requestedImage.reference && !requestedImage.model) {
      throw new HttpError(400, `图片模型“${requestedImage.reference}”未在当前接口配置`, "invalid_image_model_reference");
    }
    const result = await generateImagesForProvider(config, apiKey, {
      prompt: latestUserPrompt,
      model: requestedImage.model || (typeof body.imageModel === "string" ? body.imageModel : undefined)
    });
    if (wantsStream) return completedImageStream(result);
    return json({ content: result.images[0]?.revisedPrompt || "图片已生成", ...result });
  }
  const endpoint = `${config.base_url}${config.chat_completions_path}`;
  const basePayload = { model: selectedModel, messages, stream: wantsStream, ...(wantsStream ? { stream_options: { include_usage: true } } : {}) };
  const controls = reasoningControls(config.base_url, selectedModel, selectedThinkingMode);
  const fetchUpstream = (payload: Record<string, unknown>) => fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: wantsStream ? "text/event-stream" : "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(wantsStream ? 120_000 : 60_000)
  });
  let upstream: Response;
  try {
    upstream = await fetchUpstream({ ...basePayload, ...controls });
  } catch (error) {
    throw new HttpError(502, error instanceof Error && error.name === "TimeoutError" ? "AI 响应超时" : "无法连接 AI 服务", "ai_upstream_unavailable");
  }

  if (!upstream.ok) {
    const result = await readUpstreamJson(upstream);
    if (mayRejectReasoning(upstream.status, result)) {
      try {
        upstream = await fetchUpstream(basePayload);
      } catch (error) {
        throw new HttpError(502, error instanceof Error && error.name === "TimeoutError" ? "AI 响应超时" : "无法连接 AI 服务", "ai_upstream_unavailable");
      }
      if (!upstream.ok) {
        const retryResult = await readUpstreamJson(upstream);
        throw new HttpError(502, upstreamError(retryResult, upstream.status), "ai_upstream_error");
      }
    } else {
      throw new HttpError(502, upstreamError(result, upstream.status), "ai_upstream_error");
    }
  }

  if (wantsStream) {
    const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      return completedStream(completionFromJson(await readUpstreamJson(upstream), selectedModel));
    }
    return relayCompletionStream(upstream, selectedModel);
  }

  return json(completionFromJson(await readUpstreamJson(upstream), selectedModel));
}

const IMAGE_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "2160x3840", "3840x2160"]);
const IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);

function generatedImages(value: Record<string, unknown> | undefined, format: "jpeg" | "png") {
  const source = Array.isArray(value?.data) ? value.data : Array.isArray(value?.images) ? value.images : [];
  return source.slice(0, 4).flatMap((raw, index) => {
    if (!isObject(raw)) return [];
    const encoded = typeof raw.b64_json === "string" ? raw.b64_json : typeof raw.base64 === "string" ? raw.base64 : undefined;
    const url = typeof raw.url === "string" && raw.url.startsWith("https://") ? raw.url : undefined;
    if (!encoded && !url) return [];
    if (encoded && Math.floor(encoded.length * 0.75) > 10 * 1024 * 1024) throw new HttpError(502, "图片服务返回的单张图片超过 10 MB 限制", "image_too_large");
    const mimeType = typeof raw.mime_type === "string" && raw.mime_type.startsWith("image/")
      ? raw.mime_type
      : format === "jpeg" ? "image/jpeg" : "image/png";
    return [{
      id: `generated-${crypto.randomUUID()}`,
      name: `generated-image-${index + 1}.${mimeType.split("/")[1] || "jpg"}`,
      mimeType,
      dataUrl: encoded ? `data:${mimeType};base64,${encoded}` : undefined,
      url,
      revisedPrompt: typeof raw.revised_prompt === "string" ? raw.revised_prompt.slice(0, 4_000) : undefined
    }];
  });
}

async function generateImagesForProvider(
  config: WorkAiProviderRow,
  apiKey: string,
  input: { prompt?: unknown; model?: unknown; size?: unknown; quality?: unknown }
) {
  const allowedModels = rowImageModels(config);
  if (allowedModels.length === 0) throw new HttpError(409, "当前接口尚未配置图片模型", "image_model_not_configured");
  const model = typeof input.model === "string" && input.model.trim()
    ? requiredString(input.model, "图片模型", { max: 160 })
    : config.default_image_model || allowedModels[0]!;
  if (!allowedModels.includes(model)) throw new HttpError(400, "所选图片模型不在接口允许列表中", "invalid_image_model");
  const prompt = requiredString(input.prompt, "生图提示词", { max: 8_000 });
  const size = typeof input.size === "string" && IMAGE_SIZES.has(input.size) ? input.size : "auto";
  const quality = typeof input.quality === "string" && IMAGE_QUALITIES.has(input.quality) ? input.quality : "auto";
  const count = 1;
  const endpoint = `${config.base_url}${config.image_generation_path || "/images/generations"}`;
  const basePayload = { model, prompt, n: count, size, quality };
  const payloads = [{ ...basePayload, output_format: "jpeg", output_compression: 85 }, basePayload];
  let lastError = "图片生成失败";

  for (const payload of payloads) {
    let upstream: Response;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000)
      });
    } catch (error) {
      throw new HttpError(502, error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "图片生成超时" : "无法连接图片生成服务", "image_upstream_unavailable");
    }
    const result = await readUpstreamJson(upstream, MAX_IMAGE_JSON_BYTES);
    if (!upstream.ok) {
      lastError = upstreamError(result, upstream.status);
      if (upstream.status === 400 || upstream.status === 404 || upstream.status === 422) continue;
      throw new HttpError(502, lastError, "image_upstream_error");
    }
    const images = generatedImages(result, "output_format" in payload ? "jpeg" : "png");
    if (images.length === 0) throw new HttpError(502, "图片服务没有返回可显示的图片", "invalid_image_response");
    return { providerId: config.provider_id, model, images };
  }

  throw new HttpError(502, lastError, "image_upstream_error");
}

export async function workGenerateImage(request: Request, env: WorkEnv): Promise<Response> {
  const auth = await authenticated(request, env);
  const body = await readJsonObject(request);
  const providerId = typeof body.providerId === "string" && body.providerId.trim() ? normalizedProviderId(body.providerId) : undefined;
  const config = await providerForUser(env.DB, auth.user.id, providerId);
  if (!config) throw new HttpError(409, providerId ? "所选 AI 接口不存在" : "请先配置图片 AI 接口", "work_ai_not_configured");
  const apiKey = await decryptApiKey(config, env);
  return json(await generateImagesForProvider(config, apiKey, body));
}
