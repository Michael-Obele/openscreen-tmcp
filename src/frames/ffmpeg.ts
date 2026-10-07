import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FramesError } from "./errors";

/** Long-edge cap per detail level — the token budget lives here. */
const CAP = { low: 1536, high: 4096 } as const;

export interface Probe {
  durationSec: number;
  width: number;
  height: number;
}

/**
 * Run one binary with an args array (never a shell). Non-zero exit throws a
 * `FramesError` carrying stderr verbatim, because ffmpeg's wording is
 * already the explanation.
 */
async function run(
  bin: string,
  args: string[],
): Promise<{ code: number; out: Buffer; err: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new FramesError(
      `${bin} is not on PATH. Install ffmpeg (it ships ${bin} too): ` +
        "https://ffmpeg.org/download.html",
    );
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const code = await proc.exited;
  return { code, out: Buffer.from(out), err };
}

/** Duration + frame size of the first video stream. */
export async function probe(path: string): Promise<Probe> {
  if (!(await exists(path)))
    throw new FramesError(`No such file: \`${path}\`.`);

  const { code, out, err } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    path,
  ]);
  if (code !== 0)
    throw new FramesError(
      `Not a readable video: \`${path}\`\n${err.trim()}`,
    );

  const json = JSON.parse(out.toString() || "{}") as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const stream = json.streams?.[0];
  if (!stream?.width || !stream?.height)
    throw new FramesError(
      `\`${path}\` has no video stream, so there are no frames to show. ` +
        "Pass `path` to the recording itself (the .mp4), not a sidecar file.",
    );

  const durationSec = Number(json.format?.duration);
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    width: stream.width,
    height: stream.height,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** `00:00:15.500` — the literal that goes into `drawtext`. */
export function hhmmss(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const f = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f, 3)}`;
}

/**
 * Which source seconds to render. `at` is authoritative (sorted,
 * de-duplicated, range-checked); otherwise `count` frames are spread evenly
 * across the window with both ends included.
 */
export function frameTimes(opts: {
  count?: number;
  at?: number[];
  startSec: number;
  endSec: number;
}): number[] {
  const { startSec, endSec } = opts;
  if (!(endSec > startSec))
    throw new FramesError(
      `endSec must be after startSec (got ${startSec} … ${endSec}).`,
    );

  if (opts.at?.length) {
    const out = [...new Set(opts.at)].sort((a, b) => a - b);
    const outside = out.filter((t) => t < startSec || t > endSec);
    if (outside.length)
      throw new FramesError(
        `${outside.map((t) => `${t}s`).join(", ")} outside ` +
          `${startSec}s … ${endSec}s. Widen \`startSec\`/\`endSec\`, or fix \`at\`.`,
      );
    return out;
  }

  const count = opts.count ?? 6;
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw new FramesError(`count must be a whole number 1..16 (got ${count}).`);
  if (count === 1) return [(startSec + endSec) / 2];
  return Array.from(
    { length: count },
    (_, i) => startSec + (i * (endSec - startSec)) / (count - 1),
  );
}

export interface RenderInput {
  path: string;
  /** Source seconds, ascending, already validated by {@link frameTimes}. */
  times: number[];
  mode: "sheet" | "frame";
  detail: "low" | "high";
  /** Font path; a missing file skips the burn-in rather than failing. */
  font: string;
}

export interface RenderedImage {
  base64: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** True only when a timestamp was actually drawn into the pixels. */
  burnIn: boolean;
  /** The font file used for the burn-in, or null when it was skipped. */
  font: string | null;
}

/** Grid: sqrt-rounded, so 6 → 3×2, 4 → 2×2, 16 → 4×4. */
function grid(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.ceil(n / cols) };
}

/** Tile box so the finished sheet fits inside `cap` on both axes. */
function tileBox(
  src: Probe,
  cols: number,
  rows: number,
  cap: number,
): { w: number; h: number } {
  const aspect = src.height / src.width;
  let w = Math.floor(cap / cols);
  let h = Math.max(1, Math.round(w * aspect));
  const maxH = Math.floor(cap / rows);
  if (h > maxH) {
    h = maxH;
    w = Math.max(1, Math.round(h / aspect));
  }
  return { w, h };
}

