/* One home for the link-preview card. The PNG in site/public/ is rasterized
   by scripts/generate-doc-figures.mjs from its drift-checked SVG source
   (assets/social-card.svg). Both heads — Starlight's (astro.config.mjs) and
   the custom layout's (src/layouts/Base.astro) — compose their tags from
   these facts; the origin comes from the config's `site` on each side. */
export const SOCIAL_CARD = {
  path: "/social-card.png",
  width: "1200",
  height: "630",
  alt: "Windgram — forecast profiles for soaring: the project wordmark beside a package-rendered windgram chart.",
};
