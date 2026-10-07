import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadFramesConfig } from "../src/config";

describe("loadFramesConfig", () => {
  test("defaults to ~/.config/openscreen and the DejaVu font", async () => {
    const cfg = await loadFramesConfig({ HOME: "/home/node" });
    expect(cfg.dataDir).toBe("/home/node/.config/openscreen");
    expect(cfg.font).toBe(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    );
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
    expect(cfg.font).toBe(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    );
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
