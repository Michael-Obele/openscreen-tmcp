import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient, ToolInfo } from "../upstream/client";
import {
  UPSTREAM_TOOL_NAMES,
  claimCounts,
  dispatch,
  staticVerdict,
} from "../upstream/dispatch";
import { describeError, toToolError } from "../upstream/errors";

export const ReadInput = v.object({
  action: v.picklist(["project", "cursor", "transcript", "words", "upstream"]),
  assetId: v.optional(v.string()),
});
export type ReadInput = v.InferInput<typeof ReadInput>;

/**
 * `read action:"upstream"` — the drift diagnostic. Reports upstream's live
 * tool list against our dispatch table: anything upstream serves that we do
 * not expose (`unmapped`) and anything we map that upstream dropped
 * (`staleMappings`). With OpenScreen closed it still answers from the static
 * 25-tool baseline, flagged as an error so the unreachable app is visible.
 */
async function coverageAction(client: UpstreamClient) {
  let live: ToolInfo[];
  try {
    live = await client.listTools(true);
  } catch (err) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `${describeError(err, client.url)}\n${staticVerdict()}\nLive drift check skipped — start OpenScreen and retry.`,
        },
      ],
    };
  }

  const claims = claimCounts();
  const unmapped = live
    .filter((entry) => !claims.has(entry.name))
    .map((entry) => entry.name);
  const staleMappings = UPSTREAM_TOOL_NAMES.filter(
    (name) => !live.some((entry) => entry.name === name),
  );

  return tool.text(
    JSON.stringify(
      {
        upstream: client.info,
        upstreamToolCount: live.length,
        upstreamTools: live.map((entry) => entry.name).sort(),
        mappedByUs: [...claims.keys()].sort(),
        unmapped,
        staleMappings,
        verdict:
          unmapped.length === 0 && staleMappings.length === 0
            ? `covered: all ${live.length} live upstream tools are reachable through the 6 wrapper tools.`
            : "DRIFT DETECTED — update src/upstream/dispatch.ts; test/coverage.test.ts fails until it matches.",
      },
      null,
      2,
    ),
  );
}

export async function runRead(
  input: ReadInput,
  client: UpstreamClient,
): Promise<CallToolResult<undefined>> {
  if (input.action === "upstream") {
    try {
      return await coverageAction(client);
    } catch (err) {
      return toToolError(err, client.url);
    }
  }
  return dispatch(client, "read", input.action, undefined, input);
}

export function readTool(client: UpstreamClient) {
  return defineTool(
    {
      name: "read",
      description:
        "Snapshot the open OpenScreen project — read-only, call freely. Actions: project " +
        "(assets with durations, placed clips, trims, modifiers — always start here), " +
        "cursor (recorded pointer track; needs assetId; only meaningful when assets[].hasCursorTelemetry), " +
        "transcript (speech and silence segments with start/end seconds; needs assetId), " +
        "words (word-level ids for caption; needs assetId), " +
        "upstream (coverage report: OpenScreen’s live tool list vs this proxy’s mappings). " +
        'Get assetId from action:"project" → assets[].',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      schema: ReadInput,
    },
    (input) => runRead(input, client),
  );
}
