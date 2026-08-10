import {
  siteContextSchema,
  sitesCatalogueSchema,
  type LandCoverClass,
  type SiteCatalogueEntry,
  type SiteContext,
  type SiteContextEntry,
  type SiteContextSource,
} from "windgram/contract";
import rawContext from "../../../site-context.json";
import rawSites from "../../../sites.json";

/* site-context.json and sites.json are validated against the package
   contract at build time (the models.json pattern in catalogue.ts), so a
   context document that drifts from the contract — or a context entry
   missing for a catalogued site — fails the build instead of shipping a
   figure that lies. */
const context: SiteContext = siteContextSchema.parse(rawContext);
const catalogue = sitesCatalogueSchema.parse(rawSites);

export const SITE_CONTEXT: SiteContext = context;

export interface ContextSite {
  site: SiteCatalogueEntry;
  context: SiteContextEntry;
}

/* Every catalogued site joined to its context by slug — the same join
   consumers perform against the published dataset root. */
export const CONTEXT_SITES: ContextSite[] = catalogue.sites.map((site) => {
  const entry = context.sites[site.slug];
  if (!entry) throw new Error(`site-context.json has no entry for catalogued site "${site.slug}"`);
  return { site, context: entry };
});

export function sourceById(id: string): SiteContextSource {
  const source = context.sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`site-context.json declares no source "${id}"`);
  return source;
}

/* Reader-facing land-cover labels for the contract's semantic class names. */
export const LAND_COVER_LABELS: Record<LandCoverClass, string> = {
  treeCover: "tree cover",
  shrubland: "shrubland",
  grassland: "grassland",
  cropland: "cropland",
  builtUp: "built-up",
  bareSparse: "bare / sparse",
  snowIce: "snow / ice",
  water: "water",
  wetland: "wetland",
  mangroves: "mangroves",
  mossLichen: "moss / lichen",
};

/* Fixed data-encoding hues for land-cover classes — chart-only, never
   themed, matching the theme.css convention for data colours. Chosen to
   read on the field-paper surface: vegetation greens, mineral tans, water
   blue, built-up brick. */
export const LAND_COVER_COLORS: Record<LandCoverClass, string> = {
  treeCover: "#16694f",
  shrubland: "#7c6a1e",
  grassland: "#9a7500",
  cropland: "#b3891f",
  builtUp: "#8f302a",
  bareSparse: "#99795c",
  snowIce: "#8fa7b5",
  water: "#1f5f9b",
  wetland: "#207a83",
  mangroves: "#0f5747",
  mossLichen: "#6b7f4a",
};

/* Stable stacking order for composition bars: the contract's taxonomy
   order, so the same class always appears in the same position. */
export const LAND_COVER_ORDER: LandCoverClass[] = [
  "treeCover",
  "shrubland",
  "grassland",
  "cropland",
  "builtUp",
  "bareSparse",
  "snowIce",
  "water",
  "wetland",
  "mangroves",
  "mossLichen",
];
