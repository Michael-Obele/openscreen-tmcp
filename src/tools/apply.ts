import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import type { CallToolResult } from "tmcp";
import type { UpstreamClient } from "../upstream/client";
import { CaptionInput, runCaption } from "./caption";
import { ClipInput, runClip } from "./clip";
import { EffectInput, runEffect } from "./effect";
import { TrimInput, runTrim } from "./trim";

export const ApplyInput = v.object({
  ops: v.pipe(
    v.array(
      v.object({
        tool: v.picklist(["trim", "clip", "effect", "caption"]),
        input: v.record(v.string(), v.unknown()),
      }),
    ),
    v.maxLength(50),
  ),
  stopOnError: v.optional(v.boolean(), true),
});
export type ApplyInput = v.InferInput<typeof ApplyInput>;

type OpTool = "trim" | "clip" | "effect" | "caption";

/**
 * Each op is re-validated against its target tool's *own* schema, so an
 * invalid op produces a precise per-op error naming the index — not a
 * generic failure. `read` and `apply` are deliberately absent: a read is not
 * an edit, and nesting apply invites runaway batches.
 */
const OPS: Record<
  OpTool,
  {
    schema: v.GenericSchema;
    run: (
      input: any,
      client: UpstreamClient,
    ) => Promise<CallToolResult<undefined>>;
  }
> = {
  trim: { schema: TrimInput, run: (input, client) => runTrim(input, client) },
  clip: { schema: ClipInput, run: (input, client) => runClip(input, client) },
  effect: {
    schema: EffectInput,
    run: (input, client) => runEffect(input, client),
  },
  caption: {
    schema: CaptionInput,
    run: (input, client) => runCaption(input, client),
  },
};

function issuePath(issue: { path?: ReadonlyArray<{ key?: unknown }> }): string {
  const path = (issue.path ?? [])
    .map((part) => (typeof part.key === "string" ? part.key : ""))
    .filter(Boolean);
  return path.length > 0 ? path.join(".") : "(root)";
}

/**
 * Ordered batch — **not atomic**. OpenScreen has no transaction or rollback:
 * every op lands as it is applied, so a failure partway through leaves the
 * earlier edits in place (undoable in-app with Ctrl/Cmd+Z). The result is
 * honest about exactly that: `applied`, `failedAt`, and the upstream error
 * verbatim. Never described as all-or-nothing.
 */
export async function runApply(
  input: ApplyInput,
  client: UpstreamClient,
): Promise<CallToolResult<undefined>> {
  if (input.ops.length === 0) {
    return tool.error(
      "ops is empty — nothing to apply. Send at least one operation.",
    );
  }

  const stopOnError = input.stopOnError ?? true;
  const results: CallToolResult<undefined>[] = [];
  let applied = 0;
  let failedAt: number | null = null;

  for (const [index, op] of input.ops.entries()) {
    const entry = OPS[op.tool];
    if (!entry) {
      // tmcp's schema rejects this first; keep the guard anyway so a
      // direct invocation fails precisely instead of throwing.
      results.push(
        tool.error(
          `op #${index}: unknown tool "${String(op.tool)}" — valid: trim | clip | effect | caption.`,
        ),
      );
      failedAt = index;
      if (stopOnError) break;
      continue;
    }

    const parsed = v.safeParse(entry.schema, op.input);
    if (!parsed.success) {
      const issues = parsed.issues
        .slice(0, 3)
        .map((issue) => `${issuePath(issue)}: ${issue.message}`)
        .join("; ");
      results.push(
        tool.error(`op #${index} (${op.tool}): invalid input — ${issues}`),
      );
      failedAt = index;
      if (stopOnError) break;
      continue;
    }

    const result = await entry.run(parsed.output, client);
    results.push(result);
    if (result.isError) {
      failedAt = index;
      if (stopOnError) break;
    } else {
      applied++;
    }
  }

  const attempted =
    failedAt === null ? input.ops.length : failedAt + (stopOnError ? 1 : 0);
  const summary =
    failedAt === null
      ? `applied ${applied}/${input.ops.length} ops — all succeeded.`
      : `applied ${applied} of ${input.ops.length} ops; failed at op #${failedAt}${
          stopOnError ? " — stopped there" : " (continued)"
        }. Edits are NOT rolled back: the ${applied} that landed are live in the document (undo in-app with Ctrl/Cmd+Z).${
          attempted < input.ops.length
            ? ` ${input.ops.length - attempted} later ops were not run.`
            : ""
        }`;

  const mixed = tool.mix(results);
  return {
    ...mixed,
    content: [
      { type: "text" as const, text: summary },
      ...(mixed.content ?? []),
    ],
  };
}

export function applyTool(client: UpstreamClient) {
  return defineTool(
    {
      name: "apply",
      description:
        "Apply several edits in one call, in order: ops is a list of " +
        "{tool: trim|clip|effect|caption, input} (max 50), each input shaped exactly like " +
        "that tool's own schema. stopOnError (default true) halts at the first failure. " +
        "Ordered, NOT atomic: OpenScreen has no transaction — landed edits stay landed " +
        "(undo in-app with Ctrl/Cmd+Z). The result reports applied, failedAt, and the " +
        "upstream error verbatim. Excludes read and apply itself.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      schema: ApplyInput,
    },
    (input) => runApply(input, client),
  );
}
