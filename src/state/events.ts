import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const REDACTED_VALUE = "[REDACTED]";

export interface RunEvent {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /(api.?key|authorization|credential|password|secret|token)/i;

export async function appendRunEvent(
  root: string,
  runId: string,
  event: RunEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error("runId must contain only letters, numbers, dots, underscores, or hyphens.");
  }

  const path = resolve(root, ".draftforge", "runs", runId, "events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const redacted = redactForLog(redactConfiguredSecrets(event, configuredSecretsFromEnv(env)));
  await appendFile(path, `${JSON.stringify(redacted)}\n`, { encoding: "utf8", flag: "a" });
}

export function redactForLog(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export function configuredSecretsFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(env)
    .filter(([key, value]) =>
      /(?:api.?key|authorization|credential|password|secret|token)/iu.test(key) &&
      typeof value === "string")
    .map(([, value]) => value as string)
    .filter((value) => value.length > 0);
}

export function redactConfiguredSecrets(value: unknown, secrets: readonly string[]): unknown {
  return redactConfiguredValue(value, secrets, new WeakSet<object>());
}

function redactConfiguredValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (redacted, secret) => redacted.replaceAll(secret, REDACTED_VALUE),
      value,
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[REDACTED:CIRCULAR]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactConfiguredValue(item, secrets, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactConfiguredValue(item, secrets, seen),
    ]),
  );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[REDACTED:CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED_VALUE : redactValue(item, seen);
  }
  return redacted;
}

function redactString(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${REDACTED_VALUE}`)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, REDACTED_VALUE)
    .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*\S+/gi, `$1=${REDACTED_VALUE}`);
}
