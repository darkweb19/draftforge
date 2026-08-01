import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PROJECT_STATE_SCHEMA_VERSION, assertProjectState, type ProjectState } from "../domain/state.js";
import { readExecutionAttemptManifest } from "./execution.js";
import {
  SESSION_PATH,
  STATE_PATH,
  migrateProjectState,
  readRawProjectState,
  renderSession,
  serializeProjectState,
  writeFileAtomic,
} from "./files.js";
import { withProjectLock } from "./lock.js";
import { readTemplate } from "./templates.js";

export const UPGRADE_BACKUPS_DIRECTORY = ".draftforge/backups";

export interface UpgradeOptions {
  /** Injectable only for deterministic tests and callers that record time. */
  readonly now?: Date;
  /** Test seam for a target write failure after a complete backup. */
  readonly writeAtomic?: (path: string, contents: string) => Promise<void>;
}

export interface UpgradeResult {
  readonly disposition: "current" | "upgraded";
  readonly fromVersion: number;
  readonly backupPath: string | null;
  readonly replaced: readonly string[];
  readonly created: readonly string[];
}

/** A safe precondition failure: no backup or canonical project file was written. */
export class UpgradeRefusedError extends Error {}

/** A write failed after a recovery directory was created; never report success. */
export class UpgradeRecoveryError extends Error {
  readonly backupPath: string;

  constructor(backupPath: string, cause: unknown) {
    super(
      `Upgrade did not complete. Restore replaced files from ${backupPath} and remove files listed as created in ${backupPath}/upgrade-manifest.json before retrying: ${errorMessage(cause)}`,
    );
    this.name = "UpgradeRecoveryError";
    this.backupPath = backupPath;
  }
}

interface PlannedReplacement {
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
}

const MANAGED_SCHEMA_PATHS = [
  "state.schema.json",
  "config.schema.json",
  "planning.schema.json",
  "execution.schema.json",
] as const;

// These hashes are exact bytes from each previously shipped schema artifact.
// A project schema can be refreshed only when it is recognizable as one of
// those artifacts (or exactly matches the installed template).
const KNOWN_SCHEMA_HASHES: Readonly<Record<(typeof MANAGED_SCHEMA_PATHS)[number], readonly string[]>> = {
  "state.schema.json": [
    "3d67a6ca413f7b69d39eb677f7f25a18b510f34fc04e4de4dae26ee0e533a7a1",
    "ff63ee6b156d9271f5493d40f054810fc397353debac380fd2e58cf7d698bb42",
    "7930190643e2bdbd6ca739461031310c99284ef00b3793899278f04f4f46d32e",
  ],
  "config.schema.json": ["2ee9e6d4b9ae686a3b059c3b22b41c7d16fd305cf4a30f3395955fc6b2d214b7"],
  "planning.schema.json": [
    "852f51c04adbe34e87d2a9a5165734b65af2e67a5d784b809b6b2ec0e302b60e",
    "541e7b261fb31854680ec40df7539110f7cf5cb92b009ef213e0c457bd110b06",
    "5aa9b2f450571029651913d4fe5cb1f80655726ca097e477b1eaac2d56304e41",
  ],
  "execution.schema.json": [
    "4a3dbf9420a7fad84db7a4bb8e7ab82d47220abce94b0148c165b7b57eefe0a2",
    "db9623407908249583be24f648c780592fa622de4a664fa4966a4326c05b93c6",
  ],
};

/**
 * Persists the supported state migration only after every candidate output and
 * recovery precondition is known safe. Regular reads intentionally keep using
 * the in-memory migration in files.ts and never call this operation.
 */
