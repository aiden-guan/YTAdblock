import { describe, it, expect } from "vitest";
import { detectPrerollInfo } from "../src/main/preroll-detector";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";

describe("detectPrerollInfo", () => {
  it("detects no prerolls on clean response", () => {
    const info = detectPrerollInfo(cleanFixture);
    expect(info.hasPreroll).toBe(false);
    expect(info.adCount).toBe(0);
    expect(info.estimatedDurationMs).toBe(0);
  });

  it("detects prerolls and derives duration on standard ad fixture", () => {
    const info = detectPrerollInfo(adFixture);
    expect(info.hasPreroll).toBe(true);
    expect(info.adCount).toBeGreaterThan(0);
    expect(info.estimatedDurationMs).toBeGreaterThan(0);
  });

  it("distinguishes preroll (offset 0) from midroll (offset > 0)", () => {
    const midrollOnly = {
      videoDetails: { videoId: "test1" },
      adPlacements: [
        {
          adPlacementRenderer: {
            config: {
              adTimeOffset: { offset: "120000" } // 2 minutes in
            }
          }
        },
        {
          adPlacementRenderer: {
            config: {
              adTimeOffset: { offset: "300000" } // 5 minutes in
            }
          }
        }
      ]
    };

    const info = detectPrerollInfo(midrollOnly);
    expect(info.hasPreroll).toBe(false);
    expect(info.adCount).toBe(0);
    expect(info.estimatedDurationMs).toBe(0);
  });

  it("extracts exact linear ad duration when present", () => {
    const responseWithLinearAds = {
      videoDetails: { videoId: "linear-test" },
      adPlacements: [
        {
          adPlacementRenderer: {
            config: {
              adTimeOffset: { offset: "0" }
            },
            renderer: {
              linearAdSequenceRenderer: {
                linearAds: [
                  {
                    playerLinearAdRenderer: {
                      durationMilliseconds: "6000"
                    }
                  },
                  {
                    playerLinearAdRenderer: {
                      durationMilliseconds: "15000"
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    };

    const info = detectPrerollInfo(responseWithLinearAds);
    expect(info.hasPreroll).toBe(true);
    expect(info.adCount).toBe(1);
    expect(info.estimatedDurationMs).toBe(21000);
  });

  it("fails safely and returns hasPreroll=false on null/empty/malformed inputs", () => {
    expect(detectPrerollInfo(null).hasPreroll).toBe(false);
    expect(detectPrerollInfo(undefined).hasPreroll).toBe(false);
    expect(detectPrerollInfo("random string").hasPreroll).toBe(false);
    expect(detectPrerollInfo({}).hasPreroll).toBe(false);
    expect(detectPrerollInfo([]).hasPreroll).toBe(false);
  });
});
