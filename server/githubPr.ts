import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CreatePullRequestInput {
  cwd: string;
  title: string;
  body: string;
  base: string;
  draft?: boolean;
}

export interface CreatePullRequestResult {
  usedNativeApi: boolean;
  ok: boolean;
  output: string;
}

function parseGitHubRemote(remoteUrl: string) {
  const trimmed = remoteUrl.trim();

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return undefined;
}

async function getGitOutput(cwd: string, command: string) {
  const { stdout } = await execFileAsync("zsh", ["-lc", command], { cwd, timeout: 30000 });
  return stdout.trim();
}

export async function createPullRequestWithGitHubApi(input: CreatePullRequestInput): Promise<CreatePullRequestResult | undefined> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return undefined;

  const remoteUrl = await getGitOutput(input.cwd, "git remote get-url origin");
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    return {
      usedNativeApi: true,
      ok: false,
      output: `Unable to parse GitHub remote URL: ${remoteUrl}`
    };
  }

  const branch = await getGitOutput(input.cwd, "git branch --show-current");
  if (!branch) {
    return {
      usedNativeApi: true,
      ok: false,
      output: "Unable to determine current branch."
    };
  }

  const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: branch,
      base: input.base,
      draft: input.draft === true
    })
  });

  const payload = await response.json().catch(() => undefined) as { html_url?: string; message?: string; errors?: unknown } | undefined;

  if (!response.ok) {
    return {
      usedNativeApi: true,
      ok: false,
      output: JSON.stringify({ status: response.status, message: payload?.message, errors: payload?.errors }, null, 2)
    };
  }

  return {
    usedNativeApi: true,
    ok: true,
    output: payload?.html_url ? `Created pull request: ${payload.html_url}` : "Pull request created."
  };
}
