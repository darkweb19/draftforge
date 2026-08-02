import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";

const repoRoot = resolve(import.meta.dirname, "..");

/** The documentation set owned by the release documentation contract. */
const DOCUMENTS = [
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/INSTALLATION.md",
  "docs/PROVIDERS.md",
  "docs/UPGRADING.md",
  "docs/TROUBLESHOOTING.md",
  "docs/EXAMPLE.md",
] as const;

const readDocument = (path: string): Promise<string> =>
  readFile(resolve(repoRoot, path), "utf8");

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

for (const path of DOCUMENTS) {
  test(`${path} exists and is not a stub`, async () => {
    assert.ok(await exists(resolve(repoRoot, path)), `${path} is missing`);
    assert.ok((await readDocument(path)).trim().length > 500, `${path} is too short to be complete`);
  });
}

// A relative link that does not resolve is the most common way documentation
// rots, and these files are read from a published tarball where a broken path
// cannot be guessed at.
test("every relative documentation link resolves", async () => {
  const broken: string[] = [];

  for (const path of DOCUMENTS) {
    const documentDirectory = dirname(resolve(repoRoot, path));
    for (const [, , target] of (await readDocument(path)).matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/gu)) {
      if (target === undefined) continue;
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const [withoutAnchor] = target.split("#") as [string];
      if (withoutAnchor.length === 0) continue;
      if (!(await exists(resolve(documentDirectory, withoutAnchor)))) {
        broken.push(`${path} -> ${target}`);
      }
    }
  }

  assert.deepEqual(broken, [], `broken relative links: ${broken.join(", ")}`);
});

test("every in-page anchor link matches a heading", async () => {
  const broken: string[] = [];

  for (const path of DOCUMENTS) {
    const source = await readDocument(path);
    const slugs = new Set(
      [...source.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)].map(([, heading]) => slugify(heading as string)),
    );
    for (const [, , target] of source.matchAll(/\[([^\]]*)\]\((#[^)\s]+)\)/gu)) {
      if (target !== undefined && !slugs.has(target.slice(1))) broken.push(`${path} -> ${target}`);
    }
  }

  assert.deepEqual(broken, [], `broken anchors: ${broken.join(", ")}`);
});

function slugify(heading: string): string {
  return heading
    .replace(/`/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number} -]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

// The unscoped `draftforge` name on the public registry is an unrelated
// third-party package. Documentation must never instruct anyone to install it.
test("documentation never instructs installing the unscoped registry package", async () => {
  const offenders: string[] = [];

  for (const path of DOCUMENTS) {
    for (const [line] of (await readDocument(path)).matchAll(/^.*npm (?:install|i|add).*$/gmu)) {
      if (/npm (?:install|i|add)(?:\s+-{1,2}\S+)*\s+draftforge(?:@\S+)?\s*$/u.test(line)) {
        offenders.push(`${path}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `unsafe install instructions: ${offenders.join(" | ")}`);
});

test("documented CLI commands exist in the CLI", async () => {
  const lines: string[] = [];
  const io: CliIo = { out: (message) => lines.push(message), error: (message) => lines.push(message) };
  assert.equal(await main(["help"], io, repoRoot), 0);

  const helpText = lines.join("\n");
  const commandSection = helpText.slice(helpText.indexOf("Commands:"));
  const known = new Set(
    [...commandSection.matchAll(/^ {2}([a-z]+)/gmu)].map(([, command]) => command as string),
  );
  assert.ok(known.size > 5, "could not parse the command list out of CLI help");

  const unknown = new Set<string>();
  for (const path of DOCUMENTS) {
    // Same-line only: `cd draftforge` followed by a newline and the next
    // command is not an invocation of a `draftforge` subcommand.
    for (const [, command] of (await readDocument(path)).matchAll(/\bdraftforge[ \t]+([a-z]+)/gu)) {
      if (command !== undefined && !known.has(command)) unknown.add(`${path}: draftforge ${command}`);
    }
  }

  assert.deepEqual([...unknown], [], `documented commands the CLI does not have: ${[...unknown].join(", ")}`);
});

// The runtime floor for the installed CLI and the version this repository is
// developed on are different numbers, and conflating them is the single easiest
// way for installation guidance to become wrong.
test("documented Node.js versions match the package engine range and .nvmrc", async () => {
  const metadata = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
    readonly engines: { readonly node: string };
  };
  const developmentMajor = (await readFile(resolve(repoRoot, ".nvmrc"), "utf8")).trim();
  assert.match(metadata.engines.node, /^>=\s*\d+$/u, "engines.node must be a >=<major> range");
  assert.match(developmentMajor, /^\d+$/u, ".nvmrc must pin a major version");

  const installation = await readDocument("docs/INSTALLATION.md");
  assert.ok(
    installation.includes(metadata.engines.node),
    `docs/INSTALLATION.md must quote the supported engine range ${metadata.engines.node}`,
  );
  assert.ok(
    installation.includes(developmentMajor),
    `docs/INSTALLATION.md must distinguish the development Node.js ${developmentMajor}`,
  );
});

