import type { ResearchArticle } from "./research";

export type ResearchThumbnailKind = ResearchArticle["thumbnail"];

export interface ResearchThumbnailModel {
  number: string;
  title: string;
  section: string;
  kind: ResearchArticle["kind"];
  status: ResearchArticle["status"];
  accent: ResearchArticle["accent"];
  visual: ResearchThumbnailKind;
}

type ThumbnailEntry = Pick<
  ResearchArticle,
  "number" | "title" | "section" | "kind" | "status" | "accent" | "thumbnail"
>;

/**
 * Derive thumbnail content entirely from collection metadata. Each article
 * declares the evidence relationship its thumbnail must depict; artwork never
 * changes because a slug, title, or teaching scenario changes.
 */
export function researchThumbnailFor(entry: ThumbnailEntry): ResearchThumbnailModel {
  return {
    number: entry.number,
    title: entry.title,
    section: entry.section,
    kind: entry.kind,
    status: entry.status,
    accent: entry.accent,
    visual: entry.thumbnail,
  };
}
