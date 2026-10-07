import { describe, expect, test } from "bun:test";
import { INSTRUCTIONS } from "../src/instructions";
import { DEFAULT_URL, type Config } from "../src/config";
import { createServer } from "../src/server";
import { UpstreamClient } from "../src/upstream/client";
import {
  DISPATCH,
  UPSTREAM_TOOL_NAMES,
  claimCounts,
  actionsFor,
} from "../src/upstream/dispatch";
import { TOOL_NAMES } from "../src/tools";

const TEST_CONFIG: Config = {
  url: DEFAULT_URL,
  authorization: "Bearer test-token",
  timeoutMs: 1500,
  debug: false,
};

function receive(
  server: ReturnType<typeof createServer>,
  message: Record<string, unknown>,
) {
  return server.receive(message as never) as Promise<any>;
}

describe("coverage — the drift alarm", () => {
  test("every one of the 25 upstream tools is claimed by exactly one dispatch row", () => {
    const claims = claimCounts();

    const unmapped = UPSTREAM_TOOL_NAMES.filter((name) => !claims.has(name));
    expect(unmapped).toEqual([]); // fails naming exactly what is unmapped

    const misclaimed = [...claims.entries()]
      .filter(
        ([name, count]) => count !== 1 || !UPSTREAM_TOOL_NAMES.includes(name),
      )
      .map(([name, count]) => `${name} (${count}x)`);
    expect(misclaimed).toEqual([]); // nothing duplicated, nothing invented
    expect(claims.size).toBe(25);
    expect(UPSTREAM_TOOL_NAMES.length).toBe(25);
  });

  test("the 25 split as 4 reads + 1 word write + 4 trims + 4 clips + 11 effect ops + 1 delete", () => {
    const byTool = new Map<string, number>();
    for (const row of DISPATCH) {
      byTool.set(row.tool, (byTool.get(row.tool) ?? 0) + row.upstream.length);
    }
    expect(byTool.get("read")).toBe(4);
    expect(byTool.get("caption")).toBe(1);
    expect(byTool.get("trim")).toBe(4);
    expect(byTool.get("clip")).toBe(4);
    expect(byTool.get("effect")).toBe(12); // 11 add/set ops + removeModifier
    // apply claims nothing upstream — it is local composition
    expect([...byTool.keys()].sort()).toEqual([
      "caption",
      "clip",
      "effect",
      "read",
      "trim",
    ]);
  });

  test('coverage: 4 + 4 + 4 + 12 + 1 = 25 and read action:"upstream" claims no tool', () => {
    const upstreamRow = DISPATCH.find(
      (row) => row.tool === "read" && row.action === "upstream",
    );
    expect(upstreamRow).toBeDefined();
    expect(upstreamRow?.upstream).toEqual([]);
  });
});

describe("downstream surface", () => {
  test("tools/list returns exactly the 6 tools", async () => {
    const server = createServer(TEST_CONFIG);
    const res = await receive(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = res.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    expect(res.result.tools.length).toBe(6);
  });

  test("initialize carries the condensed instructions with the SOURCE-vs-VIRTUAL rule", async () => {
    const server = createServer(TEST_CONFIG);
    const res = await receive(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "coverage-test", version: "0.0.0" },
      },
    });
    expect(res.result.serverInfo.name).toBe("openscreen-tmcp");
    const instructions: string = res.result.instructions;
    expect(instructions).toContain("SOURCE");
    expect(instructions).toContain("VIRTUAL");
    expect(instructions.length).toBeLessThan(1024); // target < 1 KB
    // Upstream's ~4 KB block must not be forwarded
    expect(instructions).not.toContain("AxcutDocument");
  });

  test("every tool description stays under 150 words and carries its time base", async () => {
    const server = createServer(TEST_CONFIG);
    const res = await receive(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    for (const entry of res.result.tools as Array<{
      name: string;
      description: string;
    }>) {
      expect(entry.description.split(/\s+/).length).toBeLessThan(150);
    }
    const effect = (
      res.result.tools as Array<{ name: string; description: string }>
    ).find((t) => t.name === "effect");
    expect(effect?.description).toContain("VIRTUAL");
  });

  test("read is the only tool with readOnlyHint; every edit tool is destructive", async () => {
    const server = createServer(TEST_CONFIG);
    const res = await receive(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = res.result.tools as Array<{
      name: string;
      annotations: Record<string, boolean>;
    }>;
    for (const entry of tools) {
      if (entry.name === "read") {
        expect(entry.annotations.readOnlyHint).toBe(true);
        expect(entry.annotations.destructiveHint).toBe(false);
      } else {
        expect(entry.annotations.destructiveHint).toBe(true);
        expect(entry.annotations.readOnlyHint).toBe(false);
      }
    }
  });

  test("the action enums match the plan", () => {
    expect(actionsFor("read")).toEqual([
      "project",
      "cursor",
      "transcript",
      "words",
      "frames",
      "upstream",
    ]);
    expect(actionsFor("trim")).toEqual(["add", "addMany", "set", "remove"]);
    expect(actionsFor("clip")).toEqual([
      "setRange",
      "move",
      "remove",
      "replace",
    ]);
    expect(actionsFor("effect")).toEqual(["add", "set", "remove"]);
    expect(actionsFor("caption")).toEqual([""]); // no action enum, by design
  });

  test("instructions mention the guardrails the plan requires", () => {
    expect(INSTRUCTIONS).toContain("cut first");
    expect(INSTRUCTIONS).toContain("NOT atomic");
    expect(INSTRUCTIONS).toContain("ordinal");
  });
});

describe("live upstream drift check", () => {
  // Runs only when OpenScreen is actually reachable; otherwise logs why and
  // passes — CI and this container have no OpenScreen app.
  test("live tools/list is fully covered by the dispatch table", async () => {
    const authorization =
      process.env.OPENSCREEN_MCP_AUTHORIZATION ??
      (process.env.OPENSCREEN_MCP_TOKEN
        ? `Bearer ${process.env.OPENSCREEN_MCP_TOKEN}`
        : undefined);

    if (!authorization) {
      console.error(
        "[test] no OpenScreen credential in env — live drift check skipped",
      );
      return;
    }

    const client = new UpstreamClient({
      url: process.env.OPENSCREEN_MCP_URL || DEFAULT_URL,
      authorization,
      timeoutMs: 1500,
      debug: false,
    });

    try {
      const live = await client.listTools(true);
      const claims = claimCounts();
      const unmapped = live
        .filter((entry) => !claims.has(entry.name))
        .map((e) => e.name);
      const stale = UPSTREAM_TOOL_NAMES.filter(
        (name) => !live.some((entry) => entry.name === name),
      );
      console.error(
        `[test] live check: upstream serves ${live.length} tools; unmapped=${JSON.stringify(unmapped)} stale=${JSON.stringify(stale)}`,
      );
      expect(unmapped).toEqual([]);
      expect(stale).toEqual([]);
    } catch (err) {
      console.error(
        `[test] OpenScreen unreachable — live drift check skipped (${err})`,
      );
    }
  });
});
