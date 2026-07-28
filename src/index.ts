export { main, type CliIo } from "./cli.js";
export { runDoctor, type DoctorCheck } from "./commands/doctor.js";
export { runInit, type InitOptions, type InitResult } from "./commands/init.js";
export {
  DEFAULT_RUN_ACTOR,
  renderExecutionSummary,
  runExecution,
  type RunDependencies,
  type RunOptions,
  type RunResult,
} from "./commands/run.js";
export {
  ExecutionRefusedError,
  executeProject,
  executionDidWork,
  executionExitCode,
  type DeferralReason,
  type DeferredTaskRecord,
  type ExecutionInput,
  type ExecutionMode,
  type ExecutionSummary,
  type TaskDisposition,
  type TaskExecutionRecord,
} from "./application/execution.js";
export {
  assertProjectConfig,
  CONFIG_PATH,
  defaultProjectConfig,
  loadProjectConfig,
  LOCAL_CONFIG_PATH,
  type AdapterId,
  type ProjectConfig,
  type ReasoningLevel,
  type RoleConfig,
  type WorkerRoleConfig,
} from "./config/config.js";
export {
  PROJECT_STATE_SCHEMA_VERSION,
  assertProjectState,
  type PhaseState,
  type ProjectState,
  type TaskState,
  type TaskStatus,
  type WorkflowStatus,
} from "./domain/state.js";
export {
  readProjectState,
  renderSession,
  serializeProjectState,
  writeFileAtomic,
  writeProjectState,
  writeSession,
} from "./state/files.js";
export { appendRunEvent, redactForLog, REDACTED_VALUE, type RunEvent } from "./state/events.js";
export { inspectProjectHealth, type ProjectHealthCheck } from "./state/health.js";
export {
  applyTaskTransition,
  transitionTask,
  type TaskTransitionInput,
} from "./state/transitions.js";
export { DRAFT_FILE, createInitialProjectState } from "./state/initial-state.js";
