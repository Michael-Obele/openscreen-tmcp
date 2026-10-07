import type { CallToolResult } from "tmcp";
import { tool } from "tmcp/utils";
import type { UpstreamClient } from "./client";
import { toToolError } from "./errors";

/**
 * The single action → upstream-tool mapping table (plan/tool-spec.md).
 *
 * Everything routes through here: dispatch, the `read action:"upstream"`
 * coverage report, and `test/coverage.test.ts` all read this one array, so
 * an upstream rename is a one-line change and drift turns into a red test
 * instead of a silent breakage.
 */

export type Dict = Record<string, unknown>;
export type DispatchTool = "read" | "trim" | "clip" | "effect" | "caption";

export interface DispatchRow {
  /** Wrapper tool this row serves. */
  tool: DispatchTool;
  /** The `action` value that selects this row (`''` when there is none). */
  action: string;
  /** `effect` discriminator; omitted on rows that ignore `kind`. */
  kind?: string;
  /** Every upstream tool this row can claim — the coverage test reads this. */
  upstream: string[];
  /** Fields this row requires *for the given input* (zoom add varies). */
  required: (input: Dict) => string[];
  /** Which upstream tool this input targets. */
  target: (input: Dict) => string;
  /** Upstream arguments; `lane` → upstream's `kind` happens here. */
  build: (input: Dict) => Dict;
}

