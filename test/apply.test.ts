import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "tmcp";
import { runApply } from "../src/tools/apply";
import { createTools } from "../src/tools";
import { scriptedClient, TEST_CONFIG } from "./helpers";
import { UpstreamClient } from "../src/upstream/client";

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

const OK = { content: [{ type: "text", text: "ok" }] };
const REFUSAL =
  "Project edits are off. Turn on the switch in the MCP server section.";

describe("apply — ordered, NOT atomic", () => {
  test("stops at the first failure and reports exactly what landed", async () => {
    const { client, calls } = scriptedClient((name, _args, index) =>
      index === 2
        ? { content: [{ type: "text", text: REFUSAL }], isError: true }
        : OK,
    );

    const result = await runApply(
      {
        ops: [
          { tool: "trim", input: { action: "add", startSec: 1, endSec: 2 } },
          { tool: "trim", input: { action: "add", startSec: 5, endSec: 6 } },
          {
            tool: "effect",
            input: {
              action: "add",
              kind: "speed",
              startSec: 0,
              endSec: 3,
              speed: 2,
            },
          },
        ],
      },
      client,
    );

    expect(result.isError).toBe(true);
    const summary = text(result as never);
    expect(summary).toContain("applied 2 of 3 ops");
    expect(summary).toContain("failed at op #2 — stopped there");
    expect(summary).toContain("NOT rolled back");
    // The refusal itself is present verbatim, plus dispatch’s context line.
    expect(summary).toContain(REFUSAL);
    expect(summary).toContain("pass its wording to the user verbatim");
    // Ops ran in order; the failing one was last, so nothing after it ran.
    expect(calls.map((c) => c.name)).toEqual([
      "addTrim",
      "addTrim",
      "addSpeed",
    ]);
  });

  test("stopOnError:false keeps going and counts accurately", async () => {
    const { client, calls } = scriptedClient((_name, _args, index) =>
      index === 1
        ? { content: [{ type: "text", text: REFUSAL }], isError: true }
        : OK,
    );

    const result = await runApply(
      {
        ops: [
          { tool: "trim", input: { action: "add", startSec: 1, endSec: 2 } },
          { tool: "trim", input: { action: "add", startSec: 3, endSec: 4 } },
          { tool: "trim", input: { action: "add", startSec: 5, endSec: 6 } },
          { tool: "caption", input: { wordId: "w1", text: "hi" } },
        ],
        stopOnError: false,
      },
      client,
    );

    expect(result.isError).toBe(true);
    const summary = text(result as never);
    expect(summary).toContain("applied 3 of 4 ops");
    expect(summary).toContain("failed at op #1 (continued)");
    expect(calls.map((c) => c.name)).toEqual([
      "addTrim",
      "addTrim",
      "addTrim",
      "setWordText",
    ]);
  });

  test("all-success reports full application and is not an error", async () => {
    const { client, calls } = scriptedClient();
    const result = await runApply(
      {
        ops: [
          { tool: "trim", input: { action: "add", startSec: 1, endSec: 2 } },
          { tool: "caption", input: { wordId: "w1", text: "OpenScreen" } },
        ],
      },
      client,
    );
    expect(result.isError).toBe(false);
    expect(text(result as never)).toContain("applied 2/2 ops — all succeeded");
    expect(calls).toEqual([
      { name: "addTrim", args: { startSec: 1, endSec: 2 } },
      { name: "setWordText", args: { wordId: "w1", text: "OpenScreen" } },
    ]);
  });

  test("an op with an invalid schema fails precisely, naming the index", async () => {
    const { client, calls } = scriptedClient();
    const result = await runApply(
      {
        ops: [
          { tool: "trim", input: { action: "add", startSec: 1, endSec: 2 } },
          { tool: "trim", input: { action: "nope" } },
          { tool: "trim", input: { action: "add", startSec: 7, endSec: 8 } },
        ],
      },
      client,
    );
    expect(result.isError).toBe(true);
    const summary = text(result as never);
    expect(summary).toContain("op #1 (trim): invalid input");
    expect(summary).toContain("applied 1 of 3 ops");
    expect(summary).toContain("1 later ops were not run");
    // Only the first op reached upstream.
    expect(calls.map((c) => c.name)).toEqual(["addTrim"]);
  });

  test("an op missing a required field gets the handler’s precise message", async () => {
    const { client } = scriptedClient();
    const result = await runApply(
      { ops: [{ tool: "trim", input: { action: "set", trimRangeId: "t1" } }] },
      client,
    );
    expect(result.isError).toBe(true);
    expect(text(result as never)).toContain(
      'trim action:"set" also needs startSec, endSec.',
    );
  });

  test("empty ops is a clear error, not a silent no-op", async () => {
    const { client, calls } = scriptedClient();
    const result = await runApply({ ops: [] }, client);
    expect(result.isError).toBe(true);
    expect(text(result as never)).toContain("ops is empty");
    expect(calls).toHaveLength(0);
  });

  test("read and apply are not dispatchable as ops", async () => {
    // tmcp's schema rejects them before any handler runs; runApply guards too.
    const { client } = scriptedClient();
    const result = await runApply(
      { ops: [{ tool: "read" as never, input: { action: "project" } }] },
      client,
    );
    expect(result.isError).toBe(true);
    expect(text(result as never)).toContain('op #0: unknown tool "read"');
    expect(text(result as never)).toContain("trim | clip | effect | caption");
  });
});

describe("registration", () => {
  test("exactly 6 tools register, apply included", () => {
    const tools = createTools(
      new UpstreamClient({ ...TEST_CONFIG, timeoutMs: 100 }),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      "apply",
      "caption",
      "clip",
      "effect",
      "read",
      "trim",
    ]);
    expect(tools).toHaveLength(6);
  });

  test("apply’s execute handler accepts a validated payload end-to-end", async () => {
    const { client, calls } = scriptedClient();
    const tools = createTools(client);
    const apply = tools.find((t) => t.name === "apply");
    expect(apply).toBeDefined();

    const result = (await (
      apply as unknown as {
        execute: (input: unknown) => Promise<CallToolResult<undefined>>;
      }
    ).execute({
      ops: [
        {
          tool: "effect",
          input: { action: "add", kind: "camera", startSec: 4, endSec: 8 },
        },
      ],
    })) as CallToolResult<undefined>;

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      { name: "addCameraFullscreen", args: { startSec: 4, endSec: 8 } },
    ]);
  });
});
