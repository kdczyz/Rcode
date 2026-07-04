import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ProjectRuleFile {
  path: string;
  priority: number;
  content: string;
}

export interface ProjectPackageSummary {
  name?: string;
  version?: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  packageManager?: string;
}

export interface ProjectContextSnapshot {
  root: string;
  generatedAt: string;
  fileTree: string[];
  packageSummary?: ProjectPackageSummary;
  readmeExcerpt?: string;
  ruleFiles: ProjectRuleFile[];
  configFiles: string[];
  likelyStack: string[];
}

const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-server",
  "dist-server-bundle",
  "release",
  "coverage",
  ".next",
  ".turbo",
  ".vite",
  "out",
  "build"
]);

const ruleFileNames = [
  "AGENTS.md",
  "RCODE.md",
  "CLAUDE.md",
  ".cursorrules",
  ".cursor/rules",
  ".github/copilot-instructions.md"
];

const configFileNames = [
  "package.json",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts",
  "vite.config.js",
  "eslint.config.js",
  "config/agent.toml",
  "config/providers.json"
];

function safeRead(filePath: string, maxChars = 12000) {
  try {
    return readFileSync(filePath, "utf8").slice(0, maxChars);
  } catch {
    return undefined;
  }
}

function listTree(root: string, maxDepth = 3, maxEntries = 220) {
  const entries: string[] = [];

  function visit(current: string, depth: number) {
    if (entries.length >= maxEntries || depth > maxDepth) return;

    let children: string[];
    try {
      children = readdirSync(current).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }

    for (const child of children) {
      if (entries.length >= maxEntries) return;
      const fullPath = path.join(current, child);
      const relativePath = path.relative(root, fullPath);

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (ignoredDirs.has(child)) continue;
        entries.push(`${relativePath}/`);
        visit(fullPath, depth + 1);
      } else {
        entries.push(relativePath);
      }
    }
  }

  visit(root, 1);
  return entries;
}

function parsePackageJson(root: string): ProjectPackageSummary | undefined {
  const packagePath = path.join(root, "package.json");
  if (!existsSync(packagePath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name?: string;
      version?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      packageManager?: string;
    };

    return {
      name: parsed.name,
      version: parsed.version,
      scripts: parsed.scripts ?? {},
      dependencies: Object.keys(parsed.dependencies ?? {}).slice(0, 80),
      devDependencies: Object.keys(parsed.devDependencies ?? {}).slice(0, 80),
      packageManager: parsed.packageManager
    };
  } catch {
    return undefined;
  }
}

function findRuleFiles(root: string) {
  const results: ProjectRuleFile[] = [];

  for (const ruleName of ruleFileNames) {
    const fullPath = path.join(root, ruleName);
    if (!existsSync(fullPath)) continue;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) continue;
    const content = safeRead(fullPath, 8000);
    if (!content) continue;
    results.push({ path: ruleName, priority: ruleName.includes("/") ? 20 : 10, content });
  }

  return results.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));
}

function findConfigFiles(root: string) {
  return configFileNames.filter((configPath) => existsSync(path.join(root, configPath)));
}

function detectLikelyStack(snapshot: {
  packageSummary?: ProjectPackageSummary;
  configFiles: string[];
  fileTree: string[];
}) {
  const stack = new Set<string>();
  const deps = new Set([
    ...(snapshot.packageSummary?.dependencies ?? []),
    ...(snapshot.packageSummary?.devDependencies ?? [])
  ]);
  const files = new Set(snapshot.fileTree);

  if (deps.has("react")) stack.add("React");
  if (deps.has("vite") || snapshot.configFiles.some((file) => file.startsWith("vite.config"))) stack.add("Vite");
  if (deps.has("typescript") || snapshot.configFiles.some((file) => file.startsWith("tsconfig"))) stack.add("TypeScript");
  if (deps.has("electron")) stack.add("Electron");
  if (deps.has("express")) stack.add("Express");
  if (files.has("server/index.ts")) stack.add("Node server");
  if (files.has("config/agent.toml")) stack.add("Rcode agent config");

  return [...stack];
}

function resolveProjectRoot(projectPath?: string) {
  if (projectPath && path.isAbsolute(projectPath)) return projectPath;
  return process.cwd();
}

export function getProjectContextSnapshot(projectPath?: string): ProjectContextSnapshot {
  const root = resolveProjectRoot(projectPath);
  const fileTree = existsSync(root) ? listTree(root) : [];
  const packageSummary = parsePackageJson(root);
  const configFiles = findConfigFiles(root);
  const partial = { packageSummary, configFiles, fileTree };

  return {
    root,
    generatedAt: new Date().toISOString(),
    fileTree,
    packageSummary,
    readmeExcerpt: safeRead(path.join(root, "README.md"), 5000),
    ruleFiles: findRuleFiles(root),
    configFiles,
    likelyStack: detectLikelyStack(partial)
  };
}

export function formatProjectContextSnapshot(snapshot: ProjectContextSnapshot) {
  const scripts = snapshot.packageSummary?.scripts
    ? Object.entries(snapshot.packageSummary.scripts).map(([name, command]) => `- ${name}: ${command}`).slice(0, 20)
    : [];

  const rules = snapshot.ruleFiles.map((rule) => [
    `### ${rule.path}`,
    rule.content.slice(0, 3000)
  ].join("\n"));

  return [
    "## Project Context Snapshot",
    `Root: ${snapshot.root}`,
    snapshot.likelyStack.length ? `Likely stack: ${snapshot.likelyStack.join(", ")}` : undefined,
    snapshot.packageSummary?.name ? `Package: ${snapshot.packageSummary.name}@${snapshot.packageSummary.version ?? "unknown"}` : undefined,
    scripts.length ? `\n### Package scripts\n${scripts.join("\n")}` : undefined,
    snapshot.configFiles.length ? `\n### Config files\n${snapshot.configFiles.map((file) => `- ${file}`).join("\n")}` : undefined,
    snapshot.fileTree.length ? `\n### File tree excerpt\n${snapshot.fileTree.slice(0, 120).map((file) => `- ${file}`).join("\n")}` : undefined,
    snapshot.readmeExcerpt ? `\n### README excerpt\n${snapshot.readmeExcerpt.slice(0, 2500)}` : undefined,
    rules.length ? `\n### Project rules\n${rules.join("\n\n")}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}
