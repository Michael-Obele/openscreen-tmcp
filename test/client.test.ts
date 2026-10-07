import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { UpstreamClient, unwrap } from "../src/upstream/client";
import {
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamRpcError,
  UpstreamUnreachableError,
  describeError,
} from "../src/upstream/errors";

const CONFIG: Config = {
  url: "http://127.0.0.1:47821/mcp",
  authorization: "Bearer test-token",
  timeoutMs: 500,
  debug: false,
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const INIT_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "openscreen", version: "2.0.0" },
  instructions: "upstream instructions we must not forward",
};

describe("unwrap — both framings", () => {
  test("plain JSON (the observed path)", () => {
    expect(
      unwrap<{ ok: boolean }>(
        '{"result":{"ok":true},"jsonrpc":"2.0","id":1}',
        1,
      ),
    ).toEqual({
      ok: true,
    });
  });

  test("plain JSON error → UpstreamRpcError", () => {
    expect(() =>
      unwrap(
        '{"error":{"code":-32601,"message":"nope"},"jsonrpc":"2.0","id":1}',
        1,
      ),
    ).toThrow(UpstreamRpcError);
    expect(() =>
      unwrap(
        '{"error":{"code":-32601,"message":"nope"},"jsonrpc":"2.0","id":1}',
        1,
      ),
    ).toThrow("nope");
  });

  test("SSE framing — picks the message whose id matches", () => {
    const body = [
      "event: message",
      'data: {"result":{"n":2},"jsonrpc":"2.0","id":2}',
      "",
      'data: {"result":{"n":1},"jsonrpc":"2.0","id":1}',
      "",
    ].join("\n");
    expect(unwrap<{ n: number }>(body, 1)).toEqual({ n: 1 });
    expect(unwrap<{ n: number }>(body, 2)).toEqual({ n: 2 });
  });

  test("SSE framing — falls back to the last message when no id matches", () => {
    const body = 'data: {"result":{"n":9},"jsonrpc":"2.0","id":99}\n\n';
    expect(unwrap<{ n: number }>(body, 1)).toEqual({ n: 9 });
  });

  test("SSE framing — error surfaces verbatim", () => {
    const body =
      'data: {"error":{"code":-1,"message":"boom"},"jsonrpc":"2.0","id":1}\n';
    expect(() => unwrap(body, 1)).toThrow("boom");
  });
});

