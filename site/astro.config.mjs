import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { SOCIAL_CARD } from "./src/lib/social-card.mjs";

const contentInputDirectories = ["../scenarios"].map((directory) =>
  fileURLToPath(new URL(directory, import.meta.url)),
);

const siteUrl = "https://windgram.azohra.com";

// Link-preview card for every docs page — facts live in src/lib/social-card.mjs;
// Starlight already emits og:title/og:description and twitter:card, so only
// the image is added here.
const socialCard = new URL(SOCIAL_CARD.path, siteUrl).href;

const watchRepositoryContent = {
  name: "watch-repository-content",
  buildStart() {
    for (const directory of contentInputDirectories) this.addWatchFile(directory);
  },
  configureServer(server) {
    server.watcher.add(contentInputDirectories);
  },
  handleHotUpdate({ file, server }) {
    if (!contentInputDirectories.some((directory) => file.startsWith(`${directory}/`))) return;
    server.moduleGraph.invalidateAll();
    server.ws.send({ type: "full-reload" });
    return [];
  },
};

export default defineConfig({
  site: siteUrl,
  integrations: [
    starlight({
      title: "Windgram",
      description:
        "Documentation for generating, validating, publishing, and rendering open windgram data.",
      favicon: "/favicon.svg",
      head: [
        { tag: "meta", attrs: { property: "og:image", content: socialCard } },
        { tag: "meta", attrs: { property: "og:image:width", content: SOCIAL_CARD.width } },
        { tag: "meta", attrs: { property: "og:image:height", content: SOCIAL_CARD.height } },
        { tag: "meta", attrs: { property: "og:image:alt", content: SOCIAL_CARD.alt } },
        { tag: "meta", attrs: { name: "twitter:image", content: socialCard } },
      ],
      customCss: [
        "@fontsource/big-shoulders/700.css",
        "@fontsource/big-shoulders/800.css",
        "@fontsource/ibm-plex-sans/400.css",
        "@fontsource/ibm-plex-sans/500.css",
        "@fontsource/ibm-plex-sans/600.css",
        "@fontsource/ibm-plex-sans/700.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        "@fontsource/ibm-plex-mono/600.css",
        "/src/styles/starlight.css",
      ],
      components: {
        ThemeProvider: "./src/components/starlight/ThemeProvider.astro",
        SiteTitle: "./src/components/starlight/SiteTitle.astro",
        Header: "./src/components/starlight/Header.astro",
        Footer: "./src/components/starlight/Footer.astro",
        MobileMenuToggle: "./src/components/starlight/MobileMenuToggle.astro",
        MobileMenuFooter: "./src/components/starlight/MobileMenuFooter.astro",
      },
      editLink: {
        baseUrl: "https://github.com/azohra/windgram/edit/main/site/",
      },
      pagefind: true,
      sidebar: [
        {
          label: "Start here",
          items: [
            { slug: "docs", label: "Choose your path" },
            { slug: "docs/overview", label: "Project overview" },
            { slug: "docs/getting-started", label: "Getting started" },
          ],
        },
        {
          label: "Publish for a club",
          items: [
            { slug: "docs/publish/configure-launches", label: "Configure launches" },
            { slug: "docs/models/choosing", label: "Choose models" },
            { slug: "docs/publish/run-one-model", label: "Run one model" },
            { slug: "docs/publish/schedule-builds", label: "Schedule builds" },
            { slug: "docs/publish/static-output", label: "Publish static output" },
            { slug: "docs/publish/downstream-access", label: "Downstream access" },
          ],
        },
        {
          label: "TypeScript",
          items: [
            { slug: "docs/typescript/render-first-windgram", label: "Render a first windgram" },
            { slug: "docs/typescript/contract", label: "Contract" },
            { slug: "docs/typescript/transport", label: "Transport" },
            { slug: "docs/typescript/derive", label: "Pure derivations" },
            { slug: "docs/typescript/analyze", label: "Analyze a profile" },
            { slug: "docs/typescript/compare", label: "Compare profiles" },
            { slug: "docs/typescript/scene", label: "Scene graph" },
            { slug: "docs/typescript/wire-an-inspector", label: "Wire an inspector" },
            { slug: "docs/typescript/svg", label: "SVG renderer and key" },
            { slug: "docs/typescript/defaults-and-tokens", label: "Defaults and tokens" },
          ],
        },
        {
          label: "Python pipeline",
          items: [
            { slug: "docs/python/pipeline-architecture", label: "Pipeline architecture" },
            { slug: "docs/python/derivation-science", label: "Windgram derivations" },
            { slug: "docs/python/builder-contract", label: "Builder contract" },
            { slug: "docs/python/adding-a-model", label: "Add a model" },
            { slug: "docs/python/provider-transports", label: "Provider transports" },
          ],
        },
        {
          label: "Data",
          items: [
            { slug: "docs/data/catalogue", label: "Model catalogue" },
            { slug: "docs/data/manifest", label: "Manifest" },
            { slug: "docs/reference/profile-document", label: "Profile" },
            { slug: "docs/reference/smoke-document", label: "Smoke document" },
            { slug: "docs/reference/observation-document", label: "Observation document" },
            { slug: "docs/reference/site-context-document", label: "Site context" },
            { slug: "docs/data/ensemble-values", label: "Ensemble values" },
            { slug: "docs/data/history", label: "History" },
            { slug: "docs/data/versioning", label: "Versioning" },
          ],
        },
        {
          label: "Learn",
          items: [
            { slug: "docs/learn/reading-a-windgram", label: "Reading a windgram" },
            { slug: "docs/learn/the-mountain-the-model-sees", label: "The mountain the model sees" },
            { slug: "docs/learn/smoke-and-thermals", label: "Smoke and thermals" },
            { slug: "docs/learn/synthetic-teaching-data", label: "Synthetic teaching data" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "docs/reference/model-capabilities", label: "Model capabilities" },
            { slug: "docs/reference/forecast-model-feeds", label: "Forecast model feeds" },
            { slug: "docs/reference/schemas-and-units", label: "Schemas and units" },
          ],
        },
        {
          label: "Contribute",
          items: [
            { slug: "docs/contribute/development", label: "Development setup" },
            { slug: "docs/contribute/tests", label: "Tests by change" },
            { slug: "docs/contribute/scenario-authoring", label: "Author a scenario" },
            { slug: "docs/contribute/visual-authoring", label: "Author an infographic" },
            { slug: "docs/contribute/releases", label: "Release boundaries" },
          ],
        },
      ],
    }),
    mdx(),
  ],
  vite: {
    plugins: [watchRepositoryContent],
    server: { fs: { allow: [".."] } },
  },
});
