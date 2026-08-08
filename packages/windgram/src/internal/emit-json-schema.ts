/* Emits JSON Schema artifacts from the zod contract so non-JS consumers are
   first-class. Run via the package's `schemas` script (builds, then executes
   this file from dist/); output lands in packages/windgram/schema/. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  modelCatalogueSchema,
  windgramManifestSchema,
  windgramProfileSchema,
} from "../contract/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDir = join(packageRoot, "schema");
mkdirSync(outputDir, { recursive: true });

const artifacts = [
  {
    fileName: "profile.schema.json",
    title: "Windgram profile document",
    schema: windgramProfileSchema,
  },
  {
    fileName: "manifest.schema.json",
    title: "Windgram model manifest",
    schema: windgramManifestSchema,
  },
  {
    fileName: "models.schema.json",
    title: "Windgram model catalogue, data/models.json",
    schema: modelCatalogueSchema,
  },
] as const;

for (const artifact of artifacts) {
  // io: "input" matches what the zod guards accept: unknown keys are
  // tolerated (zod strips them), so documents that add fields later still
  // validate against a pinned artifact.
  const jsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: artifact.title,
    ...z.toJSONSchema(artifact.schema, { target: "draft-2020-12", io: "input" }),
  };
  const outputPath = join(outputDir, artifact.fileName);
  writeFileSync(outputPath, `${JSON.stringify(jsonSchema, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
}
