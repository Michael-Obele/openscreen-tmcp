import type { CallToolResult } from "tmcp";
import type { Config } from "../config";
import { VERSION } from "../version";
import {
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamRpcError,
  UpstreamUnreachableError,
} from "./errors";

export interface ToolInfo {
  name: string;
  description?: string;
}

/** What the upstream `initialize` told us about OpenScreen's server. */
export interface UpstreamInfo {
  serverInfo?: { name?: string; title?: string; version?: string };
  protocolVersion?: string;
  /** Upstream's own ~4 KB instructions block — recorded, never forwarded. */
  instructions?: string;
  /** Whether upstream may change its tool list at runtime. */
  listChanged?: boolean;
}

type RpcEnvelope<T> = {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Unwrap a single JSON-RPC response from either framing:
 *
 * - plain JSON — the framing OpenScreen's endpoint observedly uses, and
 * - SSE `data: {…}` lines — what the Streamable HTTP transport *may* switch
 *   to, handled now so a server change does not break us later.
 *
 * No SSE state machine: every request here is a single round trip with no
 * subscription, so we just pick the message whose id matches.
 *
 * Exported for unit tests (see test/client.test.ts).
 */
export function unwrap<T>(raw: string, id: unknown): T {
  const text = raw.trim();

  if (text.startsWith("{")) {
    const msg = JSON.parse(text) as RpcEnvelope<T>;
    if (msg.error) throw new UpstreamRpcError(msg.error);
    return msg.result as T;
  }

  const messages = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map(
      (line) =>
        JSON.parse(line.slice(5).trim()) as RpcEnvelope<T> & { id?: unknown },
    );

  const match =
    messages.find((message) => message.id === id) ?? messages.at(-1);
  if (!match)
    throw new UpstreamRpcError({ code: -1, message: "empty response" });
  if (match.error) throw new UpstreamRpcError(match.error);
  return match.result as T;
}

/**
 * Hand-rolled MCP client for OpenScreen's Streamable HTTP endpoint.
 *
 * tmcp ships no client package (verified: 17 packages, none a client) and the
 * house rule rules out `@modelcontextprotocol/sdk`, so this is `fetch` +
 * JSON-RPC — small because the endpoint is simple (plain JSON, session id
 * optional, three methods total).
 *
 * Lifecycle: one instance per process, lazily connected on the first tool
 * call (so the server starts even with OpenScreen closed), with every call
 * serialised through a single promise chain — OpenScreen edits one document,
 * and concurrent mutations would race for no benefit.
 */
export class UpstreamClient {
  #url: string;
  #authorization: string;
  #timeoutMs: number;
  #debug: boolean;
  #fetch: typeof fetch;

  #sessionId: string | null = null;
  #ready = false;
  #nextId = 1;
  #chain: Promise<unknown> = Promise.resolve();

  #info: UpstreamInfo = {};
  #tools: ToolInfo[] | null = null;

  constructor(config: Config, options?: { fetch?: typeof fetch }) {
    this.#url = config.url;
    this.#authorization = config.authorization;
    this.#timeoutMs = config.timeoutMs;
    this.#debug = config.debug;
    this.#fetch = options?.fetch ?? fetch;
  }

  /** The upstream endpoint — used in error messages. */
  get url(): string {
    return this.#url;
  }

  /** Server info captured during `initialize` (empty until first call). */
  get info(): UpstreamInfo {
    return { ...this.#info };
  }

  #log(...args: unknown[]): void {
    if (this.#debug) console.error("[openscreen-tmcp]", ...args);
  }

  async #rpc<T>(
    method: string,
    params?: unknown,
    notification = false,
  ): Promise<T | undefined> {
    const id = notification ? undefined : this.#nextId++;
    const body = {
      jsonrpc: "2.0" as const,
      ...(id !== undefined && { id }),
      method,
      ...(params !== undefined && { params }),
    };

    this.#log(`→ ${method}${id !== undefined ? ` #${id}` : " (notification)"}`);

    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: this.#authorization,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout → DOMException named TimeoutError.
      const reason =
        err instanceof Error && err.name === "TimeoutError"
          ? `no response within ${this.#timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new UpstreamUnreachableError(this.#url, reason);
    }

    // Capture a session id if offered; never send one when absent.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.#sessionId = sid;

    if (res.status === 401) throw new UpstreamAuthError();
    if (!res.ok) throw new UpstreamHttpError(res.status, await res.text());
    if (notification) return undefined;

    return unwrap<T>(await res.text(), id);
  }

  /**
   * Lazy handshake: `initialize` + `notifications/initialized`, cached.
   * On failure `#ready` stays false, so the *next* call retries — but a
   * mutation itself is never retried (a retried `addZoom` adds two zooms).
   */
  async #ensureReady(): Promise<void> {
    if (this.#ready) return;

    type InitResult = {
      protocolVersion?: string;
      serverInfo?: UpstreamInfo["serverInfo"];
      instructions?: string;
      capabilities?: { tools?: { listChanged?: boolean } };
    };

    const init = await this.#rpc<InitResult>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "openscreen-tmcp", version: VERSION },
    });

    this.#info = {
      serverInfo: init?.serverInfo,
      protocolVersion: init?.protocolVersion ?? "2025-06-18",
      instructions: init?.instructions,
      listChanged: init?.capabilities?.tools?.listChanged ?? false,
    };

    await this.#rpc("notifications/initialized", undefined, true);
    this.#ready = true;
    this.#log(
      `connected to ${this.#info.serverInfo?.name ?? "upstream"} ${this.#info.serverInfo?.version ?? ""}`.trim(),
    );
  }

  /** Run `fn` with exclusive access to the upstream connection. */
  #serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    // Keep the chain usable after a failure: swallow for the *chain*,
    // the caller still receives the rejection.
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Call one upstream tool and return its result **verbatim** —
   * `content`, `structuredContent` and `isError` intact. The wrapper adds
   * selection, not interpretation.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult<undefined>> {
    return this.#serialise(async () => {
      await this.#ensureReady();
      this.#log(`tools/call ${name}`, args);
      const result = await this.#rpc<CallToolResult<undefined>>("tools/call", {
        name,
        arguments: args,
      });
      if (!result) {
        throw new UpstreamRpcError({
          code: -1,
          message: `empty response to tools/call ${name}`,
        });
      }
      return result;
    });
  }

  /**
   * Upstream's live tool inventory, used by `read action:"upstream"` and the
   * coverage test. Cached per process unless `refresh` — the diagnostic
   * wants the *live* list so drift is visible from inside a chat.
   */
  listTools(refresh = false): Promise<ToolInfo[]> {
    return this.#serialise(async () => {
      await this.#ensureReady();
      if (this.#tools && !refresh) return this.#tools;
      this.#log("tools/list");
      const result = await this.#rpc<{ tools?: ToolInfo[] }>("tools/list");
      this.#tools = result?.tools ?? [];
      return this.#tools;
    });
  }
}
