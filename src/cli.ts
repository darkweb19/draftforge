#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDoctor } from "./commands/doctor.js";
import { runInit, type InitOptions } from "./commands/init.js";
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

    case "plan":
    case "run":
    case "resume":
      io.error(`${command} is planned but not implemented in Phase 0.`);
      return 2;

    default:
      io.error(`Unknown command: ${command}`);
      io.out(helpText());
      return 2;
  }
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
  run               Execute ready worker tasks (Phase 4)
  resume            Resume interrupted work (Phase 4)
  handoff           Regenerate SESSION.md from canonical state
  help              Show this help
`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (entryUrl === import.meta.url) {
  process.exitCode = await main();
}
