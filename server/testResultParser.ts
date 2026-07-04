export type TestFailureKind = "typescript" | "eslint" | "jest" | "vitest" | "build" | "runtime" | "unknown";

export interface ParsedTestFailure {
  kind: TestFailureKind;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
}

export interface ParsedTestResult {
  ok: boolean;
  command: string;
  failureCount: number;
  failures: ParsedTestFailure[];
  summary: string;
}

const maxFailures = 20;

function pushFailure(failures: ParsedTestFailure[], failure: ParsedTestFailure) {
  if (failures.length >= maxFailures) return;
  const key = `${failure.kind}:${failure.file ?? ""}:${failure.line ?? ""}:${failure.column ?? ""}:${failure.code ?? ""}:${failure.message}`;
  const exists = failures.some((item) => `${item.kind}:${item.file ?? ""}:${item.line ?? ""}:${item.column ?? ""}:${item.code ?? ""}:${item.message}` === key);
  if (!exists) failures.push(failure);
}

function parseTypeScript(output: string, failures: ParsedTestFailure[]) {
  const regex = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    pushFailure(failures, {
      kind: "typescript",
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5]
    });
  }
}

function parseEslint(output: string, failures: ParsedTestFailure[]) {
  const lines = output.split("\n");
  let currentFile: string | undefined;

  for (const line of lines) {
    if (/^\S.*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line.trim())) {
      currentFile = line.trim();
      continue;
    }

    const match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w@/-]+)$/);
    if (match) {
      pushFailure(failures, {
        kind: "eslint",
        file: currentFile,
        line: Number(match[1]),
        column: Number(match[2]),
        code: match[5],
        message: match[4]
      });
    }
  }
}

function parseJestVitest(output: string, failures: ParsedTestFailure[]) {
  const suiteRegex = /^\s*(FAIL|Failed)\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = suiteRegex.exec(output)) !== null) {
    pushFailure(failures, {
      kind: output.toLowerCase().includes("vitest") ? "vitest" : "jest",
      file: match[2].trim(),
      message: match[0].trim()
    });
  }

  const assertionRegex = /^\s*(AssertionError|Error|TypeError|ReferenceError):\s+(.+)$/gm;
  while ((match = assertionRegex.exec(output)) !== null) {
    pushFailure(failures, {
      kind: output.toLowerCase().includes("vitest") ? "vitest" : "jest",
      message: `${match[1]}: ${match[2]}`
    });
  }
}

function parseBuild(output: string, failures: ParsedTestFailure[]) {
  const viteRegex = /^(.+?):(\d+):(\d+):\s+ERROR:\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = viteRegex.exec(output)) !== null) {
    pushFailure(failures, {
      kind: "build",
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      message: match[4]
    });
  }

  const genericError = output.match(/(Error|Build failed|Failed to compile|Command failed)[^\n]*/i);
  if (genericError && failures.length === 0) {
    pushFailure(failures, {
      kind: "build",
      message: genericError[0]
    });
  }
}

function parseRuntime(output: string, failures: ParsedTestFailure[]) {
  const stackRegex = /at\s+.+?\((.+?):(\d+):(\d+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = stackRegex.exec(output)) !== null) {
    pushFailure(failures, {
      kind: "runtime",
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      message: "Runtime stack trace location"
    });
  }
}

function summarizeFailures(failures: ParsedTestFailure[]) {
  if (failures.length === 0) return "No structured failures detected.";

  return failures.map((failure, index) => {
    const location = [failure.file, failure.line, failure.column].filter(Boolean).join(":");
    const code = failure.code ? ` ${failure.code}` : "";
    return `${index + 1}. [${failure.kind}${code}] ${location ? `${location} - ` : ""}${failure.message}`;
  }).join("\n");
}

export function parseTestResult(command: string, ok: boolean, output: string): ParsedTestResult {
  const failures: ParsedTestFailure[] = [];

  parseTypeScript(output, failures);
  parseEslint(output, failures);
  parseJestVitest(output, failures);
  parseBuild(output, failures);
  parseRuntime(output, failures);

  if (!ok && failures.length === 0) {
    const firstErrorLine = output.split("\n").find((line) => /error|failed|exception|fatal/i.test(line));
    pushFailure(failures, {
      kind: "unknown",
      message: firstErrorLine?.trim() || "Command failed without a recognizable structured error."
    });
  }

  return {
    ok,
    command,
    failureCount: failures.length,
    failures,
    summary: summarizeFailures(failures)
  };
}

export function formatParsedTestResult(result: ParsedTestResult) {
  return [
    "## Parsed Test Result",
    `Command: ${result.command}`,
    `Status: ${result.ok ? "passed" : "failed"}`,
    `Failure count: ${result.failureCount}`,
    result.summary
  ].join("\n");
}