// Evidence files and guides get committed and shared, so a documented
// credential must stay a named variable and never carry a value.
test("documentation names credential variables without assigning values", async () => {
  const offenders: string[] = [];
  // A real assignment only. `${ANTHROPIC_API_KEY:-}` and `${VAR:+set}` are
  // presence-only shell checks and are exactly what the guides should show.
  const assignment = /(?<!\$\{)\b((?:OPENAI|ANTHROPIC)_API_KEY)=(\S+)/gu;

  for (const path of DOCUMENTS) {
    for (const [, variable, value] of (await readDocument(path)).matchAll(assignment)) {
      if (variable === undefined || value === undefined) continue;
      const placeholder = /^(?:["']?)(?:<[^>]*>|\.{3}|\$\{?[A-Z_]+\}?|""|'')(?:["']?)[,;]?$/u.test(value);
      if (!placeholder) offenders.push(`${path}: ${variable}=${value}`);
    }
  }

  assert.deepEqual(offenders, [], `credential values in documentation: ${offenders.join(" | ")}`);
});

test("the security policy provides an existing private reporting route", async () => {
  const security = await readDocument("SECURITY.md");
  assert.match(security, /mailto:hi@sujanshrestha\.ca/u);
  assert.doesNotMatch(
    security,
    /github\.com\/darkweb19\/draftforge\/security\/advisories\/new/u,
    "SECURITY.md must not claim the disabled GitHub private-reporting route is available",
  );
});

test("the committed example idea is a real idea, not the placeholder draft", async () => {
  const idea = await readFile(resolve(repoRoot, "examples/idea.md"), "utf8");
  assert.ok(idea.trim().length > 200, "examples/idea.md must be a substantive worked example");
  assert.doesNotMatch(idea, /placeholder/iu, "examples/idea.md must not be the placeholder draft");
});

test("the README answers every committed blocking example question before requesting a plan", async () => {
  const readme = await readDocument("README.md");
  const shortestFlow = section(readme, "## Shortest working flow");
  const questions = JSON.parse(
    await readFile(resolve(repoRoot, "examples/planning/questions.json"), "utf8"),
  ) as {
    readonly questions: { readonly items: readonly { readonly id: string; readonly blocking: boolean }[] };
  };
  const prompts = [...shortestFlow.matchAll(/^draftforge plan --prompt(?:\s+#.*)?$/gmu)].map(({ index }) => index);
  assert.equal(prompts.length, 2, "the shortest flow must show the question and plan prompts");

  for (const question of questions.questions.items.filter(({ blocking }) => blocking)) {
    const answer = shortestFlow.indexOf(`draftforge plan --answer ${question.id}=`);
    assert.ok(answer > prompts[0]!, `the shortest flow must answer blocking ${question.id}`);
    assert.ok(answer < prompts[1]!, `${question.id} must be answered before the plan prompt`);
  }
});

test("the committed example DAG can bootstrap and verify a fresh TypeScript project", async () => {
  const response = JSON.parse(
    await readFile(resolve(repoRoot, "examples/planning/plan.json"), "utf8"),
  ) as {
    readonly plan: {
      readonly tasks: readonly {
        readonly id: string;
        readonly ownedPaths: readonly string[];
        readonly verification: readonly string[];
      }[];
    };
  };
  const tasks = response.plan.tasks;
  assert.deepEqual(
    tasks.map(({ id }) => id),
    ["P01-T01", "P01-T02", "P02-T01", "P02-T02"],
    "the worked example must retain its four-task DAG",
  );
  const first = tasks[0];
  assert.ok(first, "the example plan must have a root task");
  for (const path of [".gitignore", "package.json", "package-lock.json", "tsconfig.json", "src/parse/", "test/parse/"]) {
    assert.ok(first.ownedPaths.includes(path), `the root task must own ${path}`);
  }

  const expectedImplementationPaths = new Map([
    ["P01-T01", ["src/parse/", "test/parse/"]],
    ["P01-T02", ["src/index/", "test/index/"]],
    ["P02-T01", ["src/query/", "test/query/"]],
    ["P02-T02", ["src/cli/", "test/cli/"]],
  ]);
  const allOwned = new Map<string, string>();
  for (const task of tasks) {
    assert.deepEqual(task.verification, ["npm test", "npm run typecheck"]);
    const expectedPaths = expectedImplementationPaths.get(task.id);
    assert.ok(expectedPaths, `unexpected example task ${task.id}`);
    for (const path of expectedPaths) {
      assert.ok(task.ownedPaths.includes(path), `${task.id} must own ${path}`);
    }
    for (const path of task.ownedPaths) {
      for (const [owned, owner] of allOwned) {
        assert.ok(!pathsOverlap(path, owned), `${task.id}:${path} overlaps ${owner}:${owned}`);
      }
      allOwned.set(path, task.id);
    }
  }
});

test("upgrade guidance distinguishes refusal, incomplete backup, and recovery outcomes", async () => {
  const upgrading = await readDocument("docs/UPGRADING.md");
  const refusals = section(upgrading, "## Refusals — exit `2`, no backup or target write");
  const failures = section(upgrading, "## Operational failures — exit `1`");
  assert.doesNotMatch(refusals, /post-plan drift/iu);
  assert.match(failures, /Backup creation did not complete — no target was mutated/u);
  assert.match(failures, /Post-plan drift is in this category/u);
  assert.match(failures, /Earlier targets in the fixed write order may already have changed/u);
});

function section(document: string, heading: string): string {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = document.indexOf("\n## ", start + heading.length);
  return document.slice(start, end === -1 ? undefined : end);
}

function pathsOverlap(left: string, right: string): boolean {
  const normalize = (path: string): string => path.replace(/\/+$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