export async function runUpgrade(root: string, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  let projectRoot: string;
  try {
    // A caller may intentionally point at a symlinked project root. Canonicalize
    // that one boundary, then reject symlinks below it before any project I/O.
    projectRoot = await realpath(resolve(root));
  } catch (error: unknown) {
    throw new UpgradeRefusedError(`Unable to resolve project root for upgrade: ${errorMessage(error)}`);
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new UpgradeRefusedError("Upgrade timestamp must be a valid date.");
  }

  return withProjectLock(projectRoot, "project upgrade", async () => {
    await assertUpgradeFilesystemSafe(projectRoot);
    const raw = await readRawProjectState(projectRoot);
    const fromVersion = rawSchemaVersion(raw);
    if (fromVersion > PROJECT_STATE_SCHEMA_VERSION) {
      throw new UpgradeRefusedError(
        `Project state schema version ${fromVersion} is newer than this DraftForge installation (${PROJECT_STATE_SCHEMA_VERSION}); upgrade this CLI instead.`,
      );
    }
    if (fromVersion < 1) {
      throw new UpgradeRefusedError(`Project state schema version ${fromVersion} cannot be upgraded by this DraftForge installation.`);
    }

    const candidate = migrateProjectState(raw);
    assertProjectState(candidate);
    await assertNoUnsafeRecovery(projectRoot, candidate);

    const plan = await buildReplacementPlan(
      projectRoot,
      candidate,
      fromVersion !== PROJECT_STATE_SCHEMA_VERSION,
    );
    const replacements = plan.filter((entry) => entry.before !== entry.after);
    if (replacements.length === 0) {
      return { disposition: "current", fromVersion, backupPath: null, replaced: [], created: [] };
    }

    // Recheck just before mutable operations; planning must not authorize a
    // subsequently redirected managed path.
    await assertUpgradeFilesystemSafe(projectRoot);
    const backupPath = await createBackup(projectRoot, replacements, now);
    try {
      for (const replacement of orderTargetWrites(replacements)) {
        await assertTargetWriteSafe(projectRoot, replacement);
        await (options.writeAtomic ?? writeFileAtomic)(
          resolveWithinProject(projectRoot, replacement.path),
          replacement.after,
        );
      }
    } catch (error: unknown) {
      throw new UpgradeRecoveryError(backupPath, error);
    }

    return {
      disposition: "upgraded",
      fromVersion,
      backupPath,
      replaced: replacements.filter((entry) => entry.before !== null).map((entry) => entry.path),
      created: replacements.filter((entry) => entry.before === null).map((entry) => entry.path),
    };
  });
}

async function buildReplacementPlan(
  root: string,
  state: ProjectState,
  persistState: boolean,
): Promise<readonly PlannedReplacement[]> {
  const planned: PlannedReplacement[] = persistState
    ? [
        {
          path: STATE_PATH,
          before: await readOptional(root, STATE_PATH),
          after: serializeProjectState(state),
        },
        {
          path: SESSION_PATH,
          before: await readOptional(root, SESSION_PATH),
          after: renderSession(state),
        },
      ]
    : [];

  for (const filename of MANAGED_SCHEMA_PATHS) {
    const path = `.draftforge/schema/${filename}`;
    const before = await readOptional(root, path);
    const after = await readTemplate(`schema/${filename}`);
    if (before !== null && before !== after && !KNOWN_SCHEMA_HASHES[filename].includes(hash(before))) {
      throw new UpgradeRefusedError(
        `Refusing to overwrite modified or unrecognized DraftForge schema: ${path}. Restore a shipped schema or preserve your change before upgrading.`,
      );
    }
    planned.push({ path, before, after });
  }
  return planned;
}

