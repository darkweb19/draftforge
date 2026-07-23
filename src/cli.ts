#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDoctor } from "./commands/doctor.js";
import { runInit, type InitOptions } from "./commands/init.js";
import { runPlan, type PlanOptions, type PlanResult } from "./commands/plan.js";
import { readProjectState, writeSession } from "./state/files.js";
import { inspectProjectHealth } from "./state/health.js";

const VERSION = "0.0.0";

export interface CliIo {
  readonly out: (message: string) => void;
  readonly error: (message: string) => void;
}

const consoleIo: CliIo = {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
};

export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = consoleIo,
  cwd: string = process.cwd(),
): Promise<number> {
  const [command] = args;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(helpText());
      return 0;

    case "--version":
    case "-v":
      io.out(VERSION);
      return 0;

    case "doctor": {
      const checks = [...runDoctor(), ...(await inspectProjectHealth(resolve(cwd)))];
      for (const check of checks) {
        io.out(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
      }
      return checks.some((check) => check.status === "fail") ? 1 : 0;
    }

    case "status": {
      try {
        const state = await readProjectState(resolve(cwd));
        io.out(`${state.project.name}: ${state.workflow.phaseId} / ${state.workflow.stage} / ${state.workflow.status}`);
        io.out(`Current task: ${state.workflow.currentTask ?? "none"}`);
        io.out(`Next task: ${state.workflow.nextTask ?? "none"}`);
        const checks = await inspectProjectHealth(resolve(cwd));
        for (const check of checks) {
          io.out(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
        }
        return checks.some((check) => check.status === "fail") ? 1 : 0;
      } catch (error: unknown) {
        io.error(toErrorMessage(error));
        return 1;
      }
    }

    case "handoff": {
      try {
        const root = resolve(cwd);
        const state = await readProjectState(root);
        await writeSession(root, state);
        io.out("SESSION.md rendered from .draftforge/state.json");
        return 0;
      } catch (error: unknown) {
        io.error(toErrorMessage(error));
        return 1;
      }
    }

    case "init": {
      try {
        return await runInitCommand(args.slice(1), io, cwd);
      } catch (error: unknown) {
        io.error(toErrorMessage(error));
        return 1;
      }
    }

    case "plan": {
      try {
        return await runPlanCommand(args.slice(1), io, cwd);
      } catch (error: unknown) {
        io.error(toErrorMessage(error));
        return error instanceof CliUsageError ? 2 : 1;
      }
    }

    case "run":
    case "resume":
      io.error(`${command} is planned but not implemented until Phase 4.`);
      return 2;

    default:
      io.error(`Unknown command: ${command}`);
      io.out(helpText());
      return 2;
  }
}

async function runPlanCommand(args: readonly string[], io: CliIo, cwd: string): Promise<number> {
  const result = await runPlan(resolve(cwd), parsePlanArgs(args));

  if (result.mode === "start") {
    io.out(
      result.resumed
        ? `Resuming planning revision ${result.artifact.revision} from ${result.artifact.sourceFile}.`
        : `Initialized planning revision ${result.artifact.revision} from ${result.artifact.sourceFile}.`,
    );
    io.out("No provider was called. Next: `draftforge plan --prompt`.");
    return 0;
  }

  if (result.mode === "status") {
    printPlanningStatus(result, io);
    return 0;
  }

  if (result.mode === "prompt") {
    io.out(`# System`);
    io.out(result.request.system);
    io.out("");
    io.out(`# User`);
    io.out(result.request.user);
    return 0;
  }

  if (result.mode === "submit") {
    io.out(
      result.applied === "questions"
        ? `Recorded ${result.artifact.questions.items.length} architect question(s) for revision ${result.artifact.revision}.`
        : `Recorded a draft plan for revision ${result.artifact.revision}.`,
    );
    io.out(
      result.applied === "questions"
        ? "Next: answer them with `draftforge plan --answer <id>=<text>`."
        : "Next: `draftforge plan --approve --by <actor>`.",
    );
    return 0;
  }

  if (result.mode === "answer") {
    const remaining = result.artifact.questions.items.filter(
      (question) => question.blocking && question.answer === null,
    ).length;
    io.out(`Recorded answers: ${result.answeredIds.join(", ")}.`);
    io.out(`Blocking questions remaining: ${remaining}.`);
    return 0;
  }

  io.out(
    `Approved planning revision ${result.artifact.revision}. Ready tasks: ${
      result.readyTaskIds.length === 0 ? "none" : result.readyTaskIds.join(", ")
    }.`,
  );
  return 0;
}

const PLAN_USAGE = [
  "Usage: draftforge plan <idea.md>",
  "       draftforge plan --status",
  "       draftforge plan --prompt",
  "       draftforge plan --submit <response.json>",
  "       draftforge plan --answer <id>=<text> [--answer <id>=<text> ...]",
  "       draftforge plan --approve --by <actor>",
].join("\n");

function parsePlanArgs(args: readonly string[]): PlanOptions {
  if (args.length === 1 && args[0] !== undefined && !args[0].startsWith("--")) {
    return { mode: "start", sourceFile: args[0] };
  }

  let mode: "status" | "prompt" | "submit" | "answer" | "approve" | undefined;
  let responseFile: string | undefined;
  let approvedBy: string | undefined;
  const answers: Record<string, string> = {};

  const claimMode = (next: NonNullable<typeof mode>): void => {
    if (mode !== undefined && mode !== next) {
      throw new CliUsageError(`plan --${mode} cannot be combined with --${next}.`);
    }
    mode = next;
  };
  const requireValue = (arg: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${arg} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--status") {
      claimMode("status");
    } else if (arg === "--prompt") {
      claimMode("prompt");
    } else if (arg === "--approve") {
      claimMode("approve");
    } else if (arg === "--submit") {
      claimMode("submit");
      responseFile = requireValue(arg, args[index + 1]);
      index += 1;
    } else if (arg === "--answer") {
      claimMode("answer");
      const [questionId, ...rest] = requireValue(arg, args[index + 1]).split("=");
      if (questionId === undefined || questionId.length === 0 || rest.length === 0) {
        throw new CliUsageError("--answer requires <id>=<text>.");
      }
      const answer = rest.join("=");
      if (answer.trim().length === 0) {
        throw new CliUsageError(`--answer ${questionId} requires non-empty text.`);
      }
      if (questionId in answers) {
        throw new CliUsageError(`--answer ${questionId} was given more than once.`);
      }
      answers[questionId] = answer;
      index += 1;
    } else if (arg === "--by") {
      approvedBy = requireValue(arg, args[index + 1]);
      index += 1;
    } else {
      throw new CliUsageError(`Unknown plan option: ${arg}`);
    }
  }

  if (approvedBy !== undefined && mode !== "approve") {
    throw new CliUsageError("--by is only valid with --approve.");
  }

  switch (mode) {
    case "status":
      return { mode: "status" };
    case "prompt":
      return { mode: "prompt" };
    case "submit":
      return { mode: "submit", responseFile: responseFile as string };
    case "answer":
      return { mode: "answer", answers };
    case "approve":
      if (approvedBy === undefined || approvedBy.trim().length === 0) {
        throw new CliUsageError("Plan approval requires --by <actor>.");
      }
      return { mode: "approve", approvedBy };
    default:
      throw new CliUsageError(PLAN_USAGE);
  }
}

