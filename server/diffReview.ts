export interface DiffFileSummary {
  file: string;
  addedLines: number;
  removedLines: number;
  risk: "low" | "medium" | "high";
  reasons: string[];
}

export interface DiffReviewSummary {
  files: DiffFileSummary[];
  totalAdded: number;
  totalRemoved: number;
  highestRisk: "low" | "medium" | "high";
  summary: string;
}

function riskRank(risk: "low" | "medium" | "high") {
  return risk === "high" ? 3 : risk === "medium" ? 2 : 1;
}

function getFileRisk(file: string, addedLines: number, removedLines: number): { risk: "low" | "medium" | "high"; reasons: string[] } {
  const reasons: string[] = [];
  let risk: "low" | "medium" | "high" = "low";

  if (/package-lock\.json|pnpm-lock\.yaml|yarn\.lock/.test(file)) {
    risk = "medium";
    reasons.push("lockfile changed");
  }

  if (/package\.json|tsconfig|vite\.config|electron|config\//.test(file)) {
    risk = riskRank(risk) > riskRank("medium") ? risk : "medium";
    reasons.push("configuration/runtime file changed");
  }

  if (/server\/|permissions|tools|agent|auth|token|secret|credential/i.test(file)) {
    risk = "high";
    reasons.push("server, permission, tool, or sensitive path changed");
  }

  if (addedLines + removedLines > 250) {
    risk = riskRank(risk) > riskRank("medium") ? risk : "medium";
    reasons.push("large diff");
  }

  if (addedLines + removedLines > 800) {
    risk = "high";
    reasons.push("very large diff");
  }

  if (reasons.length === 0) reasons.push("small localized change");

  return { risk, reasons };
}

export function summarizeGitDiff(diff: string): DiffReviewSummary {
  const files = new Map<string, { addedLines: number; removedLines: number }>();
  let currentFile = "unknown";

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      if (!files.has(currentFile)) files.set(currentFile, { addedLines: 0, removedLines: 0 });
      continue;
    }

    if (!files.has(currentFile)) files.set(currentFile, { addedLines: 0, removedLines: 0 });
    const summary = files.get(currentFile)!;

    if (line.startsWith("+") && !line.startsWith("+++")) summary.addedLines++;
    if (line.startsWith("-") && !line.startsWith("---")) summary.removedLines++;
  }

  const fileSummaries: DiffFileSummary[] = [...files.entries()]
    .filter(([file]) => file !== "unknown")
    .map(([file, counts]) => {
      const risk = getFileRisk(file, counts.addedLines, counts.removedLines);
      return { file, addedLines: counts.addedLines, removedLines: counts.removedLines, ...risk };
    });

  const totalAdded = fileSummaries.reduce((sum, file) => sum + file.addedLines, 0);
  const totalRemoved = fileSummaries.reduce((sum, file) => sum + file.removedLines, 0);
  const highestRisk = fileSummaries.reduce<"low" | "medium" | "high">(
    (current, file) => riskRank(file.risk) > riskRank(current) ? file.risk : current,
    "low"
  );

  const summary = [
    "## Diff Review Summary",
    `Files changed: ${fileSummaries.length}`,
    `Lines: +${totalAdded} / -${totalRemoved}`,
    `Highest risk: ${highestRisk}`,
    "",
    ...fileSummaries.slice(0, 30).map((file) => `- [${file.risk}] ${file.file} (+${file.addedLines}/-${file.removedLines}) — ${file.reasons.join(", ")}`)
  ].join("\n");

  return { files: fileSummaries, totalAdded, totalRemoved, highestRisk, summary };
}
