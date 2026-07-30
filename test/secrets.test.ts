import assert from "node:assert/strict";
import { test } from "node:test";
import { scanForSecrets } from "../src/application/secrets.js";
import type { SecretFinding } from "../src/domain/execution.js";

const NOW = new Date("2026-07-29T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Test helpers. Every "secret" below is an obviously synthetic, structurally
// valid-shaped credential (never a value that could be mistaken for a live
// one) used only to exercise detection rules and the value-never-escapes
// invariant. Nothing here is printed to stdout on a passing run, and failure
// messages never interpolate the planted value or a substring of it.
// ---------------------------------------------------------------------------

function singleAddedLineDiff(path: string, content: string, newLine = 1): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +${String(newLine)},1 @@`,
    `+${content}`,
    "",
  ].join("\n");
}

/** Asserts the value-never-escapes invariant for every finding produced. */
function assertNeverEscapes(secretValue: string, ...serializableThings: unknown[]): void {
  for (const thing of serializableThings) {
    const serialized = JSON.stringify(thing) ?? "";
    assert.equal(serialized.includes(secretValue), false, "planted secret value leaked into serialized output");
    for (let start = 0; start + 8 <= secretValue.length; start += 1) {
      const chunk = secretValue.slice(start, start + 8);
      assert.equal(serialized.includes(chunk), false, "an 8+ char substring of the planted secret leaked");
    }
  }
}

function assertFindingShape(finding: SecretFinding): void {
  assert.deepEqual(Object.keys(finding).sort(), ["line", "path", "ruleId"]);
}

// ---------------------------------------------------------------------------
// Per-rule detection on planted synthetic credentials
// ---------------------------------------------------------------------------

interface RuleCase {
  readonly name: string;
  readonly ruleId: string;
  readonly secretValue: string;
  readonly line: string;
}

const AKIA_VALUE = "AKIA" + "ABCD1234EFGH5678"; // 4 + 16 chars, synthetic
const AWS_SECRET_VALUE = "A".repeat(40); // synthetic 40-char base64-shaped value
const GOOGLE_KEY_VALUE = "AIza" + "A".repeat(35);
const ANTHROPIC_KEY_VALUE = "sk-ant-" + "A".repeat(20);
const OPENAI_KEY_VALUE = "sk-" + "B".repeat(25);
const GITHUB_TOKEN_VALUE = "ghp_" + "C".repeat(25);
const SLACK_TOKEN_VALUE = "xoxb-" + "D".repeat(15);
const BEARER_TOKEN_VALUE = "E".repeat(30);
const CREDENTIAL_VALUE = "correcthorsebatterystaple9";
const HIGH_ENTROPY_VALUE = "qX7vB9zP2mK8wL4nR6tY1sD3fG5hJ0cA"; // 32 distinct chars, no key-name context

const RULE_CASES: readonly RuleCase[] = [
  {
    name: "private key block header",
    ruleId: "private-key-block",
    secretValue: "-----BEGIN PRIVATE KEY-----",
    line: "-----BEGIN PRIVATE KEY-----",
  },
  {
    name: "AWS access key id",
    ruleId: "aws-access-key-id",
    secretValue: AKIA_VALUE,
    line: `access_key_id = ${AKIA_VALUE}`,
  },
  {
    name: "AWS secret access key assignment",
    ruleId: "aws-secret-access-key",
    secretValue: AWS_SECRET_VALUE,
    line: `aws_secret_access_key = "${AWS_SECRET_VALUE}"`,
  },
  {
    name: "Google API key",
    ruleId: "google-api-key",
    secretValue: GOOGLE_KEY_VALUE,
    line: `googleApiKey = ${GOOGLE_KEY_VALUE}`,
  },
  {
    name: "Anthropic API key",
    ruleId: "anthropic-api-key",
    secretValue: ANTHROPIC_KEY_VALUE,
    line: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY_VALUE}`,
  },
  {
    name: "OpenAI-shaped API key",
    ruleId: "openai-api-key",
    secretValue: OPENAI_KEY_VALUE,
    line: `OPENAI_KEY=${OPENAI_KEY_VALUE}`,
  },
  {
    name: "GitHub token",
    ruleId: "github-token",
    secretValue: GITHUB_TOKEN_VALUE,
    line: `export GITHUB_TOKEN=${GITHUB_TOKEN_VALUE}`,
  },
  {
    name: "Slack token",
    ruleId: "slack-token",
    secretValue: SLACK_TOKEN_VALUE,
    line: `SLACK_TOKEN=${SLACK_TOKEN_VALUE}`,
  },
  {
    name: "Bearer authorization header",
    ruleId: "bearer-authorization-header",
    secretValue: BEARER_TOKEN_VALUE,
    line: `Authorization: Bearer ${BEARER_TOKEN_VALUE}`,
  },
  {
    name: "generic credential assignment",
    ruleId: "credential-assignment",
    secretValue: CREDENTIAL_VALUE,
    line: `db_password = "${CREDENTIAL_VALUE}"`,
  },
  {
    name: "high-entropy catch-all token",
    ruleId: "high-entropy-token",
    secretValue: HIGH_ENTROPY_VALUE,
    line: `blob = ${HIGH_ENTROPY_VALUE}`,
  },
];

