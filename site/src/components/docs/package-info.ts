/* Build-time facts about the released `windgram` npm package, imported from
   the workspace's own package.json so a docs page can print the current
   version without hand-maintaining it. One home for the ugly relative path. */
import packageJson from "../../../../packages/windgram/package.json";

/** The npm package version this site was built against. */
export const WINDGRAM_PACKAGE_VERSION: string = packageJson.version;
