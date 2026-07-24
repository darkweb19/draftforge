import assert from "node:assert/strict";
import { test } from "node:test";
import { runDoctor, type DoctorProcessResult } from "../src/commands/doctor.js";
import { defaultProjectConfig, type ProjectConfig } from "../src/config/config.js";

const ok: DoctorProcessResult = {
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
};

test("doctor reports each configured role adapter and never exposes credentials", () => {
  const secret = "sk-secret-do-not-print";
  const config: ProjectConfig = {
    ...defaultProjectConfig(),
    roles: {
      architect: { adapter: "openai-api", model: "provider-default", reasoning: "high" },
      worker: {
        adapter: "claude-cli",
        model: "provider-default",
        reasoning: "medium",
        maxConcurrency: 2,
      },
      reviewer: { adapter: "openai-api", model: "provider-default", reasoning: "high" },
    },
  };
  const calls: string[] = [];
  const checks = runDoctor(config, {
    environment: { OPENAI_API_KEY: secret },
    platform: "linux",
    runProcess(command, args) {
      calls.push([command, ...args].join(" "));
      return ok;
    },
  });

  assert.deepEqual(
    checks.map(({ name, status }) => [name, status]),
    [
      ["Git", "pass"],
      ["architect adapter (openai-api)", "pass"],
      ["worker adapter (claude-cli)", "pass"],
      ["reviewer adapter (openai-api)", "pass"],
    ],
  );
  assert.deepEqual(calls, ["which git", "which claude", "claude auth status"]);
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(secret));
});

test("doctor treats absent command and authentication as missing", () => {
  const checks = runDoctor(defaultProjectConfig(), {
    environment: {},
    platform: "linux",
    runProcess(command, args) {
      if (command === "which" && args[0] === "git") {
        return ok;
      }
      if (command === "which" && args[0] === "codex") {
        return { ...ok, status: 1 };
      }
      if (command === "which" && args[0] === "claude") {
        return ok;
      }
      return { ...ok, status: 1, stderr: "Not logged in" };
    },
  });

  assert.deepEqual(
    checks.map(({ status }) => status),
    ["pass", "missing", "missing", "missing"],
  );
  assert.equal(checks.some((check) => check.status === "fail"), false);
});

test("doctor reports a genuine harness authentication error as fail", () => {
  const checks = runDoctor(defaultProjectConfig(), {
    platform: "linux",
    runProcess(command, args) {
      if (command === "which") {
        return ok;
      }
      if (command === "codex" && args.join(" ") === "login status") {
        return { ...ok, status: 2, stderr: "configuration file is invalid" };
      }
      return ok;
    },
  });

  assert.equal(checks[1]?.status, "fail");
  assert.equal(checks[3]?.status, "fail");
  assert.doesNotMatch(checks[1]?.detail ?? "", /configuration file is invalid/);
});

test("doctor treats an unrecognized authentication exit 1 as fail", () => {
  const checks = runDoctor(defaultProjectConfig(), {
    platform: "linux",
    runProcess(command, args) {
      if (command === "which") {
        return ok;
      }
      if (command === "codex" && args.join(" ") === "login status") {
        return { ...ok, status: 1, stderr: "unexpected local configuration error" };
      }
      return ok;
    },
  });

  assert.equal(checks[1]?.status, "fail");
  assert.equal(checks[3]?.status, "fail");
});