for (const ruleCase of RULE_CASES) {
  test(`detects ${ruleCase.name} on a planted synthetic credential`, () => {
    const diff = singleAddedLineDiff("config/example.txt", ruleCase.line, 7);
    const scan = scanForSecrets({
      diff: { changedPaths: ["config/example.txt"], patch: diff },
      untracked: [],
      now: () => NOW,
    });
    assert.equal(scan.status, "detected");
    assert.equal(scan.findings.length, 1);
    const finding = scan.findings[0] as SecretFinding;
    assert.equal(finding.ruleId, ruleCase.ruleId);
    assert.equal(finding.path, "config/example.txt");
    assert.equal(finding.line, 7);
    assertFindingShape(finding);
    assertNeverEscapes(ruleCase.secretValue, finding, scan, JSON.stringify(scan));
  });
}

// ---------------------------------------------------------------------------
// Added-lines-only scanning and hunk-header line attribution
// ---------------------------------------------------------------------------

test("a removed line containing a secret does not trigger a detection", () => {
  const diff = [
    "diff --git a/config/example.txt b/config/example.txt",
    "index 1111111..2222222 100644",
    "--- a/config/example.txt",
    "+++ b/config/example.txt",
    "@@ -1,1 +1,1 @@",
    `-${AKIA_VALUE}`,
    "+harmless replacement line",
    "",
  ].join("\n");
  const scan = scanForSecrets({
    diff: { changedPaths: ["config/example.txt"], patch: diff },
    untracked: [],
    now: () => NOW,
  });
  assert.equal(scan.status, "clean");
  assert.equal(scan.findings.length, 0);
});

test("attributes an added line's number from its hunk header, not its position in the diff text", () => {
  // Two hunks. The second hunk starts at new-file line 40; the secret sits on
  // the second content line of that hunk (one leading context line), which is
  // new-file line 41 — nowhere near its ordinal position among diff lines.
  const secretValue = GITHUB_TOKEN_VALUE;
  const diff = [
    "diff --git a/app/config.py b/app/config.py",
    "index aaaaaaa..bbbbbbb 100644",
    "--- a/app/config.py",
    "+++ b/app/config.py",
    "@@ -1,2 +1,2 @@",
    " first_context",
    "-old_value",
    "+new_value",
    "@@ -40,2 +40,3 @@",
    " context_line",
    `+${secretValue}`,
    " more_context",
    "",
  ].join("\n");
  const scan = scanForSecrets({
    diff: { changedPaths: ["app/config.py"], patch: diff },
    untracked: [],
    now: () => NOW,
  });
  assert.equal(scan.status, "detected");
  assert.equal(scan.findings.length, 1);
  const finding = scan.findings[0] as SecretFinding;
  assert.equal(finding.path, "app/config.py");
  assert.equal(finding.line, 41);
  assertNeverEscapes(secretValue, finding, scan);
});

