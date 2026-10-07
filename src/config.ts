import * as v from "valibot";

/**
 * Where OpenScreen's own MCP server listens, unless the user changed the port
 * in AI settings → MCP server.
 */
export const DEFAULT_URL = "http://127.0.0.1:47821/mcp";

/** Default per-upstream-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface Config {
  /** Upstream MCP endpoint (Streamable HTTP, loopback only). */
  url: string;
  /** Full `Authorization` header value, `Bearer ` included. */
  authorization: string;
  /** Per-request upstream timeout. */
  timeoutMs: number;
  /** Verbose stderr logging (never stdout — stdio owns it). */
  debug: boolean;
}

/** Raised for anything the user must fix in their environment/config. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const EnvSchema = v.object({
  OPENSCREEN_MCP_URL: v.optional(v.string()),
  OPENSCREEN_MCP_AUTHORIZATION: v.optional(v.string()),
  OPENSCREEN_MCP_TOKEN: v.optional(v.string()),
  OPENSCREEN_TMCP_TIMEOUT_MS: v.optional(v.string()),
  OPENSCREEN_TMCP_DEBUG: v.optional(v.string()),
});

/**
 * Resolve the Authorization header from either env var.
 *
 * `OPENSCREEN_MCP_AUTHORIZATION` is used verbatim (that is the name the
 * Claude Code command from OpenScreen's UI uses, `Bearer ` included).
 * `OPENSCREEN_MCP_TOKEN` is the bare token OpenScreen's Codex instructions
 * tell users to export — `Bearer ` is added for them.
 *
 * `AUTHORIZATION` wins when both are set.
 */
function resolveAuthorization(
  authorization: string | undefined,
  token: string | undefined,
): string {
  const raw = authorization?.trim();
  if (raw) return raw;

  const bare = token?.trim();
  if (bare)
    return bare.toLowerCase().startsWith("bearer ") ? bare : `Bearer ${bare}`;

  throw new ConfigError(
    [
      "No OpenScreen MCP credential found.",
      "  Set one of:",
      '    OPENSCREEN_MCP_AUTHORIZATION  the full header value, "Bearer " included',
      "    OPENSCREEN_MCP_TOKEN          the bare token (the name OpenScreen's Codex setup uses)",
      "  Get it from the OpenScreen app: AI settings → MCP server → copy the shown command/token.",
    ].join("\n"),
  );
}

function parseTimeout(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `OPENSCREEN_TMCP_TIMEOUT_MS must be a positive integer (got "${raw}").`,
    );
  }
  return parsed;
}

/**
 * Validate the environment at startup. Throws {@link ConfigError} with a
 * message that tells the user exactly what to fix — the process must fail
 * fast and loudly *before* the transport starts, not mysteriously on the
 * first tool call.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const parsed = v.safeParse(EnvSchema, env);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid environment: ${parsed.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const e = parsed.output;
  return {
    url: e.OPENSCREEN_MCP_URL?.trim() || DEFAULT_URL,
    authorization: resolveAuthorization(
      e.OPENSCREEN_MCP_AUTHORIZATION,
      e.OPENSCREEN_MCP_TOKEN,
    ),
    timeoutMs: parseTimeout(e.OPENSCREEN_TMCP_TIMEOUT_MS),
    debug:
      e.OPENSCREEN_TMCP_DEBUG === "true" || e.OPENSCREEN_TMCP_DEBUG === "1",
  };
}
