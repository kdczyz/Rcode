import { getRuntimeConfig } from "../runtime/config";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface ResolvedSecrets {
  env: NodeJS.ProcessEnv;
  values: string[];
  refs: string[];
}

export function normalizeSecretRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("secretRefs must be an array of environment variable names");
  const refs = [...new Set(value.map(String))];
  for (const ref of refs) {
    if (!ENV_NAME.test(ref)) throw new Error(`Invalid secret reference: ${ref}`);
  }
  return refs;
}

export function resolveSecretEnvironment(value: unknown): ResolvedSecrets {
  const refs = normalizeSecretRefs(value);
  const allowed = new Set(getRuntimeConfig().secrets.allowedEnv);
  const env: NodeJS.ProcessEnv = {};
  const values: string[] = [];

  for (const ref of refs) {
    if (!allowed.has(ref)) throw new Error(`Secret reference is not allowlisted in config/agent.toml: ${ref}`);
    const secret = process.env[ref];
    if (!secret) throw new Error(`Secret reference is not configured in the local environment: ${ref}`);
    env[ref] = secret;
    values.push(secret);
  }

  return { env, values, refs };
}

export function redactSecrets(value: string, secrets: string[]) {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((output, secret) => output.split(secret).join("[REDACTED]"), value);
}
