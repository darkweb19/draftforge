import { mkdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { basename } from "node:path/posix";
import { defaultProjectConfig } from "../config/config.js";
import type { ProjectState } from "../domain/state.js";
import { readProjectState, renderSession, serializeProjectState, writeFileAtomic } from "../state/files.js";
import { createInitialProjectState, DRAFT_FILE } from "../state/initial-state.js";
import { readTemplate, renderTemplate } from "../state/templates.js";

export interface InitOptions {
  /** Target directory, relative to `cwd`. Defaults to `cwd` itself. */
  readonly directory?: string;
  /** Overwrite files that exist with different content. */
  readonly force?: boolean;
  /** Project name. Defaults to the target directory name. */
  readonly name?: string;
  readonly now?: Date;
  readonly updatedBy?: string;
}

export interface InitResult {
  readonly root: string;
  readonly projectName: string;
  /** True when the target already had valid DraftForge state. */
  readonly alreadyInitialized: boolean;
  /** Project-relative paths written by this run. */
  readonly created: readonly string[];
  /** Paths left as they were, because they already match. */
  readonly unchanged: readonly string[];
  /** Foreign files that would have been overwritten. Non-empty means nothing was written. */
  readonly conflicts: readonly string[];
}

interface PlannedFile {
  readonly path: string;
  readonly contents: string;
}

export async function runInit(cwd: string, options: InitOptions = {}): Promise<InitResult> {
  const root = resolve(cwd, options.directory ?? ".");
  await mkdir(root, { recursive: true });

  const existingState = await readExistingState(root);
  const projectName = options.name?.trim() || existingState?.project.name || directoryName(root);

  const state =
    existingState ??
    createInitialProjectState({
      projectName,
      now: options.now ?? new Date(),
      updatedBy: options.updatedBy ?? "draftforge init",
    });

  const planned = await planFiles(projectName, state);

  const created: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];

  for (const file of planned) {
    const current = await readFileOrNull(resolve(root, file.path));

    if (current === null) {
      created.push(file.path);
    } else if (current === file.contents) {
      unchanged.push(file.path);
    } else if (existingState !== null) {
      // Re-running against an initialized project only fills gaps; existing
      // files belong to that project and are never rewritten.
      unchanged.push(file.path);
    } else if (options.force === true) {
      // `--force` is the caller's explicit approval to replace foreign content.
      created.push(file.path);
    } else {
      conflicts.push(file.path);
    }
  }

  if (conflicts.length > 0) {
    return { root, projectName, alreadyInitialized: false, created: [], unchanged: [], conflicts };
  }

  const writable = new Set(created);
  for (const file of planned) {
    if (writable.has(file.path)) {
      await writeFileAtomic(resolve(root, file.path), file.contents);
    }
  }

  return {
    root,
    projectName,
    alreadyInitialized: existingState !== null,
    created,
    unchanged,
    conflicts: [],
  };
}

async function planFiles(projectName: string, state: ProjectState): Promise<readonly PlannedFile[]> {
  const values = { projectName };

  return [
    { path: ".draftforge/state.json", contents: serializeProjectState(state) },
    { path: ".draftforge/config.json", contents: `${JSON.stringify(defaultProjectConfig(), null, 2)}\n` },
    { path: ".draftforge/schema/state.schema.json", contents: await readTemplate("schema/state.schema.json") },
    { path: ".draftforge/schema/config.schema.json", contents: await readTemplate("schema/config.schema.json") },
    { path: ".draftforge/tasks/.gitkeep", contents: "" },
    { path: ".draftforge/runs/.gitkeep", contents: "" },
    { path: "SESSION.md", contents: renderSession(state) },
    { path: "AGENTS.md", contents: await renderProjectTemplate("AGENTS.md", values) },
    { path: "CLAUDE.md", contents: await renderProjectTemplate("CLAUDE.md", values) },
    { path: "PHASES.md", contents: await renderProjectTemplate("PHASES.md", values) },
    { path: DRAFT_FILE, contents: await renderProjectTemplate(DRAFT_FILE, values) },
  ];
}

async function renderProjectTemplate(
  name: string,
  values: Readonly<Record<string, string>>,
): Promise<string> {
  return renderTemplate(await readTemplate(`project/${name}`), values);
}

async function readExistingState(root: string): Promise<ProjectState | null> {
  try {
    return await readProjectState(root);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }

    throw new Error(
      `${root} contains .draftforge/state.json but it is not valid DraftForge state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function directoryName(root: string): string {
  // `basename` from the posix variant keeps the result stable once separators
  // are normalized, including for Windows drive roots such as `C:\`.
  const normalized = root.split(sep).join("/").replace(/\/+$/, "");
  const name = basename(normalized);
  return name.length > 0 ? name : "project";
}
