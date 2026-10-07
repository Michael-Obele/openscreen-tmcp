import { defineTool } from "tmcp/tool";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient } from "../upstream/client";
import { dispatch } from "../upstream/dispatch";

export const CaptionInput = v.object({
  wordId: v.string(),
  text: v.string(),
});
export type CaptionInput = v.InferInput<typeof CaptionInput>;

export function runCaption(
  input: CaptionInput,
  client: UpstreamClient,
): Promise<CallToolResult<undefined>> {
  // No action enum: one operation, so `caption` dispatches directly.
  return dispatch(client, "caption", "", undefined, input);
}

export function captionTool(client: UpstreamClient) {
  return defineTool(
    {
      name: "caption",
      description:
        "Correct ONE transcript word's burned-in caption text. Needs wordId (from " +
        'read action:"words") and the new text. This is the only write in the transcript ' +
        "family — all transcript reads live in `read` so its readOnlyHint can stay honest. " +
        "One call per word; captions re-render from the transcript, so a correction changes " +
        "the burned-in text.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      schema: CaptionInput,
    },
    (input) => runCaption(input, client),
  );
}
