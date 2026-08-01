import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";

test("reports the package metadata version", async () => {
  const output: string[] = [];
  const io: CliIo = { out: (message) => output.push(message), error: () => undefined };
  const metadata: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(await main(["--version"], io), 0);
  assert.deepEqual(output, [(metadata as { version: string }).version]);
});
