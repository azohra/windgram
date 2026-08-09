import type { DocPage } from "./research";

export type ResearchThumbnailKind = NonNullable<DocPage["thumbnail"]>;

export interface ResearchThumbnailModel {
  number: string;
  title: string;
  section: string;
  kind: NonNullable<DocPage["researchKind"]>;
  status: NonNullable<DocPage["status"]>;
  accent: DocPage["accent"];
  visual: ResearchThumbnailKind;
}

type ThumbnailEntry = Pick<
  DocPage,
  "number" | "title" | "section" | "researchKind" | "status" | "accent" | "thumbnail"
>;

/**
 * Derive thumbnail content entirely from collection metadata. Each article
 * declares the evidence relationship its thumbnail must depict; artwork never
 * changes because a slug, title, or teaching scenario changes.
 */
export function researchThumbnailFor(entry: ThumbnailEntry): ResearchThumbnailModel {
  if (!entry.thumbnail) throw new Error(`Research entry ${entry.number} has no thumbnail declaration`);
  return {
    number: entry.number,
    title: entry.title,
    section: entry.section,
    kind: entry.researchKind ?? "method",
    status: entry.status ?? "current",
    accent: entry.accent,
    visual: entry.thumbnail,
  };
}
