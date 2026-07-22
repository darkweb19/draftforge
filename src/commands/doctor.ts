import { spawnSync } from "node:child_process";

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "missing" | "fail";
  readonly detail: string;
}

export function runDoctor(environment: NodeJS.ProcessEnv = process.env): readonly DoctorCheck[] {
  return [
    commandCheck("Git", "git"),
    commandCheck("Codex CLI", "codex"),
    commandCheck("Claude Code", "claude"),
    environmentCheck("OpenAI API key", "OPENAI_API_KEY", environment),
    environmentCheck("Anthropic API key", "ANTHROPIC_API_KEY", environment),
  ];
}

function commandCheck(name: string, command: string): DoctorCheck {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  const found = result.status === 0;

  return {
    name,
    status: found ? "pass" : "missing",
    detail: found ? "command available" : "command not found on PATH",
  };
}

function environmentCheck(
  name: string,
  variable: string,
  environment: NodeJS.ProcessEnv,
): DoctorCheck {
  const found = Boolean(environment[variable]);

  return {
    name,
    status: found ? "pass" : "missing",
    detail: found ? `${variable} is set` : `${variable} is not set`,
  };
}
