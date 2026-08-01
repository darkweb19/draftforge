# Claude Code entrypoint

Read and follow `AGENTS.md` in full.

Before doing any work, read `SESSION.md`, `.draftforge/state.json`, `PHASES.md`, and the active task file. The JSON state is canonical; `SESSION.md` is its generated handoff view.

Claude Code and Codex must use the same task status and verification rules. Do not maintain a Claude-only session file.

Explicit project upgrade orchestration lives in `src/state/upgrade.ts`, with the command boundary in `src/commands/upgrade.ts`. Ordinary state reads may migrate supported documents in memory but must never persist that migration.
