/**
 * Command-facing upgrade API. The durable file planning and backup mechanics
 * remain in state/ so ordinary state readers cannot accidentally persist a
 * migration.
 */
export {
  runUpgrade,
  UpgradeRecoveryError,
  UpgradeRefusedError,
  type UpgradeOptions,
  type UpgradeResult,
} from "../state/upgrade.js";