async function createBackup(
  root: string,
  replacements: readonly PlannedReplacement[],
  now: Date,
): Promise<string> {
  const timestamp = now.toISOString().replaceAll(/[^0-9A-Za-z]/gu, "");
  const backupPath = `${UPGRADE_BACKUPS_DIRECTORY}/${timestamp}-${randomBytes(4).toString("hex")}`;
  const backupRoot = resolveWithinProject(root, backupPath);
  try {
    // Do not merge with a same-named existing backup: a collision must fail
    // before target mutation rather than silently replacing recovery evidence.
    await assertUpgradeFilesystemSafe(root);
    await mkdir(resolveWithinProject(root, UPGRADE_BACKUPS_DIRECTORY), { recursive: true });
    await assertExistingPath(root, UPGRADE_BACKUPS_DIRECTORY, "directory", true);
    await mkdir(backupRoot);
    for (const replacement of replacements) {
      if (replacement.before === null) continue;
      // backupRoot was created exclusively above (no collision is accepted),
      // so its nested parents cannot pre-exist as redirecting symlinks.
      await writeFileAtomic(resolveWithinProject(backupRoot, replacement.path), replacement.before);
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: now.toISOString(),
      replaced: replacements.filter((entry) => entry.before !== null).map((entry) => entry.path),
      created: replacements.filter((entry) => entry.before === null).map((entry) => entry.path),
    };
    await writeFileAtomic(
      resolveWithinProject(backupRoot, "upgrade-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } catch (error: unknown) {
    throw new Error(`Unable to create a complete upgrade backup at ${backupPath}: ${errorMessage(error)}`);
  }
  return backupPath;
}

async function assertNoUnsafeRecovery(root: string, state: ProjectState): Promise<void> {
  const liveTasks = state.tasks.filter((task) => task.status === "active" || task.status === "review");
  if (liveTasks.length > 0) {
    throw new UpgradeRefusedError(`Refusing upgrade while task work is in flight: ${liveTasks.map((task) => task.id).join(", ")}.`);
  }

  const runsRoot = resolve(root, ".draftforge/runs");
  const runsExists = await assertExistingAbsolutePath(runsRoot, "directory", false, ".draftforge/runs");
  if (!runsExists) return;
  let runDirectories: readonly string[];
  try {
    const entries = await readdir(runsRoot, { withFileTypes: true });
    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".gitkeep") {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new UpgradeRefusedError("Refusing upgrade because .draftforge/runs/.gitkeep is not a regular file.");
        }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new UpgradeRefusedError(`Refusing upgrade because recovery run entry is not a real directory: .draftforge/runs/${entry.name}.`);
      }
      directories.push(entry.name);
    }
    runDirectories = directories;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return;
    throw new UpgradeRefusedError(`Unable to inspect recovery artifacts before upgrade: ${errorMessage(error)}`);
  }

  for (const runId of runDirectories) {
    const attemptsRoot = resolve(runsRoot, runId, "attempts");
    const attemptsExists = await assertExistingAbsolutePath(
      attemptsRoot,
      "directory",
      false,
      `.draftforge/runs/${runId}/attempts`,
    );
    if (!attemptsExists) continue;
    let entries: readonly string[];
    try {
      entries = (await readdir(attemptsRoot, { withFileTypes: true })).map((entry) => {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new UpgradeRefusedError(`Refusing upgrade because recovery attempt entry is not a regular file: .draftforge/runs/${runId}/attempts/${entry.name}.`);
        }
        return entry.name;
      });
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) continue;
      throw new UpgradeRefusedError(`Unable to inspect recovery artifacts before upgrade: ${errorMessage(error)}`);
    }

    for (const entry of entries) {
      if (entry.endsWith(".review-lease.json")) {
        throw new UpgradeRefusedError(`Refusing upgrade while reviewer lease artifact remains: .draftforge/runs/${runId}/attempts/${entry}.`);
      }
    }

    const manifests = new Map<string, Awaited<ReturnType<typeof readExecutionAttemptManifest>>>();
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".result.json") || entry.endsWith(".review-lease.json") || entry.endsWith(".integration-intent.json")) {
        continue;
      }
      const attemptId = entry.slice(0, -".json".length);
      let manifest: Awaited<ReturnType<typeof readExecutionAttemptManifest>>;
      try {
        manifest = await readExecutionAttemptManifest(root, { runId, attemptId });
      } catch (error: unknown) {
        throw new UpgradeRefusedError(`Refusing upgrade because recovery artifact is not a valid attempt manifest: .draftforge/runs/${runId}/attempts/${entry} (${errorMessage(error)}).`);
      }
      const terminal = manifest.lifecycle === "blocked" || manifest.lifecycle === "integrated";
      if (!terminal) {
        throw new UpgradeRefusedError(`Refusing upgrade while attempt ${runId}/${attemptId} is ${manifest.lifecycle}.`);
      }
      manifests.set(attemptId, manifest);
      await assertNoLiveUncertainWorker(root, runId, attemptId, terminal);
    }

    for (const entry of entries) {
      const attemptId = attemptIdForArtifact(entry);
      if (attemptId !== null && !manifests.has(attemptId)) {
        throw new UpgradeRefusedError(`Refusing upgrade because recovery artifact has no valid matching manifest: .draftforge/runs/${runId}/attempts/${entry}.`);
      }
    }

    for (const entry of entries.filter((name) => name.endsWith(".integration-intent.json"))) {
      const attemptId = entry.slice(0, -".integration-intent.json".length);
      const manifest = manifests.get(attemptId);
      if (manifest === undefined || (manifest.lifecycle !== "blocked" && manifest.lifecycle !== "integrated")) {
        throw new UpgradeRefusedError(`Refusing upgrade because integration recovery artifact is not terminal: .draftforge/runs/${runId}/attempts/${entry}.`);
      }
      const intent = await readOptionalAbsolute(resolve(attemptsRoot, entry));
      if (intent === null || !isRecord(parseJsonOrNull(intent))) {
        throw new UpgradeRefusedError(`Refusing upgrade because integration recovery artifact is malformed: .draftforge/runs/${runId}/attempts/${entry}.`);
      }
    }
  }
}

async function assertNoLiveUncertainWorker(root: string, runId: string, attemptId: string, terminal: boolean): Promise<void> {
  const eventPath = resolve(root, ".draftforge/runs", runId, "attempts", `${attemptId}.events.jsonl`);
  const events = await readOptionalAbsolute(eventPath);
  if (events === null) return;
  for (const line of events.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new UpgradeRefusedError(`Refusing upgrade because attempt ${runId}/${attemptId} has malformed recovery events.`);
    }
    const processId = uncertainWorkerProcessId(event);
    if (processId === null) continue;
    const liveness = processLiveness(processId);
    if (liveness !== "not-found" || !terminal) {
      throw new UpgradeRefusedError(`Refusing upgrade while uncertain worker process ${processId} for attempt ${runId}/${attemptId} is ${liveness}.`);
    }
  }
}

