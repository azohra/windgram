/* The JSON Schema artifact table and conversion, pure — the one home for
   which zod schemas ship as schema/*.json and under what titles. The
   emitter (emit-json-schema.ts) writes exactly this; the freshness test in
   test/contract.test.ts asserts the shipped files match it, so adding an
   artifact here extends both automatically. */

import { z } from "zod";
import {
  modelCatalogueSchema,
  observationDocumentSchema,
  runsIndexSchema,
  sitesCatalogueSchema,
  smokeDocumentSchema,
  windgramManifestSchema,
  windgramProfileSchema,
} from "../contract/index.js";

export interface SchemaArtifact {
  fileName: string;
  title: string;
  schema: z.ZodType;
}

export const schemaArtifacts: readonly SchemaArtifact[] = [
  {
    fileName: "profile.schema.json",
    title: "Windgram profile document",
    schema: windgramProfileSchema,
  },
  {
    fileName: "smoke.schema.json",
    title: "Windgram smoke document",
    schema: smokeDocumentSchema,
  },
  {
    fileName: "observation.schema.json",
    title: "Windgram observation document",
    schema: observationDocumentSchema,
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
  {
    fileName: "sites.schema.json",
    title: "Windgram site catalogue, sites.json",
    schema: sitesCatalogueSchema,
  },
  {
    fileName: "runs.schema.json",
    title: "Windgram cross-model run index, data/runs.json",
    schema: runsIndexSchema,
  },
];

/**
 * The artifact's JSON Schema document, exactly as shipped. io: "input"
 * matches what the zod guards accept: unknown keys are tolerated (zod
 * strips them), so documents that add fields later still validate against
 * a pinned artifact.
 */
export function schemaArtifactJson(artifact: SchemaArtifact): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: artifact.title,
    ...z.toJSONSchema(artifact.schema, { target: "draft-2020-12", io: "input" }),
  };
}
