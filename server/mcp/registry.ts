import { getDefaultAgentContextBudget, prepareAgentContext } from "../agentContext";
import { getDeliveryWorkflowProfile, formatDeliveryWorkflowProfile } from "../deliveryWorkflow";
import { summarizeGitDiff } from "../diffReview";
import { formatProjectContextSnapshot, getProjectContextSnapshot } from "../projectContext";
import { buildTaskBranchPlan } from "../taskWorkspace";
import { formatParsedTestResult, parseTestResult } from "../testResultParser";
import type { AgentMessage } from "../types";
import type { McpToolCallResult, McpToolDefinition } from "./types";

export interface McpToolHandlerInput {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpRegisteredTool {
  definition: McpToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<McpToolCallResult> | McpToolCallResult;
}

function textResult(text: string, isError = false): McpToolCallResult {
  return { content: [{ type: "text", text }], isError };
}

function getString(args: Record<string, unknown>, key: string, fallback = "") {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function getBoolean(args: Record<string, unknown>, key: string, fallback = false) {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function getObjectArray(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AgentMessage => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return typeof record.role === "string" && typeof record.content === "string";
  });
}

export const mcpTools: McpRegisteredTool[] = [
  {
    definition: {
      name: "rcode.project_context",
      description: "Build a project context snapshot with file tree, package scripts, README excerpt, rules files, config files, and likely tech stack.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string", description: "Absolute project root. Defaults to current working directory." },
          formatted: { type: "boolean", description: "Return formatted text instead of raw JSON." }
        },
        additionalProperties: false
      }
    },
    handler(args) {
      const snapshot = getProjectContextSnapshot(getString(args, "projectPath", undefined as unknown as string));
      if (getBoolean(args, "formatted", true)) return textResult(formatProjectContextSnapshot(snapshot));
      return textResult(JSON.stringify(snapshot, null, 2));
    }
  },
  {
    definition: {
      name: "rcode.prepare_agent_context",
      description: "Prepare optimized agent context with project context, delivery workflow, skill hints, compaction, and budget stats.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Latest user prompt." },
          projectPath: { type: "string", description: "Absolute project root." },
          includeMessages: { type: "boolean", description: "Include prepared messages in the response. Defaults false." }
        },
        required: ["prompt"],
        additionalProperties: false
      }
    },
    handler(args) {
      const prompt = getString(args, "prompt");
      const projectPath = getString(args, "projectPath", undefined as unknown as string);
      const prepared = prepareAgentContext([{ role: "user", content: prompt }], { projectPath });
      const payload = {
        stats: prepared.stats,
        budget: getDefaultAgentContextBudget(),
        systemAddendum: prepared.systemAddendum,
        messages: getBoolean(args, "includeMessages", false) ? prepared.messages : undefined
      };
      return textResult(JSON.stringify(payload, null, 2));
    }
  },
  {
    definition: {
      name: "rcode.delivery_workflow",
      description: "Detect delivery intent and return recommended behavior, tools, and done criteria for a coding agent task.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "User task prompt." }
        },
        required: ["prompt"],
        additionalProperties: false
      }
    },
    handler(args) {
      const profile = getDeliveryWorkflowProfile(getString(args, "prompt"));
      return textResult(formatDeliveryWorkflowProfile(profile));
    }
  },
  {
    definition: {
      name: "rcode.parse_test_result",
      description: "Parse test/typecheck/lint/build output into structured failures for agent repair loops.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command that produced the output." },
          ok: { type: "boolean", description: "Whether the command succeeded." },
          output: { type: "string", description: "Raw stdout/stderr output." },
          json: { type: "boolean", description: "Return raw JSON instead of formatted text." }
        },
        required: ["command", "output"],
        additionalProperties: false
      }
    },
    handler(args) {
      const parsed = parseTestResult(getString(args, "command"), getBoolean(args, "ok", false), getString(args, "output"));
      if (getBoolean(args, "json", false)) return textResult(JSON.stringify(parsed, null, 2));
      return textResult(formatParsedTestResult(parsed));
    }
  },
  {
    definition: {
      name: "rcode.diff_review",
      description: "Summarize a git diff into changed files, line counts, risk level, and review summary.",
      inputSchema: {
        type: "object",
        properties: {
          diff: { type: "string", description: "Unified git diff text." },
          json: { type: "boolean", description: "Return raw JSON instead of formatted text." }
        },
        required: ["diff"],
        additionalProperties: false
      }
    },
    handler(args) {
      const summary = summarizeGitDiff(getString(args, "diff"));
      if (getBoolean(args, "json", false)) return textResult(JSON.stringify(summary, null, 2));
      return textResult(summary.summary);
    }
  },
  {
    definition: {
      name: "rcode.task_branch_plan",
      description: "Create a safe branch naming plan and git commands for isolating a coding task.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task prompt or title." },
          baseBranch: { type: "string", description: "Base branch. Defaults to main." }
        },
        required: ["prompt"],
        additionalProperties: false
      }
    },
    handler(args) {
      const plan = buildTaskBranchPlan(getString(args, "prompt"), getString(args, "baseBranch", "main"));
      return textResult(JSON.stringify(plan, null, 2));
    }
  },
  {
    definition: {
      name: "rcode.compact_messages",
      description: "Compact an array of agent messages using Rcode context budget and return stats plus prepared messages.",
      inputSchema: {
        type: "object",
        properties: {
          messages: { type: "array", description: "Agent messages with role and content." },
          projectPath: { type: "string", description: "Absolute project root." }
        },
        required: ["messages"],
        additionalProperties: false
      }
    },
    handler(args) {
      const messages = getObjectArray(args.messages);
      const projectPath = getString(args, "projectPath", undefined as unknown as string);
      const prepared = prepareAgentContext(messages, { projectPath });
      return textResult(JSON.stringify({ stats: prepared.stats, messages: prepared.messages }, null, 2));
    }
  }
];

export function listMcpToolDefinitions() {
  return mcpTools.map((tool) => tool.definition);
}

export function getMcpTool(name: string) {
  return mcpTools.find((tool) => tool.definition.name === name);
}