function uncertainWorkerProcessId(value: unknown): number | null {
  if (!isRecord(value) || value.type !== "worker.termination-uncertain" || !isRecord(value.data) || !isRecord(value.data.termination)) return null;
  const processId = value.data.termination.processId;
  return typeof processId === "number" && Number.isInteger(processId) && processId > 0 ? processId : null;
}

function processLiveness(processId: number): "live" | "not-found" | "indeterminate" {
  try {
    process.kill(processId, 0);
    return "live";
  } catch (error: unknown) {
    return hasCode(error, "ESRCH") ? "not-found" : "indeterminate";
  }
}

function rawSchemaVersion(value: unknown): number {
  if (!isRecord(value) || typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    throw new UpgradeRefusedError("Project state must contain an integer schemaVersion before it can be upgraded.");
  }
  return value.schemaVersion;
}

async function readOptional(root: string, projectPath: string): Promise<string | null> {
  return readOptionalAbsolute(resolveWithinProject(root, projectPath));
}

async function readOptionalAbsolute(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function resolveWithinProject(root: string, projectPath: string): string {
  const resolvedRoot = resolve(root);
  const output = resolve(resolvedRoot, projectPath);
  const pathFromRoot = relative(resolvedRoot, output);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith("../")) {
    throw new Error(`Upgrade path must stay inside the project: ${projectPath}.`);
  }
  return output;
}

async function assertUpgradeFilesystemSafe(root: string): Promise<void> {
  await assertExistingPath(root, ".draftforge", "directory", true);
  await assertExistingPath(root, ".draftforge/schema", "directory", true);
  await assertExistingPath(root, UPGRADE_BACKUPS_DIRECTORY, "directory", false);
  await assertExistingPath(root, STATE_PATH, "file", true);
  await assertExistingPath(root, SESSION_PATH, "file", false);
  for (const filename of MANAGED_SCHEMA_PATHS) {
    await assertExistingPath(root, `.draftforge/schema/${filename}`, "file", false);
  }
}

async function assertTargetWriteSafe(root: string, replacement: PlannedReplacement): Promise<void> {
  const path = resolveWithinProject(root, replacement.path);
  const parent = resolve(path, "..");
  await assertExistingAbsolutePath(parent, "directory", true, replacement.path);
  const exists = await assertExistingAbsolutePath(path, "file", false, replacement.path);
  if (replacement.before === null) {
    if (exists) {
      throw new Error(`Upgrade target appeared after planning: ${replacement.path}.`);
    }
    return;
  }
  if (!exists) {
    throw new Error(`Upgrade target disappeared after planning: ${replacement.path}.`);
  }
  const current = await readFile(path, "utf8");
  if (current !== replacement.before) {
    throw new Error(`Upgrade target changed after planning: ${replacement.path}.`);
  }
}

async function assertExistingPath(
  root: string,
  projectPath: string,
  type: "directory" | "file",
  required: boolean,
): Promise<boolean> {
  return assertExistingAbsolutePath(resolveWithinProject(root, projectPath), type, required, projectPath);
}

async function assertExistingAbsolutePath(
  path: string,
  type: "directory" | "file",
  required: boolean,
  displayPath: string,
): Promise<boolean> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT") && !required) return false;
    throw new UpgradeRefusedError(`Refusing upgrade because ${displayPath} cannot be safely inspected: ${errorMessage(error)}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new UpgradeRefusedError(`Refusing upgrade because ${displayPath} is a symbolic link.`);
  }
  if ((type === "directory" && !metadata.isDirectory()) || (type === "file" && !metadata.isFile())) {
    throw new UpgradeRefusedError(`Refusing upgrade because ${displayPath} is not a regular ${type}.`);
  }
  return true;
}

function hash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * The canonical schema version is the durable commit marker. If an earlier
 * replacement fails, leaving it old makes a later explicit retry re-plan the
 * whole upgrade from the retained backup rather than reporting a false no-op.
 */
function orderTargetWrites(replacements: readonly PlannedReplacement[]): readonly PlannedReplacement[] {
  return [...replacements].sort((left, right) => writePriority(left.path) - writePriority(right.path));
}

function writePriority(path: string): number {
  if (path.startsWith(".draftforge/schema/")) return 0;
  if (path === SESSION_PATH) return 1;
  if (path === STATE_PATH) return 2;
  return 0;
}

function parseJsonOrNull(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return null;
  }
}

function attemptIdForArtifact(entry: string): string | null {
  for (const suffix of [".events.jsonl", ".result.json", ".review-lease.json", ".integration-intent.json"] as const) {
    if (entry.endsWith(suffix)) return entry.slice(0, -suffix.length);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
