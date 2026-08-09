/* Typecheck the documentation's TypeScript code fences.
 *
 * Extracts every ```ts / ```typescript fence from the docs portal MDX
 * (site/src/content/docs/docs/**\/*.mdx) and the repository README files
 * (README.md, packages/*\/README.md), writes each fence to a temporary
 * project whose tsconfig maps the `windgram/*` import specifiers onto the
 * built package's type declarations (packages/windgram/dist/*\/index.d.ts),
 * and runs a single `tsc --noEmit` over all of them. A documented example
 * that no longer compiles against the released surface is a red build.
 *
 * Requires the package to be built first: `pnpm --dir packages/windgram build`
 * (the root `doc-fences:check` script does both).
 *
 * Opting a fence out: fences are complete, self-contained examples by
 * convention. A deliberately partial ts fence is skipped by placing an HTML
 * comment on the nearest non-blank line directly above its opening fence:
 *
 *     <!-- windgram-doc-fence: ignore -->
 *     ```ts title="excerpt.ts"
 *
 * Non-TypeScript fences (sh, json, text, css, mdx, …) are always skipped.
 *
 * Usage:
 *     node scripts/check-doc-fences.mjs [path ...]
 *
 * With no arguments the default documentation set above is scanned. Paths
 * (files, or directories walked recursively for .md/.mdx) replace the
 * default set — used by CI experiments and to prove failure detection
 * against a scratch file.
 *
 * Exit codes: 0 all fences compile; 1 type errors; 2 setup/usage error.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "windgram");
const IGNORE_MARKER = "windgram-doc-fence: ignore";

function fail(message) {
  console.error(`check-doc-fences: ${message}`);
  process.exit(2);
}

/** Recursively collect .md/.mdx files under a directory. */
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(md|mdx)$/.test(entry.name)) out.push(full);
  }
}

/** The default documentation set: portal MDX plus the README files. */
function defaultDocFiles() {
  const files = [];
  walk(join(repoRoot, "site", "src", "content", "docs", "docs"), files);
  const rootReadme = join(repoRoot, "README.md");
  if (existsSync(rootReadme)) files.push(rootReadme);
  const packagesDir = join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      const readme = join(packagesDir, entry.name, "README.md");
      if (entry.isDirectory() && existsSync(readme)) files.push(readme);
    }
  }
  return files;
}

