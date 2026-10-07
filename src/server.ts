import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { McpServer } from "tmcp";
import type { Config } from "./config";
import { INSTRUCTIONS } from "./instructions";
import { UpstreamClient } from "./upstream/client";
import { createTools } from "./tools";
import { VERSION } from "./version";

/**
 * Build the downstream server (tools + instructions + adapter) without
 * starting a transport — so tests can drive it through `server.receive(...)`
 * and assert the real `initialize` / `tools/list` surface.
 *
 * The upstream connection is *lazy*: nothing here dials OpenScreen, so the
 * server starts (and answers `tools/list`) even when the app is closed; the
 * first tool call performs the handshake.
 */
export function createServer(
  config: Config,
  client?: UpstreamClient,
): McpServer {
  const upstream = client ?? new UpstreamClient(config);

  const server = new McpServer(
    {
      name: "openscreen-tmcp",
      version: VERSION,
    },
    {
      adapter: new ValibotJsonSchemaAdapter(),
      capabilities: {
        // Required: without the capability declared, tmcp will not
        // answer tools/list at all (its own docs warn about this).
        tools: {},
      },
      // Condensed guardrails, ~1 KB — upstream's ~4 KB block is never
      // forwarded; shrinking context spend is half the point.
      instructions: INSTRUCTIONS,
    },
  );

  server.tools(createTools(upstream));
  return server;
}