/**
 * Extract frames with ffmpeg and return one image.
 *
 * Two passes on purpose: a per-frame `-ss` seek burns a *literal* timestamp
 * (computed in JS, so it cannot drift), and a second `xstack` pass tiles
 * them. A single `fps`+`tile` pipeline would be one spawn but would label
 * tiles with times that do not match what the caller asked for.
 */
export async function renderFrames(input: RenderInput): Promise<RenderedImage> {
  const src = await probe(input.path);
  if (input.times.length === 0)
    throw new FramesError("No frames requested — `at` is empty.");

  const dir = await mkdtemp(join(tmpdir(), "openscreen-frames-"));
  try {
    const { cols, rows } = grid(input.times.length);
    const box = tileBox(src, cols, rows, CAP[input.detail]);
    // A missing font file is not an error — ffmpeg would simply have no
    // drawtext — so the decision is made once here and reported back, instead
    // of the caller guessing whether timestamps are in the pixels.
    const burnInFont = input.font && existsSync(input.font) ? input.font : null;
    const burnIn = burnInFont !== null;

    const tiles: string[] = [];
    for (let i = 0; i < input.times.length; i++) {
      const tile = join(dir, `f${String(i).padStart(2, "0")}.png`);
      const chain: string[] = [];
      if (input.mode === "sheet" && input.times.length > 1) {
        chain.push(
          `scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease`,
          `pad=${box.w}:${box.h}:(ow-iw)/2:(oh-ih)/2:color=0x101010`,
        );
      } else if (input.detail === "low") {
        const cap = CAP.low;
        chain.push(`scale=${cap}:${cap}:force_original_aspect_ratio=decrease`);
      }
      if (burnInFont)
        chain.push(
          "drawtext=" +
            `fontfile=${burnInFont}:` +
            `text='${hhmmss(input.times[i]!)}':` +
            "x=8:y=h-th-8:fontsize=22:fontcolor=white:" +
            "box=1:boxcolor=black@0.6:boxborderw=6",
        );

      const vf = chain.length ? ["-vf", chain.join(",")] : [];
      let seek = input.times[i]!;
      let { code, err } = await run("ffmpeg", [
        "-y", "-v", "error", "-ss", String(seek), "-i", input.path,
        ...vf, "-frames:v", "1", tile,
      ]);
      // A seek to the exact end of the stream (t === durationSec) can deliver
      // zero frames — the last encoded frame sits just before it. Retry a
      // hair earlier so the *last* frame is shown for the requested time.
      if (code === 0 && !existsSync(tile)) {
        seek = Math.max(0, seek - 0.1);
        ({ code, err } = await run("ffmpeg", [
          "-y", "-v", "error", "-ss", String(seek), "-i", input.path,
          ...vf, "-frames:v", "1", tile,
        ]));
      }
      if (code !== 0)
        throw new FramesError(
          `ffmpeg could not read \`${input.path}\` at ${hhmmss(input.times[i]!)}:\n${err.trim()}`,
        );
      tiles.push(tile);
    }

    const high = input.detail === "high";
    const out = join(dir, high ? "out.png" : "out.jpg");
    const codec = high
      ? ["-c:v", "png"]
      : ["-c:v", "mjpeg", "-q:v", "4"];

    if (input.mode === "sheet" && tiles.length > 1) {
      const layout = tiles
        .map((_, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          return `${col * box.w}_${row * box.h}`;
        })
        .join("|");
      const { code, err } = await run("ffmpeg", [
        "-y", "-v", "error",
        ...tiles.flatMap((t) => ["-i", t]),
        "-filter_complex",
        `xstack=inputs=${tiles.length}:layout=${layout}`,
        ...codec,
        out,
      ]);
      if (code !== 0) throw new FramesError(`Compositing failed:\n${err.trim()}`);
    } else {
      const { code, err } = await run("ffmpeg", [
        "-y", "-v", "error", "-i", tiles[0]!, ...codec, out,
      ]);
      if (code !== 0) throw new FramesError(`Encoding failed:\n${err.trim()}`);
    }

    const bytes = await readFile(out);
    const dims = await probe(out);
    return {
      base64: bytes.toString("base64"),
      mimeType: high ? "image/png" : "image/jpeg",
      width: dims.width,
      height: dims.height,
      burnIn,
      font: burnInFont,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