function docFilesFromArgs(args) {
  const files = [];
  for (const arg of args) {
    const full = resolve(arg);
    if (!existsSync(full)) fail(`no such file or directory: ${arg}`);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

/**
 * Extract ts/typescript fences from one markdown/MDX file.
 * Returns { fences: [{ openLine, body }], ignored } where openLine is the
 * 1-based line of the opening ``` and body starts on openLine + 1.
 */
function extractFences(text) {
  const lines = text.split("\n");
  const fences = [];
  let ignored = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const open = lines[i].match(/^(\s*)```(\w+)/);
    if (!open) continue;
    const indent = open[1];
    const language = open[2].toLowerCase();
    // Find the matching closing fence regardless of language so non-ts
    // fences are skipped as blocks, not scanned line by line.
    let close = i + 1;
    while (close < lines.length && !/^\s*```\s*$/.test(lines[close])) close += 1;
    if (language === "ts" || language === "typescript") {
      let previous = i - 1;
      while (previous >= 0 && lines[previous].trim() === "") previous -= 1;
      if (previous >= 0 && lines[previous].includes(IGNORE_MARKER)) {
        ignored += 1;
      } else {
        const body = lines
          .slice(i + 1, close)
          .map((line) => (indent && line.startsWith(indent) ? line.slice(indent.length) : line))
          .join("\n");
        fences.push({ openLine: i + 1, body });
      }
    }
    i = close;
  }
  return { fences, ignored };
}

const docFiles =
  process.argv.length > 2 ? docFilesFromArgs(process.argv.slice(2)) : defaultDocFiles();
if (docFiles.length === 0) fail("no documentation files to scan");

const distMarker = join(packageDir, "dist", "contract", "index.d.ts");
if (!existsSync(distMarker)) {
  fail(`built package types not found at ${distMarker} — run: pnpm --dir packages/windgram build`);
}

// The temp project lives under the package's node_modules so tsc's upward
// walk finds packages/windgram/node_modules/@types (for `types: ["node"]`).
const tempDir = join(packageDir, "node_modules", ".cache", "windgram-doc-fences");
rmSync(tempDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

/** tempBasename -> { docFile, openLine } for remapping tsc diagnostics. */
const sources = new Map();
const perFile = new Map(); // docFile -> { fences, ignored, errors: [] }

for (const docFile of docFiles) {
  const { fences, ignored } = extractFences(readFileSync(docFile, "utf-8"));
  perFile.set(docFile, { fences: fences.length, ignored, errors: [] });
  for (const fence of fences) {
    // Dots are replaced too: a leading "." (paths outside the repo relativize
    // to "../…") would make tsc treat the temp file as hidden and skip it.
    const slug = relative(repoRoot, docFile)
      .replace(/[^A-Za-z0-9-]+/g, "__")
      .replace(/^_+/, "");
    const basename = `${slug}.L${fence.openLine}.ts`;
    // A fence with no import/export is still checked as its own module so
    // sibling fences cannot collide; the appended line sits past the body
    // and never shifts diagnostic line numbers.
    const needsModuleMarker = !/^\s*(import|export)\b/m.test(fence.body);
    writeFileSync(
      join(tempDir, basename),
      needsModuleMarker ? `${fence.body}\nexport {};\n` : fence.body,
    );
    sources.set(basename, { docFile, openLine: fence.openLine });
  }
}

const tsconfig = {
  compilerOptions: {
    target: "es2022",
    module: "es2022",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
    lib: ["es2022"],
    baseUrl: ".",
    // The docs import the published specifiers; map them to the built types.
    paths: { "windgram/*": [join(packageDir, "dist", "*", "index.d.ts")] },
  },
  include: ["*.ts"],
};
writeFileSync(join(tempDir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);

const requireFromPackage = createRequire(join(packageDir, "package.json"));
const tscBin = requireFromPackage.resolve("typescript/bin/tsc");

const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--pretty", "false"], {
  cwd: tempDir,
  encoding: "utf-8",
});
if (result.error) fail(`could not run tsc: ${result.error.message}`);

let unattributed = 0;
for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
  const diagnostic = line.match(/^(.+\.ts)\((\d+),(\d+)\): (error TS\d+: .*)$/);
  if (!diagnostic) {
    if (/error TS\d+/.test(line) && line.trim() !== "") {
      console.error(line);
      unattributed += 1;
    }
    continue;
  }
  const source = sources.get(diagnostic[1]);
  if (!source) {
    console.error(line);
    unattributed += 1;
    continue;
  }
  const sourceLine = source.openLine + Number(diagnostic[2]);
  perFile
    .get(source.docFile)
    .errors.push(`${relative(repoRoot, source.docFile)}:${sourceLine}:${diagnostic[3]} ${diagnostic[4]}`);
}

let failed = 0;
let checked = 0;
for (const [docFile, report] of perFile) {
  if (report.fences === 0 && report.ignored === 0) continue;
  checked += report.fences;
  const label = relative(repoRoot, docFile);
  const counts =
    `${report.fences} fence${report.fences === 1 ? "" : "s"}` +
    (report.ignored > 0 ? `, ${report.ignored} ignored` : "");
  if (report.errors.length === 0) {
    console.log(`ok   ${label} (${counts})`);
  } else {
    failed += 1;
    console.error(`FAIL ${label} (${counts})`);
    for (const error of report.errors) console.error(`     ${error}`);
  }
}

if (failed > 0 || unattributed > 0) {
  console.error(
    `\ncheck-doc-fences: type errors in ${failed} documentation file${failed === 1 ? "" : "s"}` +
      (unattributed > 0 ? ` (+${unattributed} unattributed diagnostics)` : ""),
  );
  process.exit(1);
}
console.log(`\ncheck-doc-fences: ${checked} fences compile against the built package`);
