import { getCollection, type CollectionEntry } from "astro:content";

// Research entries are Astro content entries, so their metadata, routing,
// and component placement travel with the prose. Reference pages live in
// the docs collection like every other portal page.

const RESEARCH_ENTRIES = await getCollection("research");

export interface ResearchArticle {
  slug: string;
  /** Site route for this article, e.g. "/research/ensemble-spread/". */
  url: string;
  title: string;
  number: string;
  section: string;
  summary: string;
  accent: "amber" | "blue" | "green";
  readingMinutes: number;
  kind: CollectionEntry<"research">["data"]["kind"];
  published: Date;
  updated: Date;
  status: "current" | "historical";
  order: number;
  scenarios: string[];
  thumbnail: CollectionEntry<"research">["data"]["thumbnail"];
  entry: CollectionEntry<"research">;
}

function countWords(raw: string): number {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`\[\]()]/g, " ")
    .trim()
    .split(/\s+/).length;
}

function researchAccent(
  kind: CollectionEntry<"research">["data"]["kind"],
): ResearchArticle["accent"] {
  if (kind === "experiment") return "amber";
  if (kind === "case-study") return "green";
  return "blue";
}

/** The dated stories of work done, derived entirely from collection entries. */
export function researchArticles(): ResearchArticle[] {
  return RESEARCH_ENTRIES.map((entry) => ({
    slug: entry.id.replace(/\/index$/, ""),
    url: `/research/${entry.id.replace(/\/index$/, "")}/`,
    title: entry.data.title,
    number: String(entry.data.order).padStart(2, "0"),
    section: entry.data.section,
    summary: entry.data.summary,
    accent: researchAccent(entry.data.kind),
    readingMinutes: Math.max(2, Math.ceil(countWords(entry.body ?? "") / 220)),
    kind: entry.data.kind,
    published: entry.data.published,
    updated: entry.data.updated,
    status: entry.data.status,
    order: entry.data.order,
    scenarios: entry.data.scenarios,
    thumbnail: entry.data.thumbnail,
    entry,
  })).sort((a, b) => a.order - b.order);
}

/**
 * Related entries are ranked from collection metadata: shared teaching
 * scenarios first, then kind and section affinity, then reading-order
 * proximity. There is no slug-maintained related-content registry.
 */
export function relatedResearchArticles(
  current: ResearchArticle,
  entries: ResearchArticle[],
  limit = 3,
): ResearchArticle[] {
  const scenarios = new Set(current.scenarios);
  return entries
    .filter((entry) => entry.slug !== current.slug)
    .map((entry) => {
      const sharedScenarios = entry.scenarios.filter((scenario) => scenarios.has(scenario)).length;
      const score =
        sharedScenarios * 100 +
        (entry.kind === current.kind ? 20 : 0) +
        (entry.section === current.section ? 10 : 0) -
        Math.abs(entry.order - current.order);
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
