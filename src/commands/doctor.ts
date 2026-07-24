import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { defaultProjectConfig, type AdapterId, type ProjectConfig } from "../config/config.js";
import { prepareProcessInvocation } from "../providers/harness/process.js";

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "missing" | "fail";
  readonly detail: string;
}

export interface DoctorProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface DoctorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly runProcess?: (command: string, args: readonly string[]) => DoctorProcessResult;
}

interface HarnessAuth {
  readonly command: string;
  readonly args: readonly string[];
}

const HARNESS_AUTH: Readonly<Record<"codex-cli" | "claude-cli", HarnessAuth>> = {
  "codex-cli": { command: "codex", args: ["login", "status"] },
  "claude-cli": { command: "claude", args: ["auth", "status"] },
};

const API_KEY_VARIABLES: Readonly<Record<"openai-api" | "anthropic-api", string>> = {
  "openai-api": "OPENAI_API_KEY",
  "anthropic-api": "ANTHROPIC_API_KEY",
};

export function runDoctor(config: ProjectConfig, options?: DoctorOptions): readonly DoctorCheck[];
export function runDoctor(environment?: NodeJS.ProcessEnv): readonly DoctorCheck[];
export function runDoctor(
  configOrEnvironment: ProjectConfig | NodeJS.ProcessEnv = process.env,
  options: DoctorOptions = {},
): readonly DoctorCheck[] {
  const hasConfig = isProjectConfig(configOrEnvironment);
  const config = hasConfig ? configOrEnvironment : defaultProjectConfig();
  const environment = hasConfig
    ? options.environment ?? process.env
    : configOrEnvironment;
  const platform = options.platform ?? process.platform;
  const runProcess =
    options.runProcess ??
    ((command: string, args: readonly string[]) => defaultRunProcess(command, args, platform));
  const adapterChecks = new Map<AdapterId, Omit<DoctorCheck, "name">>();

  return [
    commandCheck("Git", "git", platform, runProcess),
    ...(["architect", "worker", "reviewer"] as const).map((role) => {
      const adapter = config.roles[role].adapter;
      const checked =
        adapterChecks.get(adapter) ??
        checkAdapter(adapter, environment, platform, runProcess);
      adapterChecks.set(adapter, checked);
      return {
        name: `${role} adapter (${adapter})`,
        ...checked,
      };
    }),
  ];
}

function isProjectConfig(value: ProjectConfig | NodeJS.ProcessEnv): value is ProjectConfig {
  return "roles" in value && "limits" in value;
}

function checkAdapter(
  adapter: AdapterId,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  runProcess: (command: string, args: readonly string[]) => DoctorProcessResult,
): Omit<DoctorCheck, "name"> {
  if (adapter === "openai-api" || adapter === "anthropic-api") {
    const variable = API_KEY_VARIABLES[adapter];
    const configured = environment[variable]?.trim().length !== 0 &&
      environment[variable] !== undefined;
    return {
      status: configured ? "pass" : "missing",
      detail: configured
        ? `${variable} is set; authentication is configured (not network-verified)`
        : `${variable} is not set; authentication is missing`,
    };
  }

  const auth = HARNESS_AUTH[adapter];
  const availability = locateCommand(auth.command, platform, runProcess);
  if (availability.status !== "pass") {
    return availability;
  }

  const result = runProcess(auth.command, auth.args);
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    return {
      status: "fail",
      detail: "command available; authentication status could not be checked",
    };
  }
  if (result.status === 0) {
    return {
      status: "pass",
      detail: "command available; authentication is active",
    };
  }

  const diagnostic = `${result.stdout}\n${result.stderr}`;
  if (/not (?:logged in|authenticated)|login required|unauthenticated/i.test(diagnostic)) {
    return {
      status: "missing",
      detail: "command available; authentication is missing",
    };
  }
  return {
    status: "fail",
    detail: "command available; authentication configuration is invalid",
  };
}

function commandCheck(
  name: string,
  command: string,
  platform: NodeJS.Platform,
  runProcess: (command: string, args: readonly string[]) => DoctorProcessResult,
): DoctorCheck {
  return { name, ...locateCommand(command, platform, runProcess) };
}

function locateCommand(
  command: string,
  platform: NodeJS.Platform,
  runProcess: (command: string, args: readonly string[]) => DoctorProcessResult,
): Omit<DoctorCheck, "name"> {
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = runProcess(locator, [command]);
  if (result.status === 0) {
    return { status: "pass", detail: "command available" };
  }
  if (result.error === undefined && result.signal === null && result.status !== null) {
    return { status: "missing", detail: "command not found on PATH; authentication is missing" };
  }
  return { status: "fail", detail: "command availability could not be checked" };
}

function defaultRunProcess(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): DoctorProcessResult {
  const invocation = prepareProcessInvocation(command, args, { platform });
  const result: SpawnSyncReturns<string> = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
