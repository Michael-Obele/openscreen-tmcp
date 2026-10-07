import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UpstreamClient } from "../src/upstream/client";
import { dispatch, dispatchProblem } from "../src/upstream/dispatch";
import { runEffect } from "../src/tools/effect";
import { runRead } from "../src/tools/read";
import { runTrim } from "../src/tools/trim";
import { framesFixture, scriptedClient, TEST_CONFIG } from "./helpers";

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("dispatch validation — precise per-action errors", () => {
  test("names the missing fields, action and tool (the plan’s example)", () => {
    expect(
      dispatchProblem("trim", "set", undefined, { trimRangeId: "t1" }),
    ).toBe('trim action:"set" also needs startSec, endSec.');
    expect(dispatchProblem("trim", "add", undefined, { startSec: 1 })).toBe(
      'trim action:"add" also needs endSec.',
    );
    expect(dispatchProblem("clip", "move", undefined, { clipId: "c1" })).toBe(
      'clip action:"move" also needs beforeClipId.',
    );
  });

  test("unknown action lists the valid ones", () => {
    const problem = dispatchProblem("trim", "nope", undefined, {});
    expect(problem).toContain('Unknown action "nope" for trim.');
    expect(problem).toContain("add | addMany | set | remove");
  });

  test("effect requires kind for add/set, ignores it for remove", () => {
    expect(dispatchProblem("effect", "add", undefined, {})).toContain(
      "also needs kind",
    );
    expect(
      dispatchProblem("effect", "remove", "zoom", { id: "m1" }),
    ).toBeNull();
    expect(
      dispatchProblem("effect", "remove", "bogus", { id: "m1" }),
    ).toBeNull();
  });

  test("effect zoom add requires a span unless regions provide them", () => {
    expect(dispatchProblem("effect", "add", "zoom", { depth: 2 })).toContain(
      "also needs startSec, endSec",
    );
    expect(
      dispatchProblem("effect", "add", "zoom", {
        regions: [{ startSec: 1, endSec: 2 }],
      }),
    ).toBeNull();
  });

  test("read cursor/transcript/words require assetId", () => {
    expect(dispatchProblem("read", "transcript", undefined, {})).toBe(
      'read action:"transcript" also needs assetId.',
    );
    expect(dispatchProblem("read", "project", undefined, {})).toBeNull();
  });
});

describe("dispatch mapping — the traps, encoded", () => {
  test("trim actions map to their upstream tools with only the needed args", async () => {
    const { client, calls } = scriptedClient();

    await runTrim({ action: "add", startSec: 1.5, endSec: 3.25 }, client);
    await runTrim(
      { action: "addMany", ranges: [{ startSec: 0, endSec: 1 }] },
      client,
    );
    await runTrim(
      { action: "set", trimRangeId: "t1", startSec: 2, endSec: 4 },
      client,
    );
    await runTrim({ action: "remove", trimRangeId: "t1" }, client);

    expect(calls).toEqual([
      { name: "addTrim", args: { startSec: 1.5, endSec: 3.25 } },
      { name: "addTrims", args: { ranges: [{ startSec: 0, endSec: 1 }] } },
      { name: "setTrim", args: { trimRangeId: "t1", startSec: 2, endSec: 4 } },
      { name: "removeTrim", args: { trimRangeId: "t1" } },
    ]);
  });

  test("zoom bulk via regions → addZooms; single span → addZoom", async () => {
    const { client, calls } = scriptedClient();

    await runEffect(
      {
        action: "add",
        kind: "zoom",
        startSec: 1,
        endSec: 2,
        depth: 3,
        focusX: 0.5,
        focusY: 0.5,
      },
      client,
    );
    await runEffect(
      {
        action: "add",
        kind: "zoom",
        depth: 4,
        regions: [
          { startSec: 1, endSec: 2 },
          { startSec: 5, endSec: 6 },
        ],
      },
      client,
    );

    expect(calls).toEqual([
      {
        name: "addZoom",
        args: { startSec: 1, endSec: 2, depth: 3, focusX: 0.5, focusY: 0.5 },
      },
      {
        name: "addZooms",
        args: {
          depth: 4,
          regions: [
            { startSec: 1, endSec: 2 },
            { startSec: 5, endSec: 6 },
          ],
        },
      },
    ]);
  });

  test("lane is renamed to upstream’s kind on the way out", async () => {
    const { client, calls } = scriptedClient();

    await runEffect(
      {
        action: "add",
        kind: "audio",
        assetId: "a1",
        startSec: 0,
        endSec: 5,
        offsetSec: 1,
        gainDb: -3,
        lane: "music",
      },
      client,
    );

    expect(calls).toEqual([
      {
        name: "addAudio",
        args: {
          assetId: "a1",
          startSec: 0,
          endSec: 5,
          offsetSec: 1,
          gainDb: -3,
          kind: "music",
        },
      },
    ]);
  });

  test("every effect remove kind dispatches to removeModifier by id", async () => {
    const { client, calls } = scriptedClient();

    for (const kind of [
      "zoom",
      "speed",
      "annotation",
      "camera",
      "audio",
    ] as const) {
      await runEffect({ action: "remove", kind, id: "m1" }, client);
    }

    expect(calls.map((c) => c.name)).toEqual(Array(5).fill("removeModifier"));
    expect(calls.every((c) => c.args.id === "m1")).toBe(true);
  });

  test("read project is a no-arg getCurrentDocument", async () => {
    const { client, calls } = scriptedClient();
    const result = await runRead({ action: "project" }, client);
    expect(calls).toEqual([{ name: "getCurrentDocument", args: {} }]);
    expect(result.isError).toBeFalsy();
  });

  test("read cursor passes assetId through", async () => {
    const { client, calls } = scriptedClient();
    await runRead({ action: "cursor", assetId: "asset-9" }, client);
    expect(calls).toEqual([
      { name: "getCursorTrack", args: { assetId: "asset-9" } },
    ]);
  });
});

