import assert from "node:assert/strict";
import { test } from "node:test";
import { runDoctor } from "../../src/commands/doctor.js";
import { defaultProjectConfig, type ProjectConfig } from "../../src/config/config.js";
import { createClaudeCliAdapter } from "../../src/providers/harness/claude-cli.js";
import { createCodexCliAdapter } from "../../src/providers/harness/codex-cli.js";
import type { ModelAdapter } from "../../src/providers/adapter.js";

const LIVE_ENABLED = process.env.DRAFTFORGE_LIVE_SMOKE === "1";

for (const smoke of [
  {
    name: "Codex CLI live smoke",
    adapterId: "codex-cli",
    create: createCodexCliAdapter,
  },
  {
    name: "Claude Code live smoke",
    adapterId: "claude-cli",
    create: createClaudeCliAdapter,
  },
] as const) {
  test(smoke.name, { timeout: 120_000 }, async (context) => {
    if (!LIVE_ENABLED) {
      context.skip("requires DRAFTFORGE_LIVE_SMOKE=1");
      return;
    }
    if (!harnessAuthenticated(smoke.adapterId)) {
      context.skip(`${smoke.adapterId} command or local authentication is absent`);
      return;
    }
    await assertLiveResponse(smoke.create());
  });
}

function harnessAuthenticated(adapterId: "codex-cli" | "claude-cli"): boolean {
  const base = defaultProjectConfig();
  const config: ProjectConfig = {
    ...base,
    roles: {
      architect: { ...base.roles.architect, adapter: adapterId },
      worker: { ...base.roles.worker, adapter: adapterId },
      reviewer: { ...base.roles.reviewer, adapter: adapterId },
    },
  };
  const check = runDoctor(config).find(({ name }) => name.startsWith("architect adapter"));
  return check?.status === "pass";
}

async function assertLiveResponse(adapter: ModelAdapter): Promise<void> {
  const response = await adapter.run({
    role: "architect",
    model: "provider-default",
    reasoning: "low",
    system: "This is a DraftForge provider connectivity smoke test.",
    user: "Reply with the single word ok.",
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.text.trim().length > 0);
}
