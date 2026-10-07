import type { Config } from "../src/config";
import { DEFAULT_URL } from "../src/config";
import { UpstreamClient } from "../src/upstream/client";

export const TEST_CONFIG: Config = {
  url: DEFAULT_URL,
  authorization: "Bearer test-token",
  timeoutMs: 500,
  debug: false,
};

export function json(
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
};

export interface CallRecord {
  name: string;
  args: Record<string, unknown>;
}

/**
 * An UpstreamClient wired to a scripted fetch: the handshake always
 * succeeds, and every `tools/call` is recorded in order with its result
 * produced by `handler`. Lets tests assert *what* would hit OpenScreen and
 * *in which order* without the app running.
 */
export function scriptedClient(
  handler?: (
    name: string,
    args: Record<string, unknown>,
    index: number,
  ) => Record<string, unknown>,
): { client: UpstreamClient; calls: CallRecord[] } {
  const calls: CallRecord[] = [];

  const fetchImpl = (async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));

    if (body.method === "initialize") {
      return json({ jsonrpc: "2.0", id: body.id, result: INIT_RESULT });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });

    if (body.method === "tools/call") {
      const index = calls.length;
      calls.push({ name: body.params.name, args: body.params.arguments });
      const result = handler
        ? handler(body.params.name, body.params.arguments, index)
        : { content: [{ type: "text", text: `ok:${body.params.name}` }] };
      return json({ jsonrpc: "2.0", id: body.id, result });
    }

    return json({ jsonrpc: "2.0", id: body.id, result: {} });
  }) as unknown as typeof fetch;

  return {
    client: new UpstreamClient(TEST_CONFIG, { fetch: fetchImpl }),
    calls,
  };
}
