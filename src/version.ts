import { createRequire } from "node:module";

interface PackageMetadata {
  readonly version: string;
}

const require = createRequire(import.meta.url);
const metadata: unknown = require("../package.json");

if (
  typeof metadata !== "object" ||
  metadata === null ||
  !("version" in metadata) ||
  typeof metadata.version !== "string"
) {
  throw new Error("package.json must contain a string version.");
}

export const VERSION: string = (metadata as PackageMetadata).version;
