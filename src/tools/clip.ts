import { defineTool } from "tmcp/tool";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient } from "../upstream/client";
import { dispatch } from "../upstream/dispatch";

export const ClipInput = v.object({
  action: v.picklist(["setRange", "move", "remove", "replace"]),
  clipId: v.optional(v.string()),
  sourceStartSec: v.optional(v.number()),
  sourceEndSec: v.optional(v.number()),
  beforeClipId: v.optional(v.string()),
  intervals: v.optional(
    v.array(v.object({ startSec: v.number(), endSec: v.number() })),
  ),
});
export type ClipInput = v.InferInput<typeof ClipInput>;

export function runClip(
  input: ClipInput,
  client: UpstreamClient,
): Promise<CallToolResult<undefined>> {
  return dispatch(client, "clip", input.action, undefined, input);
}

export function clipTool(client: UpstreamClient) {
  return defineTool(
    {
      name: "clip",
      description:
        "Change a clip's in/out points, reorder, delete, or rebuild the timeline. " +
        "sourceStartSec/sourceEndSec are SOURCE seconds of the original file. Actions: " +
        "setRange (clipId, sourceStartSec, sourceEndSec) · " +
        "move (clipId, beforeClipId — one call per clip that moves) · " +
        "remove (clipId — real deletion) · " +
        "replace (intervals — rebuilds the timeline from kept intervals; sorts them, so it " +
        "cannot reorder — use move for that).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      schema: ClipInput,
    },
    (input) => runClip(input, client),
  );
}