describe("error taxonomy", () => {
  test("fetch rejection → unreachable, with recovery guidance", async () => {
    const client = new UpstreamClient(CONFIG, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(
      client.callTool("getCurrentDocument", {}),
    ).rejects.toBeInstanceOf(UpstreamUnreachableError);

    try {
      await client.callTool("getCurrentDocument", {});
      expect.unreachable();
    } catch (err) {
      const message = describeError(err, CONFIG.url);
      expect(message).toContain("not reachable at http://127.0.0.1:47821/mcp");
      expect(message).toContain("AI settings → MCP server");
    }
  });

  test("timeout → unreachable, naming the timeout", async () => {
    const client = new UpstreamClient(CONFIG, {
      fetch: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    try {
      await client.callTool("getCurrentDocument", {});
      expect.unreachable();
    } catch (err) {
      const message = describeError(err, CONFIG.url);
      expect(message).toContain("no response within 500ms");
    }
  });

  test("401 → auth error pointing at the env var to update", async () => {
    const client = new UpstreamClient(CONFIG, {
      fetch: (async () =>
        new Response("unauthorized", {
          status: 401,
        })) as unknown as typeof fetch,
    });
    await expect(
      client.callTool("getCurrentDocument", {}),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
    try {
      await client.callTool("getCurrentDocument", {});
      expect.unreachable();
    } catch (err) {
      const message = describeError(err, CONFIG.url);
      expect(message).toContain("rejected the token");
      expect(message).toContain("OPENSCREEN_MCP_AUTHORIZATION");
    }
  });

  test("other non-2xx → status and body verbatim", async () => {
    const client = new UpstreamClient(CONFIG, {
      fetch: (async () =>
        new Response("upstream exploded", {
          status: 500,
        })) as unknown as typeof fetch,
    });
    try {
      await client.callTool("getCurrentDocument", {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamHttpError);
      expect(describeError(err, CONFIG.url)).toBe(
        "OpenScreen's MCP server returned HTTP 500: upstream exploded",
      );
    }
  });
});

describe("client behaviour", () => {
  function scriptedFetch(options?: {
    onCall?: (name: string, args: Record<string, unknown>) => unknown;
    onToolsCall?: (active: {
      count: number;
      max: number;
    }) => Promise<void> | void;
    returnSse?: boolean;
  }) {
    let initializeCount = 0;
    let active = 0;
    let max = 0;
    const calls: string[] = [];

    const fetchImpl = async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));

      if (body.method === "initialize") {
        initializeCount++;
        if (options?.returnSse) {
          return new Response(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: INIT_RESULT,
            })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return json({ jsonrpc: "2.0", id: body.id, result: INIT_RESULT });
      }

      // notifications carry no id
      if (body.id === undefined) return new Response(null, { status: 202 });

      if (body.method === "tools/call") {
        calls.push(body.params.name);
        active++;
        max = Math.max(max, active);
        try {
          await options?.onToolsCall?.({ count: active, max });
        } finally {
          active--;
        }
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: options?.onCall
            ? options.onCall(body.params.name, body.params.arguments)
            : { content: [{ type: "text", text: "ok" }] },
        });
      }

      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    };

    return {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stats: () => ({ initializeCount, max, calls }),
    };
  }

  test("handshakes once, lazily, even across concurrent calls", async () => {
    const { fetchImpl, stats } = scriptedFetch({
      onToolsCall: async () => new Promise((r) => setTimeout(r, 20)),
    });
    const client = new UpstreamClient(CONFIG, { fetch: fetchImpl });

    // No dial at construction — the server must start with OpenScreen closed.
    expect(stats().initializeCount).toBe(0);

    const [a, b] = await Promise.all([
      client.callTool("getCurrentDocument", {}),
      client.callTool("getTranscript", { assetId: "a" }),
    ]);

    expect(stats().initializeCount).toBe(1);
    expect(stats().max).toBe(1); // serialised: never two in flight
    expect(stats().calls).toEqual(["getCurrentDocument", "getTranscript"]);
    expect(a).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(b).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(client.info.serverInfo).toEqual({
      name: "openscreen",
      version: "2.0.0",
    });
    expect(client.info.listChanged).toBe(true);
    // Upstream's instructions are recorded, never forwarded downstream.
    expect(client.info.instructions).toBe(
      "upstream instructions we must not forward",
    );
  });

  test("handles an SSE-framed initialize response", async () => {
    const { fetchImpl } = scriptedFetch({ returnSse: true });
    const client = new UpstreamClient(CONFIG, { fetch: fetchImpl });
    await client.callTool("getCurrentDocument", {});
    expect(client.info.serverInfo?.name).toBe("openscreen");
  });

  test("upstream isError results pass through verbatim", async () => {
    const refusal =
      "Project edits are off — turn on the switch in the MCP server section.";
    const { fetchImpl } = scriptedFetch({
      onCall: () => ({
        content: [{ type: "text", text: refusal }],
        isError: true,
      }),
    });
    const client = new UpstreamClient(CONFIG, { fetch: fetchImpl });

    const result = await client.callTool("addTrim", { startSec: 1, endSec: 2 });
    expect(result.isError).toBe(true);
    expect(result.content ?? []).toHaveLength(1); // untouched at the client layer
    expect(result.content?.[0]).toEqual({ type: "text", text: refusal });
  });

  test("captures Mcp-Session-Id when offered, never sends one when absent", async () => {
    let sawSessionHeader = false;
    const { fetchImpl } = scriptedFetch({});
    const base = fetchImpl;
    const capturing = (async (
      input: string | Request | URL,
      init: RequestInit,
    ) => {
      const headers = init.headers as Record<string, string>;
      if (headers["Mcp-Session-Id"]) sawSessionHeader = true;
      return base(input, init);
    }) as unknown as typeof fetch;

    const client = new UpstreamClient(CONFIG, { fetch: capturing });
    await client.callTool("getCurrentDocument", {});
    expect(sawSessionHeader).toBe(false);

    // Now an upstream that *does* issue one: second call must echo it.
    let first = true;
    const withSession = (async (
      input: string | Request | URL,
      init: RequestInit,
    ) => {
      const headers = init.headers as Record<string, string>;
      if (first) {
        first = false;
        const res = await base(input, init);
        return new Response(res.body, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "sess-1",
          },
        });
      }
      if (headers["Mcp-Session-Id"] === "sess-1") sawSessionHeader = true;
      return base(input, init);
    }) as unknown as typeof fetch;

    const client2 = new UpstreamClient(CONFIG, { fetch: withSession });
    await client2.callTool("getCurrentDocument", {});
    await client2.callTool("getTranscript", {});
    expect(sawSessionHeader).toBe(true);
  });

  test("a failed handshake does not poison the next attempt", async () => {
    let attempts = 0;
    const flaky = (async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") {
        attempts++;
        if (attempts === 1) throw new TypeError("fetch failed");
        return json({ jsonrpc: "2.0", id: body.id, result: INIT_RESULT });
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }) as unknown as typeof fetch;

    const client = new UpstreamClient(CONFIG, { fetch: flaky });
    await expect(
      client.callTool("getCurrentDocument", {}),
    ).rejects.toBeInstanceOf(UpstreamUnreachableError);
    const result = await client.callTool("getCurrentDocument", {});
    expect(result.content?.[0]).toEqual({ type: "text", text: "ok" });
    expect(attempts).toBe(2);
  });
});
