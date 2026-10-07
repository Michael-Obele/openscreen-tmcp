import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAsset } from "../src/frames/resolve";
import { FramesError } from "../src/frames/errors";
import { framesFixture, scriptedClient } from "./helpers";

const haveFfmpeg = existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe");
// `describe.skipIf` is typed boolean-only, so the skip reason lives here as a comment.
const gate = !haveFfmpeg; // "ffmpeg/ffprobe not installed"

describe.skipIf(gate)("resolveAsset", () => {
  test("reads originalPath out of the project file", async () => {
    const fx = await framesFixture();
    const { client, calls } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const got = await resolveAsset({ dataDir: fx.dataDir, client });
    expect(got.path).toBe(fx.clipPath);
    expect(got.via).toBe("project");
    expect(got.assetId).toBe("asset_1");
    expect(got.durationSec).toBeCloseTo(6, 1);
    expect(calls.map((c) => c.name)).toEqual(["getCurrentDocument"]);

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test("`path` skips the app entirely", async () => {
    const fx = await framesFixture();
    const { client, calls } = scriptedClient();

    const got = await resolveAsset({
      dataDir: "/tmp/unused",
      client,
      path: fx.clipPath,
    });
    expect(got.via).toBe("override");
    expect(calls).toHaveLength(0);

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test("falls back to recordings/<label> when the project file is gone", async () => {
    const fx = await framesFixture();
    await rm(join(fx.dataDir, "projects", "proj_1.openscreen"));
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const got = await resolveAsset({ dataDir: fx.dataDir, client });
    expect(got.via).toBe("recordings");
    expect(got.path).toBe(fx.clipPath);

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test("reads the relink registry when the file moved", async () => {
    const fx = await framesFixture();
    const moved = fx.clipPath.replace("/recordings/", "/moved/");
    await mkdir(join(fx.dataDir, "moved"), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(fx.clipPath, moved);
    await rm(join(fx.dataDir, "projects", "proj_1.openscreen"));
    await writeFile(
      join(fx.dataDir, "recordings", "media-links.registry.json"),
      JSON.stringify({
        version: 1,
        entries: [{ lastKnownPath: moved, fingerprint: { sizeBytes: 1 } }],
      }),
    );
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const got = await resolveAsset({ dataDir: fx.dataDir, client });
    expect(got.via).toBe("registry");
    expect(got.path).toBe(moved);

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test("unknown assetId lists what is available", async () => {
    const fx = await framesFixture();
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    await expect(
      resolveAsset({ dataDir: fx.dataDir, client, assetId: "asset_9" }),
    ).rejects.toThrow(/asset_1/);

    await rm(fx.dataDir, { recursive: true, force: true });
  });

  test("nothing found: names every location and offers `path`", async () => {
    const fx = await framesFixture();
    await rm(fx.clipPath);
    await rm(join(fx.dataDir, "projects", "proj_1.openscreen"));
    const { client } = scriptedClient(() => ({
      content: [{ type: "text", text: JSON.stringify(fx.doc) }],
    }));

    const err = await resolveAsset({ dataDir: fx.dataDir, client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FramesError);
    expect((err as Error).message).toContain("Tried:");
    expect((err as Error).message).toContain("Pass `path`");

    await rm(fx.dataDir, { recursive: true, force: true });
  });
});

describe("FramesError shape", () => {
  test("is a plain Error with name FramesError", () => {
    const e = new FramesError("boom");
    expect(e.name).toBe("FramesError");
    expect(e.message).toBe("boom");
  });
});
