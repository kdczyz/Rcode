const MAX_JSON_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders() });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > MAX_JSON_BYTES) throw new HttpError(413, "请求内容过大", "payload_too_large");
  if (!request.body) throw new HttpError(400, "缺少请求内容", "invalid_request");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "请求内容过大", "payload_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "JSON 格式不正确", "invalid_json");
  }
  if (!isObject(parsed)) throw new HttpError(400, "请求内容必须是 JSON 对象", "invalid_request");
  return parsed;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {}
): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} 格式不正确`, "invalid_request");
  const normalized = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 256;
  if (normalized.length < min || normalized.length > max || (options.pattern && !options.pattern.test(normalized))) {
    throw new HttpError(400, `${field} 格式不正确`, "invalid_request");
  }
  return normalized;
}

export function logError(message: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    level: "error",
    message,
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
    ...data
  }));
}
