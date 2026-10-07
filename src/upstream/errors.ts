import type { CallToolResult } from "tmcp";
import { tool } from "tmcp/utils";

/**
 * The five upstream failure classes (see plan/client-leg.md).
 *
 * Handlers never throw — every one of these is rendered by
 * {@link describeError} and returned via `tool.error(...)`, so the model
 * sees what went wrong and can recover.
 */

/** Fetch rejected: app closed, MCP server switched off, or a hung request. */
export class UpstreamUnreachableError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason?: string,
  ) {
    super(
      `OpenScreen's MCP server is unreachable${reason ? `: ${reason}` : ""}`,
    );
    this.name = "UpstreamUnreachableError";
  }
}

/** HTTP 401 — token regenerated since the client was configured. */
export class UpstreamAuthError extends Error {
  constructor() {
    super("OpenScreen rejected the token");
    this.name = "UpstreamAuthError";
  }
}

/** Any other non-2xx from the upstream endpoint; body kept verbatim. */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = "UpstreamHttpError";
  }
}

/** JSON-RPC `error` object; message kept verbatim. */
export class UpstreamRpcError extends Error {
  constructor(
    public readonly rpc: { code: number; message: string; data?: unknown },
  ) {
    super(rpc.message);
    this.name = "UpstreamRpcError";
  }
}

/**
 * Upstream returned a result with `isError: true`. The text is OpenScreen's
 * own — most often the `Project edits` switch being off — so it is passed
 * through unchanged rather than paraphrased.
 */
export class UpstreamToolError extends Error {
  constructor(public readonly text: string) {
    super(text);
    this.name = "UpstreamToolError";
  }
}

/**
 * Render any upstream failure as one human-readable message. The wording for
 * unreachable/auth/tool-refusal is fixed so agents can pattern-match it (and
 * so the skill's "When something fails" section stays accurate).
 */
export function describeError(err: unknown, url: string): string {
  if (err instanceof UpstreamUnreachableError) {
    return (
      `OpenScreen's MCP server is not reachable at ${url}` +
      `${err.reason ? ` (${err.reason})` : ""}. ` +
      "Open the OpenScreen app and enable AI settings → MCP server."
    );
  }
  if (err instanceof UpstreamAuthError) {
    return (
      "OpenScreen rejected the token. It may have been regenerated — " +
      "regenerate it and update OPENSCREEN_MCP_AUTHORIZATION."
    );
  }
  if (err instanceof UpstreamHttpError) {
    return `OpenScreen's MCP server returned HTTP ${err.status}: ${err.body}`;
  }
  if (err instanceof UpstreamRpcError) {
    return `OpenScreen's MCP server returned a JSON-RPC error: ${err.rpc.message}`;
  }
  if (err instanceof UpstreamToolError) {
    return err.text;
  }
  return `Unexpected error talking to OpenScreen: ${
    err instanceof Error ? err.message : String(err)
  }`;
}

/**
 * Log to stderr (always safe under stdio) and convert to an `isError` tool
 * result. This is the single funnel every handler returns through when
 * something upstream broke.
 */
export function toToolError(
  err: unknown,
  url: string,
): CallToolResult<undefined> {
  console.error(
    "[openscreen-tmcp]",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  return tool.error(describeError(err, url));
}
