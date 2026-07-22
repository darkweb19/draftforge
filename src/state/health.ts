import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadProjectConfig } from "../config/config.js";
import { readProjectState, renderSession, SESSION_PATH } from "./files.js";

export interface ProjectHealthCheck {
  readonly name: "state" | "config" | "handoff";
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export async function inspectProjectHealth(root: string): Promise<readonly ProjectHealthCheck[]> {
  const checks: ProjectHealthCheck[] = [];
  let expectedSession: string | undefined;

  try {
    const state = await readProjectState(root);
    expectedSession = renderSession(state);
    checks.push({ name: "state", status: "pass", detail: ".draftforge/state.json is valid" });
  } catch (error: unknown) {
    checks.push({ name: "state", status: "fail", detail: errorMessage(error) });
  }

  try {
    await loadProjectConfig(root);
    checks.push({ name: "config", status: "pass", detail: "configuration is valid" });
  } catch (error: unknown) {
    checks.push({ name: "config", status: "fail", detail: errorMessage(error) });
  }

  if (expectedSession === undefined) {
    checks.push({
      name: "handoff",
      status: "fail",
      detail: "SESSION.md cannot be checked until canonical state is valid",
    });
  } else {
    try {
      const session = await readFile(resolve(root, SESSION_PATH), "utf8");
      checks.push(
        session === expectedSession
          ? { name: "handoff", status: "pass", detail: "SESSION.md matches canonical state" }
          : {
              name: "handoff",
              status: "fail",
              detail: "SESSION.md has drifted; run `draftforge handoff`",
            },
      );
    } catch (error: unknown) {
      checks.push({ name: "handoff", status: "fail", detail: errorMessage(error) });
    }
  }

  return checks;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
