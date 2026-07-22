import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Templates ship inside the package, so they are resolved from the package root
 * rather than the current working directory. Walking up to the nearest
 * `package.json` works identically for `src/` under tsx and `dist/` after build.
 */
function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(join(directory, "package.json"))) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Unable to locate the DraftForge package root.");
    }

    directory = parent;
  }
}

export function templatesDir(): string {
  return resolve(packageRoot(), "templates");
}

export async function readTemplate(relativePath: string): Promise<string> {
  return readFile(resolve(templatesDir(), relativePath), "utf8");
}

/** Replaces `{{key}}` placeholders. Unknown placeholders are left untouched. */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}
