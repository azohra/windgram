/* Build-time facts about the released packages, imported from their own
   manifests so a docs page can print the current versions without
   hand-maintaining them. One home for the ugly relative paths. */
import packageJson from "../../../../toolkit/package.json";
import pyproject from "../../../../pipeline/pyproject.toml?raw";

/** The npm package version this site was built against. */
export const WINDGRAM_PACKAGE_VERSION: string = packageJson.version;

/** The Python pipeline version, read from pipeline/pyproject.toml. */
const pyprojectVersion = pyproject.match(/^version = "([^"]+)"$/m);
if (!pyprojectVersion) throw new Error("pipeline/pyproject.toml has no version");
export const PIPELINE_VERSION: string = pyprojectVersion[1];
