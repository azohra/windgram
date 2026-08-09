import fs from "node:fs";
import path from "node:path";
import { getCollection, type CollectionEntry } from "astro:content";
import { marked } from "marked";

// Reference documents and the npm integration guide still render their
// repository Markdown directly. Research entries are Astro content entries,
// so their metadata, routing, and component placement travel with the prose.
const REFERENCE_DIR = path.resolve(process.cwd(), "../reference");

export type DocKind = "entry" | "reference";

// Reference documents are a separate living-document surface. Research
// articles are deliberately absent from this registry.
interface DocDefinition {
  slug: string;
  file: string;
  kind: DocKind;
  number: string;
  section: string;
  summary: string;
  accent: "amber" | "blue" | "green" | "red";
}
const DOC_FILES: DocDefinition[] = [
  {
    slug: "forecast-model-feeds",
    file: "forecast-model-feeds.md",
    kind: "reference",
    number: "R1",
    section: "Reference",
    summary: "Paths, schedules, and field semantics",
    accent: "blue",
  },
];

function docUrl(d: { slug: string; kind: DocKind }): string {
  return d.kind === "entry" ? `/research/${d.slug}/` : `/docs/reference/${d.slug}/`;
}

const RESEARCH_ENTRIES = await getCollection("research");
const DOCS_ENTRIES = await getCollection("docs");
// Every site page a repository Markdown link may point at, keyed by document
// basename (rewriteHref matches links by basename). Duplicate basenames would
// make the rewrite ambiguous, so they fail the build rather than silently
// resolving to whichever collection registered last.
const SLUG_URL = new Map<string, string>();
for (const [slug, url] of [
  ...DOC_FILES.map((doc) => [doc.slug, docUrl(doc)] as const),
  ...RESEARCH_ENTRIES.map(
    (entry) => [entry.id.replace(/\/index$/, ""), `/research/${entry.id.replace(/\/index$/, "")}/`] as const,
  ),
  ...DOCS_ENTRIES.flatMap((entry) => {
    const basename = entry.id.split("/").pop()!;
    // An index page's basename is too generic to identify it in a link.
    return basename === "index" ? [] : [[basename, `/${entry.id}/`] as const];
  }),
]) {
  if (SLUG_URL.has(slug) && SLUG_URL.get(slug) !== url) {
    throw new Error(
      `[research] two site pages share the document basename "${slug}" (${SLUG_URL.get(slug)} and ${url}) — link rewriting by basename is ambiguous`,
    );
  }
  SLUG_URL.set(slug, url);
}

// The living reference links to research, docs, and other repository source
// files by relative path. All of them resolve on GitHub, so the shared
// Markdown stays honest read from the repository; here, basenames known to a
// content collection resolve to their site routes and everything else points
// at the repository.
//
// currentRepoBase is the rendering doc's directory relative to the repo root
// ("" for research/ and reference/, whose own relative links are the cross-doc
// kind above): a plain relative link like "schema/" resolves against it so the
// package README's links land on the repository. Reset per-doc like the toc.
let currentRepoBase = "";

function rewriteHref(href: string): string {
  if (/^https?:\/\//.test(href)) return href;
  const docMatch = href.match(/(?:^|\/)([a-z0-9-]+)\.(?:md|mdx)$/);
  if (docMatch && SLUG_URL.has(docMatch[1])) return SLUG_URL.get(docMatch[1])!;
  let repoPath: string | null = null;
  if (href.startsWith("../")) repoPath = href.slice(3);
  else if (currentRepoBase) repoPath = currentRepoBase + href;
  if (repoPath !== null) {
    const isDir = repoPath === "tests" || repoPath.endsWith("/");
    return `https://github.com/azohra/windgram/${isDir ? "tree" : "blob"}/main/${repoPath.replace(/\/$/, "")}`;
  }
  return href;
}

// Marked (v16) no longer assigns heading ids itself — the extension that
// used to do it was split out of core. The remaining repository-authored
// reference pages need stable ids for their in-page table of contents, so
// this renders headings by hand and records `##` headings as it goes.
let tocCollector: TocEntry[] = [];
let slugSeen = new Map<string, number>();

// GitHub-style slugify, so anchors read the same as they would on GitHub.
function slugify(text: string): string {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const count = slugSeen.get(base) ?? 0;
  slugSeen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const url = rewriteHref(href);
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : "";
      const external = /^https?:\/\//.test(url) ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${url}"${titleAttr}${external}>${text}</a>`;
    },
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const text = html.replace(/<[^>]+>/g, "");
      const id = slugify(text);
      if (depth === 2) tocCollector.push({ id, text });
      return `<h${depth} id="${id}">${html}</h${depth}>\n`;
    },
  },
});

export interface TocEntry {
  id: string;
  text: string;
}

export interface DocPage {
  slug: string;
  kind: DocKind;
  /** Site route for this doc, e.g. "/research/ensemble-spread/". */
  url: string;
  title: string;
  dek: string;
  number: string;
  section: string;
  summary: string;
  accent: DocDefinition["accent"];
  readingMinutes: number;
  html: string;
  /** Every `##` heading in the doc, in order, with the id the renderer gave it. */
  toc: TocEntry[];
  /** Collection metadata present only for research entries. */
  researchKind?: "method" | "experiment" | "case-study";
  published?: Date;
  updated?: Date;
  status?: "current" | "historical";
  order?: number;
  scenarios?: string[];
  thumbnail?: CollectionEntry<"research">["data"]["thumbnail"];
  entry?: CollectionEntry<"research">;
}

