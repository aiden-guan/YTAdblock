import { describe, it, expect } from "vitest";
import { sanitizePlayerResponse } from "../src/main/player-response";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";
import malformedFixture from "./fixtures/player-malformed.json";
import minimalFixture from "./fixtures/player-minimal.json";

describe("sanitizePlayerResponse", () => {
  it("preserves clean player response without modifications", () => {
    const originalJson = JSON.stringify(cleanFixture);
    const { sanitized, report } = sanitizePlayerResponse(cleanFixture);

    expect(report.changed).toBe(false);
    expect(report.removed).toEqual([]);
    expect(sanitized).toEqual(cleanFixture);
    expect(JSON.stringify(cleanFixture)).toBe(originalJson);
  });

  it("removes known ad fields from standard ad response", () => {
    const copy = JSON.parse(JSON.stringify(adFixture));
    const originalJson = JSON.stringify(copy);

    const { sanitized, report } = sanitizePlayerResponse(copy);

    expect(report.changed).toBe(true);
    expect(report.removed).toEqual(
      expect.arrayContaining(["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"])
    );

    // Verify ad fields are eliminated
    const res = sanitized as Record<string, unknown>;
    expect(res.adPlacements).toBeUndefined();
    expect(res.playerAds).toBeUndefined();
    expect(res.adSlots).toBeUndefined();
    expect(res.adBreakHeartbeatParams).toBeUndefined();

    // Verify critical playback metadata is strictly preserved
    expect(res.videoDetails).toEqual(adFixture.videoDetails);
    expect(res.streamingData).toEqual(adFixture.streamingData);
    expect(res.playabilityStatus).toEqual(adFixture.playabilityStatus);
    expect(res.captions).toEqual(adFixture.captions);
    expect(res.microformat).toEqual(adFixture.microformat);
    expect(res.playbackTracking).toEqual(adFixture.playbackTracking);

    // Verify input immutability
    expect(JSON.stringify(copy)).toBe(originalJson);
  });

  it("fails open on null, undefined, and primitive inputs", () => {
    expect(sanitizePlayerResponse(null)).toEqual({
      sanitized: null,
      report: { changed: false, removed: [] }
    });
    expect(sanitizePlayerResponse(undefined)).toEqual({
      sanitized: undefined,
      report: { changed: false, removed: [] }
    });
    expect(sanitizePlayerResponse("some string")).toEqual({
      sanitized: "some string",
      report: { changed: false, removed: [] }
    });
    expect(sanitizePlayerResponse(12345)).toEqual({
      sanitized: 12345,
      report: { changed: false, removed: [] }
    });
    expect(sanitizePlayerResponse(true)).toEqual({
      sanitized: true,
      report: { changed: false, removed: [] }
    });
  });

  it("fails open on array inputs and does not delete elements", () => {
    const arrayInput = ["adPlacements", "videoDetails"];
    const { sanitized, report } = sanitizePlayerResponse(arrayInput);
    expect(report.changed).toBe(false);
    expect(sanitized).toBe(arrayInput);
  });

  it("fails open on malformed unexpected schemas", () => {
    const { sanitized, report } = sanitizePlayerResponse(malformedFixture);
    expect(report.changed).toBe(false);
    expect(sanitized).toEqual(malformedFixture);
  });

  it("handles minimal valid player response", () => {
    const { sanitized, report } = sanitizePlayerResponse(minimalFixture);
    expect(report.changed).toBe(false);
    expect(sanitized).toEqual(minimalFixture);
  });

  it("never deletes general fields containing substring 'ad' unless explicitly allowlisted", () => {
    const trickyObject = {
      videoDetails: { title: "Adventure Time" },
      broadcastDetails: { isLive: false },
      streamingData: { formats: [] },
      adPlacements: [{ id: "ad1" }],
      // Fields that contain "ad" but are legitimate:
      adaptiveFormats: [1, 2, 3],
      downloadStatus: "ok",
      uploadDate: "2024-01-01",
      additionalInfo: "valuable metadata"
    };

    const { sanitized, report } = sanitizePlayerResponse(trickyObject);
    expect(report.changed).toBe(true);
    expect(report.removed).toEqual(["adPlacements"]);

    const res = sanitized as Record<string, unknown>;
    expect(res.adaptiveFormats).toEqual([1, 2, 3]);
    expect(res.downloadStatus).toBe("ok");
    expect(res.uploadDate).toBe("2024-01-01");
    expect(res.additionalInfo).toBe("valuable metadata");
    expect(res.adPlacements).toBeUndefined();
  });
});
