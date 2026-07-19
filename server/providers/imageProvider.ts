import { nanoid } from "nanoid";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../runtime/config";
import type { AgentAttachment } from "../shared/types";
import { resolveAiProviderForExecution } from "./aiProviderRegistry";

export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536" | "2048x2048" | "2048x1152" | "2160x3840" | "3840x2160";
export type ImageQuality = "auto" | "low" | "medium" | "high";
const IMAGE_SIZES = new Set<ImageSize>(["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "2160x3840", "3840x2160"]);
const IMAGE_QUALITIES = new Set<ImageQuality>(["auto", "low", "medium", "high"]);

export interface GenerateImageInput {
  prompt: string;
  providerId?: string;
  model?: string;
  size?: ImageSize;
  quality?: ImageQuality;
  count?: number;
  signal?: AbortSignal;
}

export interface GeneratedImageResult {
  model: string;
  provider: string;
  attachments: AgentAttachment[];
}

function generatedImageDirectory() {
  const databasePath = path.resolve(process.cwd(), process.env.LOCAL_DATABASE_PATH ?? "data/agent-console.sqlite");
  return path.join(path.dirname(databasePath), "generated-images");
}

export function generatedImageFilePath(fileName: string) {
  if (!/^[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/.test(fileName)) throw new Error("图片文件名无效");
  return path.join(generatedImageDirectory(), fileName);
}

async function persistGeneratedImages(attachments: AgentAttachment[]) {
  const directory = generatedImageDirectory();
  await mkdir(directory, { recursive: true });
  return Promise.all(attachments.map(async (attachment) => {
    if (!attachment.dataUrl) return attachment;
    const match = attachment.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) return attachment;
    const extension = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
    const fileName = `${Date.now()}-${nanoid(12)}.${extension}`;
    await writeFile(path.join(directory, fileName), Buffer.from(match[2], "base64"), { mode: 0o600 });
    return { ...attachment, url: `/api/images/generated/${fileName}` };
  }));
}

function imageEndpoint(baseUrl: string, path = "/images/generations") {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function upstreamError(payload: unknown, status: number) {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const error = root?.error && typeof root.error === "object" ? root.error as Record<string, unknown> : undefined;
  return typeof error?.message === "string" ? error.message : `图片服务请求失败（HTTP ${status}）`;
}

function base64Bytes(value: string) {
  return Math.floor(value.length * 0.75);
}

export function parseGeneratedImages(payload: unknown, format = "jpeg"): AgentAttachment[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const source = Array.isArray(root?.data) ? root.data : Array.isArray(root?.images) ? root.images : [];
  return source.slice(0, 4).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const b64 = typeof item.b64_json === "string" ? item.b64_json : typeof item.base64 === "string" ? item.base64 : undefined;
    const url = typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : undefined;
    if (!b64 && !url) return [];
    if (b64 && base64Bytes(b64) > 10 * 1024 * 1024) throw new Error("图片服务返回的单张图片超过 10 MB 限制");
    const mimeType = typeof item.mime_type === "string" && item.mime_type.startsWith("image/")
      ? item.mime_type
      : format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    return [{
      id: `generated_${nanoid(10)}`,
      name: `generated-image-${index + 1}.${mimeType.split("/")[1] || "jpg"}`,
      mimeType,
      size: b64 ? base64Bytes(b64) : 0,
      kind: "image" as const,
      dataUrl: b64 ? `data:${mimeType};base64,${b64}` : undefined,
      url,
      text: typeof item.revised_prompt === "string" ? item.revised_prompt.slice(0, 4_000) : undefined
    }];
  });
}

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImageResult> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("生图提示词不能为空");
  if (prompt.length > 8_000) throw new Error("生图提示词不能超过 8000 个字符");
  const providerId = input.providerId?.trim() || getRuntimeConfig().providerName;
  const provider = resolveAiProviderForExecution(providerId);
  if (!provider.apiKey) throw new Error(`AI 接口“${provider.displayName}”尚未配置 API Key`);
  const imageModels = [...new Set([provider.defaultImageModel, ...(provider.imageModels ?? [])].filter((model): model is string => Boolean(model)))];
  const model = input.model?.trim() || provider.defaultImageModel || imageModels[0];
  if (!model) throw new Error(`AI 接口“${provider.displayName}”尚未配置图片模型`);
  if (imageModels.length > 0 && !imageModels.includes(model)) throw new Error(`图片模型“${model}”不在接口允许列表中`);
  if (input.size && !IMAGE_SIZES.has(input.size)) throw new Error("不支持的图片尺寸");
  if (input.quality && !IMAGE_QUALITIES.has(input.quality)) throw new Error("不支持的图片质量");

  const count = Math.max(1, Math.min(Math.floor(input.count ?? 1), 4));
  const endpoint = imageEndpoint(provider.baseUrl, provider.imageGenerationPath);
  const basePayload = {
    model,
    prompt,
    n: count,
    size: input.size ?? "auto",
    quality: input.quality ?? "auto"
  };
  const requestPayloads: Array<Record<string, unknown>> = [
    { ...basePayload, output_format: "jpeg", output_compression: 85 },
    basePayload
  ];
  let lastError = "图片生成失败";
  for (const payload of requestPayloads) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json", accept: "application/json", "user-agent": "Rcode" },
        body: JSON.stringify(payload),
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
      });
    } catch (error) {
      throw new Error(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "图片生成超时" : "无法连接图片生成服务");
    }
    const parsed = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      lastError = upstreamError(parsed, response.status);
      if (response.status === 400 || response.status === 404 || response.status === 422) continue;
      throw new Error(lastError);
    }
    const attachments = await persistGeneratedImages(parseGeneratedImages(parsed, "output_format" in payload ? "jpeg" : "png"));
    if (attachments.length === 0) throw new Error("图片服务没有返回可显示的图片");
    return { model, provider: provider.id, attachments };
  }
  throw new Error(lastError);
}
