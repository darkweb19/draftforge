import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export type ProjectFixture = "fresh" | "resumed" | "corrupted";

const fixturesRoot = resolve(import.meta.dirname, "..", "fixtures");

export async function withProjectFixture(
  name: ProjectFixture,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(resolve(tmpdir(), `draftforge-${name}-`));
  try {
    await cp(resolve(fixturesRoot, name), root, { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