describe("error surfacing", () => {
  test("upstream isError keeps the verbatim text and adds one line of context", async () => {
    const refusal =
      "Project edits are off. Turn on the switch in the MCP server section.";
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: refusal }],
      isError: true,
    }));

    const result = await runTrim(
      { action: "add", startSec: 1, endSec: 2 },
      client,
    );
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({ type: "text", text: refusal });
    expect(result.content ?? []).toHaveLength(2);
    expect(text(result as never)).toContain(
      "pass its wording to the user verbatim",
    );
  });

  test("unreachable upstream → clear isError, never a stack trace", async () => {
    const failing = new UpstreamClient(TEST_CONFIG, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    const result = await runTrim(
      { action: "add", startSec: 1, endSec: 2 },
      failing,
    );
    expect(result.isError).toBe(true);
    expect(text(result as never)).toContain(
      "OpenScreen's MCP server is not reachable",
    );
    expect(text(result as never)).toContain("AI settings → MCP server");
    expect(text(result as never)).not.toContain("at Object.");
  });
});

describe.skipIf(
  !(existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe")),
)("read frames", () => {
  test("returns an image plus the ordered times", async () => {
    const fx = await framesFixture();
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const result = await runRead(
      { action: "frames", mode: "sheet", count: 4 },
      client,
      { dataDir: fx.dataDir, font: "" },
    );

    expect(result.isError).toBeFalsy();
    const kinds = (result.content ?? []).map((c) => c.type);
    expect(kinds).toEqual(["image", "text"]);

    const caption = JSON.parse(
      (result.content?.[1] as { text: string }).text,
    ) as { times: number[]; width: number; file: string };
    expect(caption.times).toHaveLength(4);
    expect(caption.file).toBe(fx.clipPath);
    expect(caption.width).toBeGreaterThan(0);

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test('mode:"frame" with several times errors instead of rendering only the first', async () => {
    const fx = await framesFixture();
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const result = await runRead(
      { action: "frames", mode: "frame", at: [1, 2, 3] },
      client,
      { dataDir: fx.dataDir, font: "" },
    );

    // An error, not a still whose caption lists times the pixels lack.
    expect(result.isError).toBe(true);
    expect((result.content ?? []).map((c) => c.type)).toEqual(["text"]);
    const message = (result.content?.[0] as { text: string }).text;
    expect(message).toContain("3 times");
    expect(message).toContain('mode:"sheet"');
    expect(message).toContain("single `at`");

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test("a resolution failure is isError with the message, not a throw", async () => {
    const fx = await framesFixture();
    await rm(fx.clipPath, { force: true });
    await rm(join(fx.dataDir, "projects", "proj_1.openscreen"), {
      force: true,
    });
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const result = await runRead(
      { action: "frames" },
      client,
      { dataDir: fx.dataDir, font: "" },
    );
    expect(result.isError).toBe(true);
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    expect(text).toContain("Tried:");
    expect(text).not.toContain("at Object.");

    await rm(fx.dataDir, { recursive: true, force: true });
  });
});
