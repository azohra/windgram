import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

// Renders directly from the repo's research/ and reference/ folders at build
// time, so the site never forks a second copy of this writing that could
// drift from the one GitHub already renders. Research articles are dated
// stories of work done; reference docs are dated inventories verified
// against the providers.
const RESEARCH_DIR = path.resolve(process.cwd(), "../research");
const REFERENCE_DIR = path.resolve(process.cwd(), "../reference");

export type DocKind = "entry" | "reference";

// Reading order for articles; reference documents live beside them.
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
    slug: "reading-a-windgram",
    file: "reading-a-windgram.md",
    kind: "entry",
    number: "01",
    section: "Field guide",
    summary: "Strips, stability, gusts, CAPE classes, derived heights, and wind barbs",
    accent: "amber",
  },
  {
    slug: "usable-lift-and-boundary-layer",
    file: "usable-lift-and-boundary-layer.md",
    kind: "entry",
    number: "02",
    section: "Lift definitions",
    summary: "Boundary-layer top versus usable-lift top",
    accent: "blue",
  },
  {
    slug: "windgram-derivations",
    file: "windgram-derivations.md",
    kind: "entry",
    number: "03",
    section: "Derivation",
    summary: "Equations and constants behind each published quantity",
    accent: "green",
  },
  {
    slug: "choosing-forecast-models",
    file: "choosing-forecast-models.md",
    kind: "entry",
    number: "04",
    section: "Model guide",
    summary: "Model choice by spatial resolution and forecast schedule",
    accent: "blue",
  },
  {
    slug: "forecast-data-validation-failures",
    file: "forecast-data-validation-failures.md",
    kind: "entry",
    number: "05",
    section: "Data validation",
    summary: "Forecast-data failures caught by independent checks",
    accent: "red",
  },
  {
    slug: "static-forecast-pipeline",
    file: "static-forecast-pipeline.md",
    kind: "entry",
    number: "06",
    section: "Publication system",
    summary: "How builders publish static JSON through Git",
    accent: "green",
  },
  {
    slug: "ensemble-spread",
    file: "ensemble-spread.md",
    kind: "entry",
    number: "07",
    section: "Ensemble interpretation",
    summary: "Interpret member percentiles under column censoring",
    accent: "amber",
  },
  {
    slug: "why-this-project-exists",
    file: "why-this-project-exists.md",
    kind: "entry",
    number: "08",
    section: "Purpose",
    summary: "The open-pipeline bet, and the contract design that makes it hold",
    accent: "red",
  },
  {
    slug: "model-capabilities",
    file: "model-capabilities.md",
    kind: "entry",
    number: "09",
    section: "Capability semantics",
    summary: "Per-model field meanings, and absences as stated facts",
    accent: "blue",
  },
  {
    slug: "stability-ramp",
    file: "stability-ramp.md",
    kind: "entry",
    number: "10",
    section: "Palette design",
    summary: "The field is background: a pale register, measured floors, and a lineage credit",
    accent: "amber",
  },
  {
    slug: "adopting-a-retiring-model",
    file: "adopting-a-retiring-model.md",
    kind: "entry",
    number: "11",
    section: "Catalogue growth",
    summary: "Four candidates, one retirement notice, the sunset field, and slugs as identity",
    accent: "green",
  },
  {
    slug: "retiring-121-metres-per-degree",
    file: "retiring-121-metres-per-degree.md",
    kind: "entry",
    number: "12",
    section: "Derivation evolution",
    summary: "Bolton's LCL replaces an inherited constant, and de-capped hours surface",
    accent: "blue",
  },
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
  return d.kind === "entry" ? `/research/${d.slug}/` : `/reference/${d.slug}/`;
}

const SLUG_URL = new Map(DOC_FILES.map((d) => [d.slug, docUrl(d)]));

// The docs link to each other by filename — bare ("ensemble-spread.md") within a
// folder, or relative across the two folders ("../reference/forecast-model-feeds.md")
// — and to source files by repo-relative path (e.g. "../windgram/windgram.py").
// Both resolve fine on GitHub but not as site routes, so cross-doc links are
// resolved by basename against the registry and everything else points at the
// repository. Rewriting here beats editing the shared markdown, which GitHub
// still renders directly.
//
// currentRepoBase is the rendering doc's directory relative to the repo root
// ("" for research/ and reference/, whose own relative links are the cross-doc
// kind above): a plain relative link like "schema/" resolves against it so the
// package README's links land on the repository. Reset per-doc like the toc.
let currentRepoBase = "";

function rewriteHref(href: string): string {
  if (/^https?:\/\//.test(href)) return href;
  const docMatch = href.match(/(?:^|\/)([a-z0-9-]+)\.md$/);
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
// used to do it was split out of core. Headings need stable ids for both
// the in-page table of contents and for [slug].astro to splice a diagram
// in right after a specific heading, so this renders headings by hand and
// records `##` headings as it goes. Reset per-doc in loadDocs() below.
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
    const dir = kind === "entry" ? RESEARCH_DIR : REFERENCE_DIR;
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
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

/** The rendered integration guide, without the registry metadata articles carry. */
export interface IntegrationDoc {
  title: string;
  dek: string;
  readingMinutes: number;
  html: string;
  toc: TocEntry[];
}

/**
 * packages/windgram/README.md, rendered from the repo at build time — the
 * same one-home pattern as the articles, so npm, GitHub, and the site all
 * read the identical integration guide. Relative links resolve against the
 * package directory on GitHub.
 */
export function integrationDoc(): IntegrationDoc {
  const raw = fs.readFileSync(path.resolve(process.cwd(), "../packages/windgram/README.md"), "utf-8");
  tocCollector = [];
  slugSeen = new Map();
  currentRepoBase = "packages/windgram/";
  const html = tagIntro(marked.parse(raw, { async: false }) as string);
  currentRepoBase = "";
  return {
    title: firstHeading(raw, "windgram"),
    dek: firstParagraph(raw),
    readingMinutes: Math.max(2, Math.ceil(countWords(raw) / 220)),
    html,
    toc: tocCollector,
  };
}

/** The dated stories of work done, in reading order. */
export function researchArticles(): DocPage[] {
  return loadDocs().filter((d) => d.kind === "entry");
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
