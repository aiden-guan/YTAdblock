import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlayerClientPool } from "../src/main/alternate-player/client-pool";
import { validateAlternatePlayerResponse } from "../src/main/alternate-player/response-validator";
import { mergeCleanPlaybackData } from "../src/main/alternate-player/response-merger";
import { AlternatePlayerManager } from "../src/main/alternate-player/alternate-player";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";

describe("PlayerClientPool", () => {
  it("starts with browser-usable PO-token-light candidates", () => {
    const pool = new PlayerClientPool();
    const candidates = pool.getCandidates();

    expect(candidates.slice(0, 4).map((c) => c.id)).toEqual([
      "tv-downgraded",
      "web-embedded",
      "tvhtml5",
      "visionos"
    ]);

    expect(candidates.findIndex((c) => c.id === "mweb-ad-context")).toBeGreaterThanOrEqual(4);
  });

  it("prioritizes preferredCleanClient on subsequent requests", () => {
    const pool = new PlayerClientPool();
    const initialCandidates = pool.getCandidates();
    expect(initialCandidates.length).toBeGreaterThan(1);

    // Mark tvhtml5 successful
    pool.markSuccess("tvhtml5", 150);
    expect(pool.getPreferredClient()).toBe("tvhtml5");

    const reordered = pool.getCandidates();
    expect(reordered[0].id).toBe("tvhtml5");
  });

  it("suppresses candidate after repeated media 403s and rotates preferred client", () => {
    const pool = new PlayerClientPool();
    pool.markSuccess("tvhtml5");
    expect(pool.getPreferredClient()).toBe("tvhtml5");

    pool.markFailure("tvhtml5", "MEDIA_403");
    expect(pool.getPreferredClient()).toBeNull(); // Rotated away

    pool.markFailure("tvhtml5", "MEDIA_403");
    // Exceeded threshold of 2
    const remaining = pool.getCandidates();
    expect(remaining.find((c) => c.id === "tvhtml5")).toBeUndefined();
  });
});

describe("validateAlternatePlayerResponse", () => {
  it("validates legitimate clean response with matching videoId", () => {
    const copy = JSON.parse(JSON.stringify(cleanFixture));
    copy.videoDetails.videoId = "target-vid-1";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(true);
  });

  it("rejects response when videoId does not match", () => {
    const copy = JSON.parse(JSON.stringify(cleanFixture));
    copy.videoDetails.videoId = "wrong-vid";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);
  });

  it("rejects response when playabilityStatus is not OK", () => {
    const copy = JSON.parse(JSON.stringify(cleanFixture));
    copy.videoDetails.videoId = "target-vid-1";

    copy.playabilityStatus.status = "LOGIN_REQUIRED";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);

    copy.playabilityStatus.status = "AGE_CHECK_REQUIRED";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);

    copy.playabilityStatus.status = "UNPLAYABLE";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);

    copy.playabilityStatus.status = "ERROR";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);
  });

  it("rejects response when streamingData is missing or has no formats", () => {
    const copy = JSON.parse(JSON.stringify(cleanFixture));
    copy.videoDetails.videoId = "target-vid-1";

    delete copy.streamingData;
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);

    copy.streamingData = { formats: [], adaptiveFormats: [] };
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);
  });

  it("rejects response if it contains preroll ad structures", () => {
    const copy = JSON.parse(JSON.stringify(adFixture));
    copy.videoDetails.videoId = "target-vid-1";
    expect(validateAlternatePlayerResponse(copy, "target-vid-1")).toBe(false);
  });
});

