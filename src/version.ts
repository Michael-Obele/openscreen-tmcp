/**
 * The package version — read from `package.json`, the single source of
 * truth. release-please bumps `package.json` only, so deriving here keeps
 * the MCP `serverInfo` / upstream `clientInfo` in sync automatically.
 */
import pkg from "../package.json";

export const VERSION: string = pkg.version;
