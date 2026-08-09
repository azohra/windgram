/* Emits JSON Schema artifacts from the zod contract so non-JS consumers are
   first-class. Run via the package's `schemas` script (builds, then executes
   this file from dist/); output lands in toolkit/schema/. The artifact
   table and conversion live in schema-artifacts.ts (pure), shared with the
   freshness test; this file is only the I/O. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaArtifactJson, schemaArtifacts } from "./schema-artifacts.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDir = join(packageRoot, "schema");
mkdirSync(outputDir, { recursive: true });

for (const artifact of schemaArtifacts) {
  const outputPath = join(outputDir, artifact.fileName);
  writeFileSync(outputPath, `${JSON.stringify(schemaArtifactJson(artifact), null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
}