function printPlanningStatus(result: Extract<PlanResult, { readonly mode: "status" }>, io: CliIo): void {
  const questions = result.artifact.questions.items;
  const answered = questions.filter((question) => question.answer !== null).length;
  const blocking = questions.filter(
    (question) => question.blocking && question.answer === null,
  ).length;

  io.out(`Planning revision: ${result.artifact.revision}`);
  io.out(`Source: ${result.artifact.sourceFile}`);
  io.out(`Status: ${result.artifact.status}`);
  io.out(`Questions: ${answered}/${questions.length} answered; ${blocking} blocking unanswered`);
  io.out(`Plan: ${result.artifact.plan === null ? "missing" : "present"}`);
  io.out(
    `Approval: ${
      result.artifact.approval === null
        ? "not approved"
        : `approved by ${result.artifact.approval.approvedBy}`
    }`,
  );
}

async function runInitCommand(args: readonly string[], io: CliIo, cwd: string): Promise<number> {
  const options = parseInitArgs(args);
  const result = await runInit(cwd, options);

  if (result.conflicts.length > 0) {
    io.error(`Refusing to overwrite existing files in ${result.root}:`);
    for (const path of result.conflicts) {
      io.error(`  ${path}`);
    }
    io.error("Move or remove them, initialize an empty directory, or re-run with --force.");
    return 1;
  }

  for (const path of result.created) {
    io.out(`created  ${path}`);
  }
  for (const path of result.unchanged) {
    io.out(`skipped  ${path}`);
  }

  if (result.alreadyInitialized) {
    io.out(`${result.projectName} is already initialized at ${result.root}.`);
  } else {
    io.out(`Initialized ${result.projectName} at ${result.root}.`);
  }

  io.out("Next: describe the project in idea.md, then run `draftforge plan idea.md`.");
  return 0;
}

function parseInitArgs(args: readonly string[]): InitOptions {
  let directory: string | undefined;
  let name: string | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--force") {
      force = true;
    } else if (arg === "--name") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--name requires a value.");
      }
      name = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown init option: ${arg}`);
    } else if (directory === undefined) {
      directory = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    ...(directory === undefined ? {} : { directory }),
    ...(name === undefined ? {} : { name }),
    force,
  };
}

function helpText(): string {
  return `DraftForge ${VERSION}

Usage: draftforge <command>

Commands:
  init [directory]  Initialize a DraftForge project
                      --name <name>  Project name (default: directory name)
                      --force        Overwrite conflicting existing files
  doctor            Check project health, harnesses, and API-key presence
  status            Show workflow position and project health
  plan <idea.md>    Run the architecture interview (Phase 2)
  plan --status     Show resumable planning progress
  plan --prompt     Print the architect prompt for the current planning stage
  plan --submit <file>
                    Apply a recorded architect response (questions or plan)
  plan --answer <id>=<text>
                    Record an interview answer; repeatable
  plan --approve    Approve the current valid plan
                      --by <actor>  Required approval identity
  run               Execute ready worker tasks (Phase 4)
  resume            Resume interrupted work (Phase 4)
  handoff           Regenerate SESSION.md from canonical state
  help              Show this help
`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CliUsageError extends Error {}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (entryUrl === import.meta.url) {
  process.exitCode = await main();
}