/** Copy only the fields that were actually provided (never `undefined`). */
function pick(input: Dict, keys: string[]): Dict {
  const out: Dict = {};
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Static required-fields list. */
const need =
  (...keys: string[]) =>
  (): string[] =>
    keys;

/**
 * The 25 upstream tools OpenScreen 2.0.0 serves, exactly as enumerated live
 * (4 reads + 1 word write + 4 trims + 4 clip ops + 11 effect ops + 1 delete).
 * Serves as the offline baseline for the coverage report and tests.
 */
export const UPSTREAM_TOOL_NAMES: readonly string[] = [
  // reads
  "getCurrentDocument",
  "getCursorTrack",
  "getTranscript",
  "getTranscriptWords",
  // transcript write
  "setWordText",
  // trims
  "addTrim",
  "addTrims",
  "setTrim",
  "removeTrim",
  // clip ops
  "setClipRange",
  "moveClip",
  "removeClip",
  "replaceTimeline",
  // effect ops
  "addZoom",
  "addZooms",
  "setZoom",
  "addSpeed",
  "setSpeed",
  "addAnnotation",
  "setAnnotation",
  "addCameraFullscreen",
  "setCameraFullscreen",
  "addAudio",
  "setAudio",
  // generic modifier delete (all five effect `remove` kinds land here)
  "removeModifier",
];

export const DISPATCH: readonly DispatchRow[] = [
  // ── read ────────────────────────────────────────────────────────────────
  {
    tool: "read",
    action: "project",
    upstream: ["getCurrentDocument"],
    required: need(),
    target: () => "getCurrentDocument",
    build: () => ({}),
  },
  {
    tool: "read",
    action: "cursor",
    upstream: ["getCursorTrack"],
    required: need("assetId"),
    target: () => "getCursorTrack",
    build: (input) => pick(input, ["assetId"]),
  },
  {
    tool: "read",
    action: "transcript",
    upstream: ["getTranscript"],
    required: need("assetId"),
    target: () => "getTranscript",
    build: (input) => pick(input, ["assetId"]),
  },
  {
    tool: "read",
    action: "words",
    upstream: ["getTranscriptWords"],
    required: need("assetId"),
    target: () => "getTranscriptWords",
    build: (input) => pick(input, ["assetId"]),
  },
  {
    // Local diagnostic — claims no upstream tool.
    tool: "read",
    action: "upstream",
    upstream: [],
    required: need(),
    target: () => "",
    build: () => ({}),
  },

  // ── trim (SOURCE seconds) ───────────────────────────────────────────────
  {
    tool: "trim",
    action: "add",
    upstream: ["addTrim"],
    required: need("startSec", "endSec"),
    target: () => "addTrim",
    build: (input) => pick(input, ["startSec", "endSec"]),
  },
  {
    tool: "trim",
    action: "addMany",
    upstream: ["addTrims"],
    required: need("ranges"),
    target: () => "addTrims",
    build: (input) => ({ ranges: input.ranges }),
  },
  {
    tool: "trim",
    action: "set",
    upstream: ["setTrim"],
    required: need("trimRangeId", "startSec", "endSec"),
    target: () => "setTrim",
    build: (input) => pick(input, ["trimRangeId", "startSec", "endSec"]),
  },
  {
    tool: "trim",
    action: "remove",
    upstream: ["removeTrim"],
    required: need("trimRangeId"),
    target: () => "removeTrim",
    build: (input) => pick(input, ["trimRangeId"]),
  },

  // ── clip (SOURCE seconds) ───────────────────────────────────────────────
  {
    tool: "clip",
    action: "setRange",
    upstream: ["setClipRange"],
    required: need("clipId", "sourceStartSec", "sourceEndSec"),
    target: () => "setClipRange",
    build: (input) => pick(input, ["clipId", "sourceStartSec", "sourceEndSec"]),
  },
  {
    tool: "clip",
    action: "move",
    upstream: ["moveClip"],
    required: need("clipId", "beforeClipId"),
    target: () => "moveClip",
    build: (input) => pick(input, ["clipId", "beforeClipId"]),
  },
  {
    tool: "clip",
    action: "remove",
    upstream: ["removeClip"],
    required: need("clipId"),
    target: () => "removeClip",
    build: (input) => pick(input, ["clipId"]),
  },
  {
    tool: "clip",
    action: "replace",
    upstream: ["replaceTimeline"],
    required: need("intervals"),
    target: () => "replaceTimeline",
    build: (input) => ({ intervals: input.intervals }),
  },

  // ── effect (VIRTUAL seconds) ────────────────────────────────────────────
  {
    // Bulk shortcut: `regions` present → addZooms, else addZoom.
    tool: "effect",
    action: "add",
    kind: "zoom",
    upstream: ["addZoom", "addZooms"],
    required: (input) => (input.regions ? [] : ["startSec", "endSec"]),
    target: (input) => (input.regions ? "addZooms" : "addZoom"),
    build: (input) =>
      input.regions
        ? pick(input, ["regions", "depth", "focusX", "focusY"])
        : pick(input, ["startSec", "endSec", "depth", "focusX", "focusY"]),
  },
  {
    tool: "effect",
    action: "set",
    kind: "zoom",
    upstream: ["setZoom"],
    required: need("id"),
    target: () => "setZoom",
    build: (input) =>
      pick(input, ["id", "startSec", "endSec", "depth", "focusX", "focusY"]),
  },
  {
    tool: "effect",
    action: "add",
    kind: "speed",
    upstream: ["addSpeed"],
    required: need("startSec", "endSec", "speed"),
    target: () => "addSpeed",
    build: (input) => pick(input, ["startSec", "endSec", "speed"]),
  },
  {
    tool: "effect",
    action: "set",
    kind: "speed",
    upstream: ["setSpeed"],
    required: need("id"),
    target: () => "setSpeed",
    build: (input) => pick(input, ["id", "startSec", "endSec", "speed"]),
  },
  {
    tool: "effect",
    action: "add",
    kind: "annotation",
    upstream: ["addAnnotation"],
    required: need("startSec", "endSec", "text"),
    target: () => "addAnnotation",
    build: (input) => pick(input, ["startSec", "endSec", "text", "x", "y"]),
  },
  {
    tool: "effect",
    action: "set",
    kind: "annotation",
    upstream: ["setAnnotation"],
    required: need("id"),
    target: () => "setAnnotation",
    build: (input) =>
      pick(input, ["id", "startSec", "endSec", "text", "x", "y"]),
  },
  {
    tool: "effect",
    action: "add",
    kind: "camera",
    upstream: ["addCameraFullscreen"],
    required: need("startSec", "endSec"),
    target: () => "addCameraFullscreen",
    build: (input) => pick(input, ["startSec", "endSec"]),
  },
  {
    tool: "effect",
    action: "set",
    kind: "camera",
    upstream: ["setCameraFullscreen"],
    required: need("id"),
    target: () => "setCameraFullscreen",
    build: (input) => pick(input, ["id", "startSec", "endSec"]),
  },
  {
    tool: "effect",
    action: "add",
    kind: "audio",
    upstream: ["addAudio"],
    required: need("assetId", "startSec", "endSec"),
    target: () => "addAudio",
    build: (input) =>
      withLane(input, ["assetId", "startSec", "endSec", "offsetSec", "gainDb"]),
  },
  {
    tool: "effect",
    action: "set",
    kind: "audio",
    upstream: ["setAudio"],
    required: need("id"),
    target: () => "setAudio",
    build: (input) =>
      withLane(input, ["id", "startSec", "endSec", "offsetSec", "gainDb"]),
  },
  {
    // Generic delete: `kind` is accepted and ignored (removeModifier
    // deletes any modifier by id). Exactly one row claims removeModifier.
    tool: "effect",
    action: "remove",
    upstream: ["removeModifier"],
    required: need("id"),
    target: () => "removeModifier",
    build: (input) => pick(input, ["id"]),
  },

  // ── caption (the only transcript write) ─────────────────────────────────
  {
    tool: "caption",
    action: "",
    upstream: ["setWordText"],
    required: need("wordId", "text"),
    target: () => "setWordText",
    build: (input) => pick(input, ["wordId", "text"]),
  },
];

/**
 * The one field whose name deliberately differs between layers: our `lane`
 * becomes upstream's `kind` (upstream's `addAudio` already uses `kind` for
 * the lane, which would collide with our `effect` discriminator).
 */
function withLane(input: Dict, keys: string[]): Dict {
  const out = pick(input, keys);
  if (input.lane !== undefined && input.lane !== null) out.kind = input.lane;
  return out;
}

/** Find the row for `(tool, action, kind)`. `kind` is ignored on rows that don't use it. */
export function findRow(
  toolName: DispatchTool,
  action: string,
  kind?: string,
): DispatchRow | undefined {
  return DISPATCH.find(
    (row) =>
      row.tool === toolName &&
      row.action === action &&
      (row.kind === undefined || row.kind === kind),
  );
}

/** All actions a tool accepts (for the "Unknown action" error). */
export function actionsFor(toolName: DispatchTool): string[] {
  return [
    ...new Set(
      DISPATCH.filter((row) => row.tool === toolName).map((row) => row.action),
    ),
  ];
}

/**
 * Per-action requiredness — the flat-schema trade-off paid back with a
 * precise error naming the missing fields, the action, and (for effects)
 * the kind. Returns `null` when the input is dispatchable.
 */
export function dispatchProblem(
  toolName: DispatchTool,
  action: string,
  kind: string | undefined,
  input: Dict,
): string | null {
  if (toolName === "effect" && action !== "remove" && !kind) {
    return `effect action:"${action}" also needs kind (zoom | speed | annotation | camera | audio).`;
  }

  const row = findRow(toolName, action, kind);
  if (!row) {
    const valid =
      toolName === "effect"
        ? "add | set | remove (each with kind: zoom | speed | annotation | camera | audio)"
        : actionsFor(toolName).join(" | ");
    return `Unknown action "${action}" for ${toolName}. Valid: ${valid}.`;
  }

  const missing = row.required(input).filter((key) => input[key] === undefined);
  if (missing.length > 0) {
    const label =
      toolName === "effect" && row.kind
        ? `${toolName} action:"${action}" kind:"${kind}"`
        : `${toolName} action:"${action}"`;
    return `${label} also needs ${missing.join(", ")}.`;
  }
  return null;
}

/** Count how many rows claim each upstream tool (must be exactly 1 for all 25). */
export function claimCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of DISPATCH) {
    for (const name of row.upstream)
      counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** Offline coverage verdict — usable even when OpenScreen is closed. */
export function staticVerdict(): string {
  const claims = claimCounts();
  const unclaimed = UPSTREAM_TOOL_NAMES.filter((name) => !claims.has(name));
  return `Coverage (static): ${claims.size}/${UPSTREAM_TOOL_NAMES.length} upstream tools mapped${
    unclaimed.length > 0 ? `; UNMAPPED: ${unclaimed.join(", ")}` : ""
  }.`;
}

/**
 * Validate, dispatch, and return the upstream result.
 *
 * Successes pass through verbatim. Upstream `isError` results keep their
 * text untouched and gain one extra line of context (the plan's error model).
 * Anything thrown becomes a precise `tool.error(...)`.
 */
export async function dispatch(
  client: UpstreamClient,
  toolName: DispatchTool,
  action: string,
  kind: string | undefined,
  input: Dict,
): Promise<CallToolResult<undefined>> {
  const problem = dispatchProblem(toolName, action, kind, input);
  if (problem) return tool.error(problem);

  const row = findRow(toolName, action, kind);
  /* c8 ignore next */
  if (!row) return tool.error(`Unknown action "${action}" for ${toolName}.`);

  const name = row.target(input);
  const args = row.build(input);

  try {
    const result = await client.callTool(name, args);
    if (!result.isError) return result;
    return {
      ...result,
      content: [
        ...(result.content ?? []),
        {
          type: "text" as const,
          text: `(OpenScreen tool ${name} refused — pass its wording to the user verbatim.)`,
        },
      ],
    };
  } catch (err) {
    return toToolError(err, client.url);
  }
}