test("scans untracked candidate files with correct 1-based line numbers", () => {
  const secretValue = SLACK_TOKEN_VALUE;
  const contents = ["one", "two", `SLACK_TOKEN=${secretValue}`, "four"].join("\n");
  const scan = scanForSecrets({
    diff: { changedPaths: [], patch: "" },
    untracked: [{ path: "notes/creds.txt", contents }],
    now: () => NOW,
  });
  assert.equal(scan.status, "detected");
  assert.equal(scan.findings.length, 1);
  const finding = scan.findings[0] as SecretFinding;
  assert.equal(finding.path, "notes/creds.txt");
  assert.equal(finding.line, 3);
  assertNeverEscapes(secretValue, finding, scan);
});

// ---------------------------------------------------------------------------
// Deletion-only diffs (regression coverage for the fixed /dev/null defect)
// ---------------------------------------------------------------------------

test("a deletion-only diff scans cleanly without throwing", () => {
  const diff = [
    "diff --git a/secrets.txt b/secrets.txt",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/secrets.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    `-${AKIA_VALUE}`,
    "-more removed content",
    "",
  ].join("\n");
  const scan = scanForSecrets({
    diff: { changedPaths: ["secrets.txt"], patch: diff },
    untracked: [],
    now: () => NOW,
  });
  assert.equal(scan.status, "clean");
  assert.equal(scan.findings.length, 0);
});

test("a secret on a removed line of a deleted file produces no finding", () => {
  const diff = [
    "diff --git a/old-creds.env b/old-creds.env",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/old-creds.env",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    `-ANTHROPIC_API_KEY=${ANTHROPIC_KEY_VALUE}`,
    "",
  ].join("\n");
  const scan = scanForSecrets({
    diff: { changedPaths: ["old-creds.env"], patch: diff },
    untracked: [],
    now: () => NOW,
  });
  assert.equal(scan.status, "clean");
  assert.equal(scan.findings.length, 0);
});

test("a diff mixing a file deletion and a separate file addition still detects the added secret at the correct line", () => {
  const secretValue = GITHUB_TOKEN_VALUE;
  const diff = [
    "diff --git a/old-secrets.txt b/old-secrets.txt",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/old-secrets.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    `-${AKIA_VALUE}`,
    "-more removed content",
    "diff --git a/new-file.txt b/new-file.txt",
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    "+++ b/new-file.txt",
    "@@ -0,0 +1,3 @@",
    "+line one",
    "+line two",
    `+${secretValue}`,
    "",
  ].join("\n");
  const scan = scanForSecrets({
    diff: { changedPaths: ["old-secrets.txt", "new-file.txt"], patch: diff },
    untracked: [],
    now: () => NOW,
  });
  assert.equal(scan.status, "detected");
  assert.equal(scan.findings.length, 1);
  const finding = scan.findings[0] as SecretFinding;
  assert.equal(finding.path, "new-file.txt");
  assert.equal(finding.line, 3);
  assertNeverEscapes(secretValue, finding, scan);
});

test("an added line under a null (/dev/null) target path still throws rather than silently dropping it", () => {
  const diff = [
    "diff --git a/deleted.txt b/deleted.txt",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/deleted.txt",
    "+++ /dev/null",
    "@@ -1,1 +0,1 @@",
    "+SHOULD_NOT_BE_HERE",
    "",
  ].join("\n");
  assert.throws(
    () =>
      scanForSecrets({
        diff: { changedPaths: ["deleted.txt"], patch: diff },
        untracked: [],
        now: () => NOW,
      }),
    /no target file path/,
  );
});

// ---------------------------------------------------------------------------
// Errors never echo secret material either
// ---------------------------------------------------------------------------

test("an unparseable hunk header's error message never echoes a secret-shaped string it contained", () => {
  const secretValue = AKIA_VALUE;
  const diff = ["diff --git a/x.txt b/x.txt", "--- a/x.txt", "+++ b/x.txt", `@@ garbled ${secretValue} @@`, ""].join(
    "\n",
  );
  assert.throws(
    () =>
      scanForSecrets({
        diff: { changedPaths: ["x.txt"], patch: diff },
        untracked: [],
        now: () => NOW,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error).message.includes(secretValue), false);
      return true;
    },
  );
});
