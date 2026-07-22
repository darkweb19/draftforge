import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { readProjectState } from "../src/state/files.js";
import { inspectProjectHealth } from "../src/state/health.js";
import { applyTaskTransition, transitionTask } from "../src/state/transitions.js";
import { withProjectFixture } from "./helpers/fixtures.js";

test("accepts protocol transitions and appends redacted events", async () => {
  await withProjectFixture("resumed", async (root) => {
    const eventPath = resolve(root, ".draftforge/runs/run-01/events.jsonl");

    await applyTaskTransition(root, {
      taskId: "P01-T02",
      to: "active",
      runId: "run-01",
      actor: "worker",
      now: new Date("2026-01-03T00:00:00.000Z"),
      metadata: {
        apiKey: "never-log-this",
        note: "Authorization: Bearer abc.def.secret",
        nested: { password: "also-secret" },
      },
    });
    const firstAppend = await readFile(eventPath, "utf8");

    await applyTaskTransition(root, {
      taskId: "P01-T02",
      to: "review",
      runId: "run-01",
      actor: "reviewer",
      now: new Date("2026-01-03T00:01:00.000Z"),
    });
    await applyTaskTransition(root, {
      taskId: "P01-T02",
      to: "done",
      runId: "run-01",
      actor: "reviewer",
      now: new Date("2026-01-03T00:02:00.000Z"),
    });

    const state = await readProjectState(root);
    assert.equal(state.tasks.find((task) => task.id === "P01-T02")?.status, "done");
    assert.equal(state.workflow.currentTask, null);
    assert.ok((await inspectProjectHealth(root)).every((check) => check.status === "pass"));

    const completeLog = await readFile(eventPath, "utf8");
    assert.ok(completeLog.startsWith(firstAppend), "later appends must preserve the prior event bytes");
    const events = completeLog.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
    assert.equal(events.length, 3);
    assert.doesNotMatch(completeLog, /never-log-this|abc\.def\.secret|also-secret/);
    assert.match(completeLog, /\[REDACTED\]/);
  });
});

test("rejects illegal transitions before writing state or events", async () => {
  await withProjectFixture("resumed", async (root) => {
    const before = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    await assert.rejects(
      applyTaskTransition(root, {
        taskId: "P01-T02",
        to: "done",
        runId: "run-invalid",
        actor: "test",
      }),
      /Illegal task transition.*ready -> done/,
    );
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), before);
    await assert.rejects(readFile(resolve(root, ".draftforge/runs/run-invalid/events.jsonl"), "utf8"));
  });
});

test("does not ready a backlog task until every dependency is done", async () => {
  await withProjectFixture("resumed", async (root) => {
    const state = await readProjectState(root);
    const blockedByDependency = {
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === "P01-T01" ? { ...task, status: "active" as const } : { ...task, status: "backlog" as const },
      ),
      workflow: { ...state.workflow, currentTask: "P01-T01", nextTask: null },
    };
    assert.throws(
      () => transitionTask(blockedByDependency, "P01-T02", "ready"),
      /dependencies are done: P01-T01/,
    );
  });
});

test("rejects run IDs that could escape the run directory", async () => {
  await withProjectFixture("resumed", async (root) => {
    await assert.rejects(
      applyTaskTransition(root, {
        taskId: "P01-T02",
        to: "active",
        runId: "../outside",
        actor: "test",
      }),
      /runId must contain only/,
    );
  });
});

test("serializes concurrent transitions so an update cannot be lost", async () => {
  await withProjectFixture("resumed", async (root) => {
    const attempts = await Promise.allSettled([
      applyTaskTransition(root, {
        taskId: "P01-T02",
        to: "active",
        runId: "run-concurrent-a",
        actor: "worker-a",
      }),
      applyTaskTransition(root, {
        taskId: "P01-T02",
        to: "active",
        runId: "run-concurrent-b",
        actor: "worker-b",
      }),
    ]);

    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.equal((await readProjectState(root)).tasks.find((task) => task.id === "P01-T02")?.status, "active");
  });
});