function firstHeading(raw: string, fallback: string): string {
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function firstParagraph(raw: string): string {
  const withoutHeading = raw.replace(/^#\s+.+$/m, "").trim();
  const m = withoutHeading.match(/^([^\n]+(?:\n[^\n#]+)*)/);
  const text = (m ? m[1] : "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
  if (text.length <= 220) return text;
  // Cut at a word boundary so truncated deks never end mid-word.
  const cut = text.slice(0, 217);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

// Tags the first <p> in the rendered doc — always the paragraph right after
// the H1 — with a class CSS can target, independent of whatever else a page
// later splices in right after the H1 (a table of contents, a comparison
// grid). An adjacent-sibling selector would silently stop matching the
// moment something is inserted between the H1 and that paragraph.
function tagIntro(html: string): string {
  return html.replace("<p>", '<p class="doc-lede">');
}

function countWords(raw: string): number {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`\[\]()]/g, " ")
    .trim()
    .split(/\s+/).length;
}

export function loadDocs(): DocPage[] {
  return DOC_FILES.map(({ slug, file, kind, number, section, summary, accent }) => {
    const raw = fs.readFileSync(path.join(REFERENCE_DIR, file), "utf-8");
    tocCollector = [];
    slugSeen = new Map();
    currentRepoBase = "";
    const html = tagIntro(marked.parse(raw, { async: false }) as string);
    const words = countWords(raw);
    return {
      slug,
      kind,
      url: docUrl({ slug, kind }),
      title: firstHeading(raw, file),
      dek: firstParagraph(raw),
      number,
      section,
      summary,
      accent,
      readingMinutes: Math.max(2, Math.ceil(words / 220)),
      html,
      toc: tocCollector,
    };
  });
}

function researchAccent(
  kind: CollectionEntry<"research">["data"]["kind"],
): DocDefinition["accent"] {
  if (kind === "experiment") return "amber";
  if (kind === "case-study") return "green";
  return "blue";
}

/** The dated stories of work done, derived entirely from collection entries. */
export function researchArticles(): DocPage[] {
  return RESEARCH_ENTRIES.map((entry) => ({
    slug: entry.id.replace(/\/index$/, ""),
    kind: "entry" as const,
    url: `/research/${entry.id.replace(/\/index$/, "")}/`,
    title: entry.data.title,
    dek: entry.data.summary,
    number: String(entry.data.order).padStart(2, "0"),
    section: entry.data.section,
    summary: entry.data.summary,
    accent: researchAccent(entry.data.kind),
    readingMinutes: Math.max(2, Math.ceil(countWords(entry.body ?? "") / 220)),
    html: "",
    toc: [],
    researchKind: entry.data.kind,
    published: entry.data.published,
    updated: entry.data.updated,
    status: entry.data.status,
    order: entry.data.order,
    scenarios: entry.data.scenarios,
    thumbnail: entry.data.thumbnail,
    entry,
  })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Related entries are ranked from collection metadata: shared teaching
 * scenarios first, then kind and section affinity, then reading-order
 * proximity. There is no slug-maintained related-content registry.
 */
export function relatedResearchArticles(
  current: DocPage,
  entries: DocPage[] = researchArticles(),
  limit = 3,
): DocPage[] {
  const scenarios = new Set(current.scenarios ?? []);
  return entries
    .filter((entry) => entry.slug !== current.slug)
    .map((entry) => {
      const sharedScenarios = (entry.scenarios ?? []).filter((scenario) => scenarios.has(scenario)).length;
      const score =
        sharedScenarios * 100 +
        (entry.researchKind === current.researchKind ? 20 : 0) +
        (entry.section === current.section ? 10 : 0) -
        Math.abs((entry.order ?? 0) - (current.order ?? 0));
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score || (a.entry.order ?? 0) - (b.entry.order ?? 0))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** Dated inventories checked against the providers. */
export function referenceDocs(): DocPage[] {
  return loadDocs().filter((d) => d.kind === "reference");
}

// A renamed heading must not silently push a spliced figure to the end of
// the article (the [html, ""] fallback) — warn loudly at build time so the
// miss is caught before it ships.
function warnHeadingMiss(headingId: string): void {
  console.warn(
    `[research] splice heading id "${headingId}" not found — the spliced component will render at the end of the article. Was the heading renamed?`,
  );
}

/**
 * Splits rendered doc HTML right after the closing tag of the heading with
 * the given id, so a page can splice a component in immediately below a
 * specific section without hand-editing the shared markdown.
 */
export function splitAfterHeading(html: string, headingId: string): [string, string] {
  const marker = `id="${headingId}"`;
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) {
    warnHeadingMiss(headingId);
    return [html, ""];
  }
  const closeTag = html.slice(markerIdx).match(/<\/h[1-6]>/);
  if (!closeTag || closeTag.index === undefined) {
    warnHeadingMiss(headingId);
    return [html, ""];
  }
  const splitAt = markerIdx + closeTag.index + closeTag[0].length;
  return [html.slice(0, splitAt), html.slice(splitAt)];
}

/**
 * Same idea, but splits right before the heading's opening tag — for
 * inserting a section-break component (a pull-quote, say) at the *end* of
 * the section that precedes a given heading.
 */
export function splitBeforeHeading(html: string, headingId: string): [string, string] {
  const marker = `id="${headingId}"`;
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) {
    warnHeadingMiss(headingId);
    return [html, ""];
  }
  const openTagStart = html.lastIndexOf("<h", markerIdx);
  if (openTagStart === -1) {
    warnHeadingMiss(headingId);
    return [html, ""];
  }
  return [html.slice(0, openTagStart), html.slice(openTagStart)];
}