describe("mergeCleanPlaybackData", () => {
  it("preserves original web fields while replacing streamingData and removing ad fields", () => {
    const original = JSON.parse(JSON.stringify(adFixture));
    original.customWebField = "important-web-metadata";
    original.captions = { captionTracks: [{ lang: "en" }] };

    const alternate = JSON.parse(JSON.stringify(cleanFixture));
    alternate.streamingData.formats[0].itag = 999; // Distinct marker

    const merged = mergeCleanPlaybackData(original, alternate) as Record<string, unknown>;

    // Ad fields removed
    expect(merged.adPlacements).toBeUndefined();
    expect(merged.playerAds).toBeUndefined();
    expect(merged.adSlots).toBeUndefined();
    expect(merged.adBreakHeartbeatParams).toBeUndefined();

    // Original web metadata preserved
    expect(merged.customWebField).toBe("important-web-metadata");
    expect(merged.captions).toEqual(original.captions);
    expect(merged.videoDetails).toEqual(original.videoDetails);

    // Clean streaming data substituted
    expect((merged.streamingData as any).formats[0].itag).toBe(999);

    // Original object immutable
    expect(original.adPlacements).toBeDefined();
    expect(original.streamingData.formats[0].itag).not.toBe(999);
  });
});

describe("AlternatePlayerManager race and lifecycle", () => {
  let fakeFetch: any;

  beforeEach(() => {
    fakeFetch = vi.fn();
  });

  it("builds client-specific payload identity including context user agent", () => {
    const pool = new PlayerClientPool();
    const manager = new AlternatePlayerManager(pool, fakeFetch);
    const candidate = pool.getProfile("tv-downgraded");

    expect(candidate).toBeDefined();

    const payload = manager.buildCandidatePayload(
      {
        videoId: "ctx-video",
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.0",
            visitorData: "visitor-1"
          }
        }
      },
      candidate!,
      "ctx-video"
    ) as any;

    expect(payload.context.client.clientName).toBe("TVHTML5");
    expect(payload.context.client.clientVersion).toBe("5.20260707");
    expect(payload.context.client.userAgent).toBe(
      "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"
    );
    expect(payload.context.client.visitorData).toBe("visitor-1");
  });

  it("executes bounded race and selects first valid clean candidate while aborting others", async () => {
    const pool = new PlayerClientPool();
    const cleanData = JSON.parse(JSON.stringify(cleanFixture));
    cleanData.videoDetails.videoId = "race-video-123";

    fakeFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const clientName = body.context?.client?.clientName;

      if (clientName === "WEB_EMBEDDED_PLAYER") {
        // Fast clean response
        return new Response(JSON.stringify(cleanData), { status: 200 });
      }
      // Slower response
      await new Promise((r) => setTimeout(r, 200));
      return new Response(JSON.stringify(cleanData), { status: 200 });
    });

    const manager = new AlternatePlayerManager(pool, fakeFetch);
    const result = await manager.fetchCleanAlternateResponse(
      { videoId: "race-video-123", context: {} },
      "race-video-123"
    );

    expect(result).not.toBeNull();
    expect(result?.candidateId).toBe("web-embedded");
    expect(pool.getPreferredClient()).toBe("web-embedded");
  });

  it("falls back cleanly to null if all candidates fail or return invalid responses", async () => {
    const pool = new PlayerClientPool();
    // Return HTTP 500 for all candidates
    fakeFetch.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    const manager = new AlternatePlayerManager(pool, fakeFetch);
    const result = await manager.fetchCleanAlternateResponse(
      { videoId: "failing-video", context: {} },
      "failing-video",
      100 // short timeout
    );

    expect(result).toBeNull();
  });

  it("falls back cleanly when timeout budget expires", async () => {
    const pool = new PlayerClientPool();
    // Slower than time budget
    fakeFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return new Response(JSON.stringify(cleanFixture));
    });

    const manager = new AlternatePlayerManager(pool, fakeFetch);
    const result = await manager.fetchCleanAlternateResponse(
      { videoId: "slow-video", context: {} },
      "slow-video",
      50 // 50ms budget
    );

    expect(result).toBeNull();
  });

  it("aborts in-flight candidate requests on SPA navigation", async () => {
    const pool = new PlayerClientPool();
    let abortedSignal: boolean | undefined = false;

    fakeFetch.mockImplementation((url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {
        abortedSignal = true;
      });
      return new Promise(() => {}); // never resolves
    });

    const manager = new AlternatePlayerManager(pool, fakeFetch);
    const promise = manager.fetchCleanAlternateResponse(
      { videoId: "spa-video", context: {} },
      "spa-video",
      1000
    );

    // Simulate SPA navigation
    manager.abortAllPending();

    await promise;
    expect(abortedSignal).toBe(true);
  });
});
