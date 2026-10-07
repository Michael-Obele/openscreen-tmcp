import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpstreamClient } from "../upstream/client";
import { FramesError } from "./errors";
import { probe } from "./ffmpeg";

export { FramesError };

interface DocAsset {
  id: string;
  label?: string;
  durationSec?: number;
  originalPath?: string;
}
interface Doc {
  project?: { id?: string };
  primaryAssetId?: string;
  assets?: DocAsset[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function readDocument(client: UpstreamClient): Promise<Doc> {
  const result = await client.callTool("getCurrentDocument", {});
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError)
    throw new FramesError(
      text || "getCurrentDocument failed. Open the project in OpenScreen first.",
    );
  try {
    return JSON.parse(text) as Doc;
  } catch {
    throw new FramesError(
      'getCurrentDocument did not return JSON. Call `read action:"project"` first and check the app is responsive.',
    );
  }
}

/**
 * `lastKnownPath`s from the relink registry. `null` means the registry itself
 * could not be read (missing or malformed), which the caller must report — a
 * swallowed miss would leave the registry out of the `Tried:` list even though
 * it is one of the places we looked.
 */
async function registryPaths(path: string): Promise<string[] | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      entries?: Array<{ lastKnownPath?: string }>;
    };
    return (raw.entries ?? [])
      .map((e) => e.lastKnownPath)
      .filter((p): p is string => typeof p === "string");
  } catch {
    return null;
  }
}

export interface ResolvedAsset {
  path: string;
  assetId: string;
  label: string;
  durationSec: number;
  via: "override" | "project" | "recordings" | "registry" | "sibling";
}

export interface ResolveInput {
  dataDir: string;
  client: UpstreamClient;
  assetId?: string;
  path?: string;
}

/**
 * Turn an `assetId` (or an explicit `path`) into a file ffmpeg can read.
 *
 * Order: explicit path → the project file OpenScreen writes to disk →
 * `recordings/<label>` → the relink registry → the project file's own folder.
 * Every miss is remembered so the failure can name what was tried.
 */
export async function resolveAsset(input: ResolveInput): Promise<ResolvedAsset> {
  if (input.path) {
    const path = input.path;
    if (!(await isFile(path)))
      throw new FramesError(
        `No video at \`${path}\`. Pass an absolute path to an existing file.`,
      );
    const { durationSec } = await probe(path);
    return {
      path,
      assetId: input.assetId ?? "",
      label: basename(path),
      durationSec,
      via: "override",
    };
  }

  const doc = await readDocument(input.client);
  const assets = doc.assets ?? [];
  if (assets.length === 0)
    throw new FramesError(
      "The open project has no assets. Record or import something first.",
    );

  const assetId = input.assetId ?? doc.primaryAssetId ?? assets[0]!.id;
  const asset = assets.find((a) => a.id === assetId);
  if (!asset)
    throw new FramesError(
      `Unknown assetId "${assetId}". Available: ${assets
        .map((a) => a.id)
        .join(", ")}.`,
    );

  const label = asset.label ?? "";
  const projectPath = join(
    input.dataDir,
    "projects",
    `${doc.project?.id ?? ""}.openscreen`,
  );

  const candidates: Array<[string, ResolvedAsset["via"]]> = [];
  const tried: string[] = [];
  let projectDir = "";

  if (await isFile(projectPath)) {
    projectDir = dirname(projectPath);
    try {
      const project = JSON.parse(await readFile(projectPath, "utf8")) as {
        assets?: DocAsset[];
      };
      const match = project.assets?.find((a) => a.id === asset.id);
      if (match?.originalPath) candidates.push([match.originalPath, "project"]);
      else tried.push(`${projectPath} (no originalPath for ${asset.id})`);
    } catch (err) {
      tried.push(`${projectPath} (unreadable: ${(err as Error).message})`);
    }
  } else {
    tried.push(projectPath);
  }

  if (label) {
    candidates.push([join(input.dataDir, "recordings", label), "recordings"]);
    const registry = join(
      input.dataDir,
      "recordings",
      "media-links.registry.json",
    );
    const linked = await registryPaths(registry);
    if (linked === null) tried.push(registry);
    else
      for (const path of linked) {
        if (basename(path) === label) candidates.push([path, "registry"]);
      }
    if (projectDir) candidates.push([join(projectDir, label), "sibling"]);
  }

  for (const [path, via] of candidates) {
    if (await isFile(path)) {
      const { durationSec } = await probe(path);
      return { path, assetId: asset.id, label, durationSec, via };
    }
    tried.push(path);
  }

  throw new FramesError(
    [
      `Could not find the file for asset ${asset.id} (\`${label}\`). Tried:`,
      ...tried.map((p) => `  - ${p}`),
      "Pass `path` to point at the video directly, or reopen the project in OpenScreen so it relinks.",
    ].join("\n"),
  );
}
