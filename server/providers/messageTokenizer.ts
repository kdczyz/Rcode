import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";

export interface MessageTokenCount {
  tokens: number;
  exact: boolean;
}

const MIMO_TOKENIZER_BASE_URL = "https://huggingface.co/XiaomiMiMo/MiMo-V2.5/resolve/main";
const TOKENIZER_CACHE_DIR = path.join(tmpdir(), "rcode-tokenizers", "mimo-v2.5");
const TOKENIZER_JSON_PATH = path.join(TOKENIZER_CACHE_DIR, "tokenizer.json");
const TOKENIZER_CONFIG_PATH = path.join(TOKENIZER_CACHE_DIR, "tokenizer_config.json");

let mimoTokenizerPromise: Promise<Tokenizer | undefined> | undefined;

function supportsOfficialMimoTokenizer(model?: string) {
  return /^mimo-v2\.5(?:-pro)?(?:$|[-:])/i.test(model?.trim() ?? "");
}

async function readCachedJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function fetchJson(fileName: "tokenizer.json" | "tokenizer_config.json") {
  const response = await fetch(`${MIMO_TOKENIZER_BASE_URL}/${fileName}`, {
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Tokenizer download failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}

async function loadMimoTokenizer() {
  try {
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      readCachedJson(TOKENIZER_JSON_PATH),
      readCachedJson(TOKENIZER_CONFIG_PATH)
    ]);
    return new Tokenizer(tokenizerJson, tokenizerConfig);
  } catch {
    try {
      const [tokenizerJson, tokenizerConfig] = await Promise.all([
        fetchJson("tokenizer.json"),
        fetchJson("tokenizer_config.json")
      ]);
      await mkdir(TOKENIZER_CACHE_DIR, { recursive: true });
      await Promise.all([
        writeFile(TOKENIZER_JSON_PATH, JSON.stringify(tokenizerJson)),
        writeFile(TOKENIZER_CONFIG_PATH, JSON.stringify(tokenizerConfig))
      ]);
      return new Tokenizer(tokenizerJson, tokenizerConfig);
    } catch (error) {
      console.warn("[Tokenizer] Falling back to local message estimate:", error instanceof Error ? error.message : error);
      return undefined;
    }
  }
}

function getMimoTokenizer() {
  mimoTokenizerPromise ??= loadMimoTokenizer();
  return mimoTokenizerPromise;
}

/**
 * Counts only the visible text in one message. For MiMo 2.5 models this uses
 * Xiaomi's published tokenizer, so conversation history and tool payloads are
 * deliberately excluded from the per-message counter.
 */
export async function countMessageTokens(text: string, model?: string): Promise<MessageTokenCount> {
  if (!text) return { tokens: 0, exact: true };

  if (supportsOfficialMimoTokenizer(model)) {
    const tokenizer = await getMimoTokenizer();
    if (tokenizer) {
      return {
        tokens: tokenizer.encode(text, { add_special_tokens: false }).ids.length,
        exact: true
      };
    }
  }

  return {
    tokens: Math.max(1, Math.ceil(text.length / 4)),
    exact: false
  };
}

export function warmMessageTokenizer(model?: string) {
  if (supportsOfficialMimoTokenizer(model)) void getMimoTokenizer();
}
