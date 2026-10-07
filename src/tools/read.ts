import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient, ToolInfo } from "../upstream/client";
import type { FramesConfig } from "../config";
import { loadFramesConfig } from "../config";
import { FramesError } from "../frames/errors";
import { resolveAsset } from "../frames/resolve";
import { frameTimes, renderFrames } from "../frames/ffmpeg";
import {
  UPSTREAM_TOOL_NAMES,
  claimCounts,
  dispatch,
  staticVerdict,
} from "../upstream/dispatch";
import { describeError, toToolError } from "../upstream/errors";

export const ReadInput = v.object({
  action: v.picklist([
    "project",
    "cursor",
    "transcript",
    "words",
    "frames",
    "upstream",
  ]),
  assetId: v.optional(v.string()),
  /** frames: sheet (default, one image of N tiles) or frame (one still). */
  mode: v.optional(v.picklist(["sheet", "frame"])),
  /** frames: exact SOURCE seconds; wins over count. */
  at: v.optional(v.array(v.number())),
  /** frames: 1..16 evenly spaced frames when `at` is absent. Default 6. */
  count: v.optional(v.number()),
  /** frames: window over the source, default the whole asset. */
  startSec: v.optional(v.number()),
  endSec: v.optional(v.number()),
  /** frames: low (default, cheap JPEG) or high (full-size PNG). */
  detail: v.optional(v.picklist(["low", "high"])),
  /** frames: skip path resolution and read this file instead. */
  path: v.optional(v.string()),
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

/**
 * `read action:"frames"` — the only action that leaves this process. ffmpeg
 * reads the recording file; upstream is never asked for an image it does not
 * have. Failures the model can fix arrive as `FramesError` and are rendered
 * verbatim.
 */
async function framesAction(
  input: ReadInput,
  client: UpstreamClient,
  framesCfg: FramesConfig,
): Promise<CallToolResult<undefined>> {
  const mode = input.mode ?? "sheet";
  const detail = input.detail ?? "low";

  const resolved = await resolveAsset({
    dataDir: framesCfg.dataDir,
    client,
    assetId: input.assetId,
    path: input.path,
  });

  const startSec = Math.max(0, input.startSec ?? 0);
  const endSec = Math.min(
    input.endSec ?? resolved.durationSec,
    resolved.durationSec,
  );

  const times = frameTimes({
    count: input.count,
    at: input.at,
    startSec,
    endSec,
  });

  const image = await renderFrames({
    path: resolved.path,
    times,
    mode,
    detail,
    font: framesCfg.font,
  });

  return tool.mix([
    tool.media("image", image.base64, image.mimeType),
    tool.text(
      JSON.stringify(
        {
          mode,
          detail,
          times,
          width: image.width,
          height: image.height,
          assetId: resolved.assetId,
          file: resolved.path,
          foundVia: resolved.via,
          durationSec: resolved.durationSec,
          timeBase:
            "source seconds — the recording, not the edited timeline; trims and transcript share this base, zooms do not",
        },
        null,
        2,
      ),
    ),
  ]);
}

export async function runRead(
  input: ReadInput,
  client: UpstreamClient,
  framesCfg: FramesConfig = loadFramesConfig(),
): Promise<CallToolResult<undefined>> {
  if (input.action === "frames") {
    try {
      return await framesAction(input, client, framesCfg);
    } catch (err) {
      if (err instanceof FramesError) {
        console.error("[openscreen-tmcp]", err.message);
        return tool.error(err.message);
      }
      return toToolError(err, client.url);
    }
  }
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
        'frames (SEE the video: mode "sheet" (default) tiles `count` sampled frames into one image ' +
        'with timestamps burned in, mode "frame" gives one still at `at`; times are SOURCE seconds, ' +
        'detail "low" (default, cheap) or "high"; optional at/count/startSec/endSec/assetId/path), ' +
        "upstream (coverage report: OpenScreen’s live tool list vs this proxy’s mappings). " +
        'Get assetId from action:"project" → assets[]. Look before you edit: frames first, then zoom or trim.',
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
