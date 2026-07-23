import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderTemplate, templatesDir } from "../src/state/templates.js";

const repoRoot = resolve(import.meta.dirname, "..");

// `templates/schema/` is what `init` ships to new projects; `.draftforge/schema/`
// is this repository dogfooding the same contract. They must not drift.
for (const name of ["state.schema.json", "config.schema.json", "planning.schema.json"]) {
  test(`shipped ${name} matches the repository copy`, async () => {
    const shipped = await readFile(resolve(templatesDir(), "schema", name), "utf8");
    const local = await readFile(resolve(repoRoot, ".draftforge/schema", name), "utf8");
    assert.equal(shipped, local);
  });
}

test("renders known placeholders and leaves unknown ones alone", () => {
  assert.equal(renderTemplate("# {{projectName}} ({{other}})", { projectName: "Sample" }), "# Sample ({{other}})");
});
