#!/usr/bin/env bun
/**
 * openscreen-tmcp — a 6-tool MCP proxy in front of OpenScreen's 25-tool
 * video-editing server. Downstream: tmcp + Valibot over stdio. Upstream:
 * hand-rolled `fetch` + JSON-RPC over Streamable HTTP.
 *
 * Under stdio, **stdout is the JSON-RPC channel** — everything here logs to
 * stderr, never stdout. A single stray console.log corrupts the protocol.
 */
import { StdioTransport } from "@tmcp/transport-stdio";
import { ConfigError, loadConfig } from "./config";
import { createServer } from "./server";

let config;
try {
  config = loadConfig();
} catch (err) {
  // Fail fast and loudly *before* the transport starts: a missing token
  // must say where to get it, not surface as a mystery failure on the
  // first tool call.
  if (err instanceof ConfigError) {
    console.error(`[openscreen-tmcp] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const server = createServer(config);

if (config.debug) {
  console.error(
    `[openscreen-tmcp] starting; upstream ${config.url} (lazy connect)`,
  );
}

new StdioTransport(server).listen();
