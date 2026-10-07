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

/**
 * A miniature OpenScreen data dir: one project file, one recording, and the
 * `getCurrentDocument` payload that points at it. Needs ffmpeg (the clip is
 * synthetic), so callers gate with `describe.skipIf`.
 */
export interface FramesFixture {
  dataDir: string;
  doc: Record<string, unknown>;
  clipPath: string;
}

export async function framesFixture(): Promise<FramesFixture> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dataDir = await mkdtemp(join(tmpdir(), "openscreen-data-"));
  await mkdir(join(dataDir, "projects"), { recursive: true });
  await mkdir(join(dataDir, "recordings"), { recursive: true });

  const clipPath = join(dataDir, "recordings", "rec.mp4");
  const proc = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30:duration=6",
    "-pix_fmt",
    "yuv420p",
    clipPath,
  ]);
  if (proc.exitCode !== 0) throw new Error(String(proc.stderr));

  const assetId = "asset_1";
  const projectId = "proj_1";
  const projectPath = join(dataDir, "projects", `${projectId}.openscreen`);
  await writeFile(
    projectPath,
    JSON.stringify({
      schemaVersion: 8,
      project: { id: projectId, title: "Fixture" },
      assets: [
        {
          id: assetId,
          kind: "video",
          label: "rec.mp4",
          originalPath: clipPath,
          durationSec: 6,
        },
      ],
    }),
  );

  const doc = {
    project: { id: projectId, title: "Fixture" },
    primaryAssetId: assetId,
    assets: [{ id: assetId, label: "rec.mp4", durationSec: 6 }],
  };
  return { dataDir, doc, clipPath };
}
