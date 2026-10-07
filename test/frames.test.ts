import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  frameTimes,
  hhmmss,
  probe,
  renderFrames,
} from "../src/frames/ffmpeg";
import { FramesError } from "../src/frames/errors";

const DIR = "/tmp/openscreen-frames-test";
const CLIP = join(DIR, "clip.mp4");

/** Debian's DejaVu path; the burn-in tests are gated on it being installed. */
const DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const haveFfmpeg = existsSync("/usr/bin/ffmpeg") && existsSync("/usr/bin/ffprobe");
// `describe.skipIf` is typed boolean-only, so the skip reason lives here as a comment.
const gate = !haveFfmpeg; // "ffmpeg/ffprobe not installed"

async function makeClip(): Promise<void> {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const proc = Bun.spawnSync([
    "ffmpeg", "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6",
    "-pix_fmt", "yuv420p", CLIP,
  ]);
  if (proc.exitCode !== 0) throw new Error(String(proc.stderr));
}

describe("hhmmss", () => {
  test("formats source seconds as HH:MM:SS.mmm", () => {
    expect(hhmmss(15.5)).toBe("00:00:15.500");
    expect(hhmmss(0)).toBe("00:00:00.000");
    expect(hhmmss(3661.25)).toBe("01:01:01.250");
  });
});

describe("frameTimes", () => {
  test("even spacing includes both ends", () => {
    expect(frameTimes({ count: 3, startSec: 0, endSec: 6 })).toEqual([0, 3, 6]);
    expect(frameTimes({ count: 6, startSec: 0, endSec: 6 })).toEqual([
      0, 1.2, 2.4, 3.6, 4.8, 6,
    ]);
  });

  test("count 1 lands in the middle", () => {
    expect(frameTimes({ count: 1, startSec: 10, endSec: 20 })).toEqual([15]);
  });

  test("`at` wins, sorted and de-duplicated", () => {
    expect(frameTimes({ startSec: 0, endSec: 6, at: [5, 1, 1, 3] })).toEqual([
      1, 3, 5,
    ]);
  });

  test("`at` outside the window is an error, not a silent drop", () => {
    expect(() => frameTimes({ startSec: 0, endSec: 6, at: [7] })).toThrow(
      FramesError,
    );
    expect(() => frameTimes({ startSec: 0, endSec: 6, at: [7] })).toThrow(
      /outside/,
    );
  });

  test("count must be 1..16", () => {
    expect(() => frameTimes({ count: 0, startSec: 0, endSec: 6 })).toThrow(
      /1\.\.16/,
    );
    expect(() => frameTimes({ count: 17, startSec: 0, endSec: 6 })).toThrow(
      /1\.\.16/,
    );
  });

  test("window must have width", () => {
    expect(() => frameTimes({ count: 2, startSec: 5, endSec: 5 })).toThrow(
      /endSec/,
    );
  });
});

describe.skipIf(gate)("probe", () => {
  beforeAll(async () => {
    await makeClip();
  });

  test("reads duration and frame size", async () => {
    const info = await probe(CLIP);
    expect(info.width).toBe(640);
    expect(info.height).toBe(360);
    expect(info.durationSec).toBeCloseTo(6, 1);
  });

  test("a missing file is a FramesError naming the path", async () => {
    await expect(probe("/tmp/does-not-exist-9f3.mp4")).rejects.toThrow(
      FramesError,
    );
  });
});

describe.skipIf(gate)("renderFrames", () => {
  beforeAll(async () => {
    await makeClip();
  });

  test("sheet mode returns one JPEG under the size cap", async () => {
    const img = await renderFrames({
      path: CLIP,
      times: frameTimes({ count: 6, startSec: 0, endSec: 6 }),
      mode: "sheet",
      detail: "low",
      font: "",
    });
    expect(img.mimeType).toBe("image/jpeg");
    const bytes = Buffer.from(img.base64, "base64");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // JPEG SOI
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1536);
    expect(img.height).toBeGreaterThan(0);
  });

  test("frame mode at high detail returns a full-resolution PNG", async () => {
    const img = await renderFrames({
      path: CLIP,
      times: [3],
      mode: "frame",
      detail: "high",
      font: "",
    });
    expect(img.mimeType).toBe("image/png");
    const bytes = Buffer.from(img.base64, "base64");
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(img.width).toBe(640);
    expect(img.height).toBe(360);
  });

  test("a bad font path skips burn-in instead of failing — and reports it", async () => {
    const img = await renderFrames({
      path: CLIP,
      times: [1],
      mode: "frame",
      detail: "low",
      font: "/tmp/no-such-font.ttf",
    });
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.burnIn).toBe(false);
    expect(img.font).toBeNull();
  });

  test.skipIf(!existsSync(DEJAVU))(
    "a real font burns the timestamp in and names the font it used",
    async () => {
      const img = await renderFrames({
        path: CLIP,
        times: [1],
        mode: "frame",
        detail: "low",
        font: DEJAVU,
      });
      expect(img.burnIn).toBe(true);
      expect(img.font).toBe(DEJAVU);
    },
  );

  test("a non-video file is a FramesError, not a crash", async () => {
    const junk = join(DIR, "junk.txt");
    await Bun.write(junk, "not a video");
    await expect(
      renderFrames({ path: junk, times: [0], mode: "frame", detail: "low", font: "" }),
    ).rejects.toThrow(FramesError);
  });
});
