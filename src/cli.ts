#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDoctor } from "./commands/doctor.js";
import { readProjectState, writeSession } from "./state/files.js";

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
      for (const check of runDoctor()) {
        io.out(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
      }
      return 0;
    }

    case "status": {
      try {
        const state = await readProjectState(resolve(cwd));
        io.out(`${state.project.name}: ${state.workflow.phaseId} / ${state.workflow.stage} / ${state.workflow.status}`);
        io.out(`Current task: ${state.workflow.currentTask ?? "none"}`);
        io.out(`Next task: ${state.workflow.nextTask ?? "none"}`);
        return 0;
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

    case "init":
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

function helpText(): string {
  return `DraftForge ${VERSION}

Usage: draftforge <command>

Commands:
  init [directory]  Initialize a DraftForge project (Phase 1)
  doctor            Check local harnesses and API-key presence
  status            Show the canonical workflow position
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
