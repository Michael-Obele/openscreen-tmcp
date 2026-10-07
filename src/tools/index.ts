import type { UpstreamClient } from "../upstream/client";
import { applyTool } from "./apply";
import { captionTool } from "./caption";
import { clipTool } from "./clip";
import { effectTool } from "./effect";
import { readTool } from "./read";
import { trimTool } from "./trim";

/**
 * Exactly 6 tools — never a 7th without updating the plan. Order here is the
 * order agents see: read first (start every session with it), then the edit
 * verbs, then the batcher.
 */
export function createTools(client: UpstreamClient) {
  return [
    readTool(client),
    trimTool(client),
    clipTool(client),
    effectTool(client),
    captionTool(client),
    applyTool(client),
  ];
}

/** The expected `tools/list` surface — asserted by test/coverage.test.ts. */
export const TOOL_NAMES = [
  "read",
  "trim",
  "clip",
  "effect",
  "caption",
  "apply",
] as const;
