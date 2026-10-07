import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadFramesConfig } from "../src/config";

// The default font is the Debian DejaVu path. `loadFramesConfig` falls back to
// `fc-match` when that file is absent, so the exact path is only assertable on a
// host that has it; every other host still gets checked for a usable font.
const DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const hasDejavu = existsSync(DEJAVU);

/**
 * Assert the default font resolution without pinning the host. Where the DejaVu
 * file exists the resolved font must be exactly that path; elsewhere `fc-match`
 * may name a real font, or (with no fontconfig either) the configured default is
 * kept so render skips burn-in. Never empty.
 */
function expectResolvedDefaultFont(font: string): void {
  expect(font).not.toBe("");
  if (hasDejavu) expect(font).toBe(DEJAVU);
  else expect(existsSync(font) || font === DEJAVU).toBe(true);
}

describe("loadFramesConfig", () => {
  test("defaults to ~/.config/openscreen and the DejaVu font", async () => {
    const cfg = await loadFramesConfig({ HOME: "/home/node" });
    expect(cfg.dataDir).toBe("/home/node/.config/openscreen");
    expectResolvedDefaultFont(cfg.font);
  });

  test("XDG_CONFIG_HOME wins over HOME", async () => {
    const cfg = await loadFramesConfig({ HOME: "/h", XDG_CONFIG_HOME: "/xdg" });
    expect(cfg.dataDir).toBe("/xdg/openscreen");
  });

  test("OPENSCREEN_DATA_DIR wins over both", async () => {
    const cfg = await loadFramesConfig({
      HOME: "/h",
      XDG_CONFIG_HOME: "/xdg",
      OPENSCREEN_DATA_DIR: "/custom/data",
    });
    expect(cfg.dataDir).toBe("/custom/data");
  });

  test("an existing OPENSCREEN_FRAMES_FONT is kept verbatim", async () => {
    // A file that certainly exists, so this tests the override rather than the
    // fallback — and never depends on the host's installed fonts.
    const pkg = join(import.meta.dir, "..", "package.json");
    const cfg = await loadFramesConfig({
      HOME: "/h",
      OPENSCREEN_FRAMES_FONT: pkg,
    });
    expect(cfg.font).toBe(pkg);
  });

  test("a blank OPENSCREEN_FRAMES_FONT falls back to the default", async () => {
    const cfg = await loadFramesConfig({
      HOME: "/h",
      OPENSCREEN_FRAMES_FONT: "  ",
    });
    expectResolvedDefaultFont(cfg.font);
  });

  test("a missing font file falls back to fc-match, never to an empty string", async () => {
    const missing = "/definitely/not/a/font-2f9c1f.ttf";
    const cfg = await loadFramesConfig({
      HOME: "/h",
      OPENSCREEN_FRAMES_FONT: missing,
    });
    // Either fontconfig named a real file, or the configured value is kept so
    // render's exists-check skips burn-in. Never "" and never an unreadable path.
    expect(cfg.font).not.toBe("");
    expect(cfg.font === missing || existsSync(cfg.font)).toBe(true);
  });
});
