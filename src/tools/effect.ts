import { defineTool } from "tmcp/tool";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient } from "../upstream/client";
import { dispatch } from "../upstream/dispatch";

export const EffectKind = v.picklist([
  "zoom",
  "speed",
  "annotation",
  "camera",
  "audio",
]);

export const EffectInput = v.object({
  action: v.picklist(["add", "set", "remove"]),
  kind: EffectKind,
  id: v.optional(v.string()),

  startSec: v.optional(v.number()),
  endSec: v.optional(v.number()),

  // zoom — depth is an ORDNAL 1..6, focus is frame fractions
  depth: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
  ),
  focusX: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  focusY: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  regions: v.optional(
    v.array(v.object({ startSec: v.number(), endSec: v.number() })),
  ),

  // speed
  speed: v.optional(v.number()),

  // annotation
  text: v.optional(v.string()),
  x: v.optional(v.number()),
  y: v.optional(v.number()),

  // audio — `lane` is renamed to upstream's `kind` on dispatch
  assetId: v.optional(v.string()),
  offsetSec: v.optional(v.number()),
  gainDb: v.optional(v.number()),
  lane: v.optional(v.picklist(["voiceover", "music"])),
});
export type EffectInput = v.InferInput<typeof EffectInput>;

export function runEffect(
  input: EffectInput,
  client: UpstreamClient,
): Promise<CallToolResult<undefined>> {
  return dispatch(client, "effect", input.action, input.kind, input);
}

export function effectTool(client: UpstreamClient) {
  return defineTool(
    {
      name: "effect",
      description:
        "Add, adjust, or delete zooms, speed regions, annotations, camera-fullscreen regions, " +
        "and audio tracks. All spans are VIRTUAL seconds — positions on the edited timeline " +
        "after cuts, not source time. Actions: add | set | remove, each with kind: " +
        "zoom | speed | annotation | camera | audio. add needs: zoom (startSec, endSec, " +
        "depth 1-6 ordinal — 1=1.25x … 6=5x, NOT a multiplier; focusX/focusY 0-1 frame " +
        "fractions; or regions[] for bulk) · speed (startSec, endSec, speed) · " +
        "annotation (startSec, endSec, text, x, y) · camera (startSec, endSec) · " +
        "audio (assetId, startSec, endSec, offsetSec, gainDb, lane voiceover|music). " +
        "set and remove need id.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      schema: EffectInput,
    },
    (input) => runEffect(input, client),
  );
}
