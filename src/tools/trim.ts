import { defineTool } from "tmcp/tool";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient } from "../upstream/client";
import { dispatch } from "../upstream/dispatch";

export const TrimInput = v.object({
  action: v.picklist(["add", "addMany", "set", "remove"]),
  startSec: v.optional(v.number()),
  endSec: v.optional(v.number()),
  ranges: v.optional(
    v.array(v.object({ startSec: v.number(), endSec: v.number() })),
  ),
  trimRangeId: v.optional(v.string()),
});
export type TrimInput = v.InferInput<typeof TrimInput>;

export function runTrim(
  input: TrimInput,
  client: UpstreamClient,
): Promise<CallToolResult<undefined>> {
  return dispatch(client, "trim", input.action, undefined, input);
}

export function trimTool(client: UpstreamClient) {
  return defineTool(
    {
      name: "trim",
      description:
        "Remove or adjust dead air inside a placed clip. Times are SOURCE seconds of the " +
        "original recording file, not timeline positions. Actions: add (startSec, endSec) · " +
        "addMany (ranges: [{startSec,endSec}] — prefer this for silence removal: one call, many spans) · " +
        "set (trimRangeId, startSec, endSec) · remove (trimRangeId — undoes a cut; that span plays again). " +
        "Trims are real, in-app-undoable deletions.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      schema: TrimInput,
    },
    (input) => runTrim(input, client),
  );
}
