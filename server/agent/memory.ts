import { getAppSetting, setAppSetting } from "../storage/database";
import type { CompactionDetail, CompactionMode } from "./compactionSegments";
import type { ToolResultPruningConfig } from "./toolResultPruning";
import { defaultToolResultPruningConfig } from "./toolResultPruning";

export interface MemorySettings {
  shortTerm: {
    enabled: boolean;
    contextBudgetTokens: number;
    summaryTokenLimit: number;
    toolOutputTokenLimit: number;
  };
  longTerm: {
    enabled: boolean;
    maxResults: number;
    maxContextChars: number;
    minImportance: number;
    retrieval: "recent" | "hybrid";
  };
  skillIntegration: {
    enabled: boolean;
    exposeTools: boolean;
  };
  /**
   * 压缩策略:
   * - mode:     summary(默认,只留摘要) / transcript(摘要+原文路径) / segments(摘要+按段md)
   * - detail:   segments 模式下每个 segment 文件保留多少 verbatim 细节
   * - pruning:  工具结果三段式修剪
   */
  compaction: {
    mode: CompactionMode;
    detail: CompactionDetail;
    pruning: ToolResultPruningConfig;
  };
}

export const defaultMemorySettings: MemorySettings = {
  shortTerm: { enabled: true, contextBudgetTokens: 16_000, summaryTokenLimit: 1_600, toolOutputTokenLimit: 900 },
  longTerm: { enabled: true, maxResults: 12, maxContextChars: 6_000, minImportance: 1, retrieval: "hybrid" },
  skillIntegration: { enabled: true, exposeTools: true },
  compaction: {
    mode: "summary",
    detail: "balanced",
    pruning: defaultToolResultPruningConfig
  }
};

function finiteInteger(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function normalizeCompactionMode(value: unknown): CompactionMode {
  return value === "transcript" || value === "segments" ? value : "summary";
}

function normalizeCompactionDetail(value: unknown): CompactionDetail {
  return value === "none" || value === "minimal" || value === "balanced" || value === "verbose"
    ? value
    : "balanced";
}

function normalizePruning(value: unknown): ToolResultPruningConfig {
  const raw = value && typeof value === "object" ? value as Partial<ToolResultPruningConfig> : {};
  return {
    enabled: raw.enabled !== false,
    keepLastNTurns: finiteInteger(raw.keepLastNTurns, defaultToolResultPruningConfig.keepLastNTurns, 0, 20),
    softTrimThresholdChars: finiteInteger(raw.softTrimThresholdChars, defaultToolResultPruningConfig.softTrimThresholdChars, 500, 64_000),
    softTrimHeadChars: finiteInteger(raw.softTrimHeadChars, defaultToolResultPruningConfig.softTrimHeadChars, 100, 16_000),
    softTrimTailChars: finiteInteger(raw.softTrimTailChars, defaultToolResultPruningConfig.softTrimTailChars, 100, 16_000),
    hardClearAgeTurns: finiteInteger(raw.hardClearAgeTurns, defaultToolResultPruningConfig.hardClearAgeTurns, 2, 100)
  };
}

export function normalizeMemorySettings(value: unknown): MemorySettings {
  const raw = value && typeof value === "object" ? value as Partial<MemorySettings> : {};
  const short = raw.shortTerm ?? {} as MemorySettings["shortTerm"];
  const long = raw.longTerm ?? {} as MemorySettings["longTerm"];
  const skill = raw.skillIntegration ?? {} as MemorySettings["skillIntegration"];
  const compaction = raw.compaction ?? {} as MemorySettings["compaction"];
  return {
    shortTerm: {
      enabled: short.enabled !== false,
      contextBudgetTokens: finiteInteger(short.contextBudgetTokens, 16_000, 4_000, 128_000),
      summaryTokenLimit: finiteInteger(short.summaryTokenLimit, 1_600, 400, 8_000),
      toolOutputTokenLimit: finiteInteger(short.toolOutputTokenLimit, 900, 200, 8_000)
    },
    longTerm: {
      enabled: long.enabled !== false,
      maxResults: finiteInteger(long.maxResults, 12, 1, 50),
      maxContextChars: finiteInteger(long.maxContextChars, 6_000, 1_000, 32_000),
      minImportance: finiteInteger(long.minImportance, 1, 1, 5),
      retrieval: long.retrieval === "recent" ? "recent" : "hybrid"
    },
    skillIntegration: {
      enabled: skill.enabled !== false,
      exposeTools: skill.exposeTools !== false
    },
    compaction: {
      mode: normalizeCompactionMode(compaction.mode),
      detail: normalizeCompactionDetail(compaction.detail),
      pruning: normalizePruning(compaction.pruning)
    }
  };
}

export function getMemorySettings() {
  return normalizeMemorySettings(getAppSetting("memory_settings", defaultMemorySettings));
}

export function saveMemorySettings(value: unknown) {
  return setAppSetting("memory_settings", normalizeMemorySettings(value));
}
