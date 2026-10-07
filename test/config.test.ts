import { describe, expect, test } from "bun:test";
import { loadFramesConfig } from "../src/config";

describe("loadFramesConfig", () => {
  test("defaults to ~/.config/openscreen and the DejaVu font", () => {
    const cfg = loadFramesConfig({ HOME: "/home/node" });
    expect(cfg.dataDir).toBe("/home/node/.config/openscreen");
    expect(cfg.font).toBe(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    );
  });

  test("XDG_CONFIG_HOME wins over HOME", () => {
    const cfg = loadFramesConfig({ HOME: "/h", XDG_CONFIG_HOME: "/xdg" });
    expect(cfg.dataDir).toBe("/xdg/openscreen");
  });

  test("OPENSCREEN_DATA_DIR wins over both", () => {
    const cfg = loadFramesConfig({
      HOME: "/h",
      XDG_CONFIG_HOME: "/xdg",
      OPENSCREEN_DATA_DIR: "/custom/data",
    });
    expect(cfg.dataDir).toBe("/custom/data");
  });

  test("OPENSCREEN_FRAMES_FONT overrides; blank falls back to the default", () => {
    expect(
      loadFramesConfig({ HOME: "/h", OPENSCREEN_FRAMES_FONT: "/f.ttf" }).font,
    ).toBe("/f.ttf");
    expect(loadFramesConfig({ HOME: "/h", OPENSCREEN_FRAMES_FONT: "  " }).font)
      .toBe("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  });
});
