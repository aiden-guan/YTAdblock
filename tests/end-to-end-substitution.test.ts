import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleFetchResponse,
  installFetchInterceptor,
  isInternalFetch
} from "../src/main/fetch-interceptor";
import { AlternatePlayerManager } from "../src/main/alternate-player/alternate-player";
import { PlayerClientPool } from "../src/main/alternate-player/client-pool";
import { mergeCleanPlaybackData } from "../src/main/alternate-player/response-merger";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";
import type { BlockerEvent } from "../src/types/events";

describe("Section 20: Comprehensive Player Substitution Test Suite", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  const addProbeableMedia = (data: any, suffix: string) => {
    const copy = JSON.parse(JSON.stringify(data));
    copy.streamingData ??= {};
    copy.streamingData.formats ??= [];
    if (copy.streamingData.formats.length === 0) {
      copy.streamingData.formats.push({ itag: 18, mimeType: "video/mp4" });
    }
    copy.streamingData.formats[0].url =
      `https://r1---sn-test.googlevideo.com/videoplayback?id=${suffix}`;
    return copy;
  };

  beforeEach(() => {
    emittedEvents = [];
    fakeWindow = {
      fetch: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Ad-bound response: selects alternate clean response, substitutes streamingData, removes ad fields", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "abc123xyz89";
    originalAdResponse.videoDetails.videoId = targetVideoId;

    const cleanCandidateData = addProbeableMedia(cleanFixture, targetVideoId);
    cleanCandidateData.videoDetails.videoId = targetVideoId;
    cleanCandidateData.streamingData.formats[0].itag = 777; // Distinct clean stream marker

    const fakeInternalFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("googlevideo.com")) {
        return new Response(null, { status: 206 });
      }
      return new Response(JSON.stringify(cleanCandidateData), { status: 200 });
    });

    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: targetVideoId },
      alternateManager
    );

    const json = await res.json();

    // Verify clean streaming data selected
    expect(json.streamingData.formats[0].itag).toBe(777);

    // Verify ad fields removed
    expect(json.adPlacements).toBeUndefined();
    expect(json.playerAds).toBeUndefined();
    expect(json.adSlots).toBeUndefined();
    expect(json.adBreakHeartbeatParams).toBeUndefined();

    // Verify events emitted
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "PLAYER_RESPONSE_SUBSTITUTED",
        candidateId: expect.any(String),
        videoId: targetVideoId
      })
    );
  });

  it("2. Clean normal response: does NOT make unnecessary alternate calls, returns immediately", async () => {
    const cleanResponseData = JSON.parse(JSON.stringify(cleanFixture));
    const originalResponse = new Response(JSON.stringify(cleanResponseData), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const fakeInternalFetch = vi.fn();
    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: cleanFixture.videoDetails.videoId },
      alternateManager
    );

    // ZERO alternate calls made
    expect(fakeInternalFetch).not.toHaveBeenCalled();

    // Returned response matches clean fixture
    const json = await res.json();
    expect(json).toEqual(cleanFixture);
  });

  it("3. Alternate wrong video: rejects alternate response and preserves original ad session for fast fallback", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "target-correct-vid";
    originalAdResponse.videoDetails.videoId = targetVideoId;

    const wrongVidData = JSON.parse(JSON.stringify(cleanFixture));
    wrongVidData.videoDetails.videoId = "wrong-unrelated-vid";

    const fakeInternalFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wrongVidData), { status: 200 })
    );

    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: targetVideoId },
      alternateManager
    );

    const json = await res.json();
    // Video ID remains correct and the original ad session is preserved.
    // The DOM fallback can now complete the real ad immediately instead of
    // triggering YouTube's blocked-preroll wait.
    expect(json.videoDetails.videoId).toBe(targetVideoId);
    expect(json.adPlacements).toBeDefined();
    expect(emittedEvents).not.toContainEqual(
      expect.objectContaining({ type: "PLAYER_RESPONSE_SANITIZED" })
    );
  });

  it("4. Alternate unplayable: rejects UNPLAYABLE / ERROR responses", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "abc123xyz89";

    const unplayableData = JSON.parse(JSON.stringify(cleanFixture));
    unplayableData.videoDetails.videoId = targetVideoId;
    unplayableData.playabilityStatus.status = "UNPLAYABLE";

    const fakeInternalFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(unplayableData), { status: 200 })
    );

    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: targetVideoId },
      alternateManager
    );

    const json = await res.json();
    expect(json.playabilityStatus.status).toBe("OK"); // Preserves original OK status, rejects UNPLAYABLE
  });

  it("5. Alternate missing streamingData: rejects response", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "abc123xyz89";

    const invalidData = JSON.parse(JSON.stringify(cleanFixture));
    invalidData.videoDetails.videoId = targetVideoId;
    delete invalidData.streamingData;

    const fakeInternalFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(invalidData), { status: 200 })
    );

    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: targetVideoId },
      alternateManager
    );

    const json = await res.json();
    expect(json.streamingData).toBeDefined(); // Kept original streamingData
  });

  it("6. Alternate contains ads: rejects candidate response that itself has prerolls", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "abc123xyz89";

    // Candidate returns ad response
    const adCandidate = JSON.parse(JSON.stringify(adFixture));

    const fakeInternalFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adCandidate), { status: 200 })
    );

    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: targetVideoId },
      alternateManager
    );

    const json = await res.json();
    expect(json.adPlacements).toBeDefined(); // Preserve real ad session for fast completion fallback
  });

  it("7. Alternate 403 media: marks candidate unhealthy and rotates candidate", () => {
    const pool = new PlayerClientPool();
    pool.markSuccess("web-embedded");
    expect(pool.getPreferredClient()).toBe("web-embedded");

    // Media request fails with 403
    pool.markFailure("web-embedded", "MEDIA_403");
    expect(pool.getPreferredClient()).toBeNull(); // Rotated away

    pool.markFailure("web-embedded", "MEDIA_403");
    const candidates = pool.getCandidates();
    // web-embedded is suppressed from candidates
    expect(candidates.find((c) => c.id === "web-embedded")).toBeUndefined();
  });

  it("8. Timeout: falls back within budget when alternate requests hang", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "abc123xyz89";

    // Candidate hangs indefinitely
    const fakeInternalFetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    const clientPool = new PlayerClientPool();
    const alternateManager = new AlternatePlayerManager(clientPool, fakeInternalFetch);

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const start = Date.now();
    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      (ev) => emittedEvents.push(ev),
      { videoId: targetVideoId },
      alternateManager
    );
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1500); // Bounded alternate attempt, then immediate fallback
    const json = await res.json();
    expect(json.adPlacements).toBeDefined(); // Original ad session preserved to avoid backoff
  });

  it("9. Two successful candidates: first valid one wins; other is aborted", async () => {
    const pool = new PlayerClientPool();
    let abortedCandidate: string | null = null;

    const cleanData = addProbeableMedia(cleanFixture, "vid-race-9");
    cleanData.videoDetails.videoId = "vid-race-9";

    const fakeInternalFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).includes("googlevideo.com")) {
        return new Response(null, { status: 206 });
      }

      const body = JSON.parse(init.body as string);
      const clientName = body.context?.client?.clientName;

      init.signal?.addEventListener("abort", () => {
        abortedCandidate = clientName;
      });

      if (clientName === "WEB_EMBEDDED_PLAYER") {
        return new Response(JSON.stringify(cleanData), { status: 200 });
      }

      // Slower second candidate
      await new Promise((r) => setTimeout(r, 100));
      return new Response(JSON.stringify(cleanData), { status: 200 });
    });

    const manager = new AlternatePlayerManager(pool, fakeInternalFetch);
    const result = await manager.fetchCleanAlternateResponse(
      { videoId: "vid-race-9", context: {} },
      "vid-race-9"
    );

    expect(result?.candidateId).toBe("web-embedded");
    expect(abortedCandidate).not.toBeNull();
  });

  it("10. Recursion: internal fetch never invokes interceptor again", async () => {
    let interceptorCallCount = 0;

    fakeWindow.fetch = vi.fn().mockImplementation(async (input: any, init?: any) => {
      if (isInternalFetch(input, init)) {
        return new Response(JSON.stringify(cleanFixture));
      }
      interceptorCallCount++;
      return new Response(JSON.stringify(adFixture));
    });

    const teardown = installFetchInterceptor(fakeWindow);

    // Call with internal header
    const internalReq = new Request("https://www.youtube.com/youtubei/v1/player", {
      headers: { "X-YTClean-Internal": "1" }
    });
    await fakeWindow.fetch(internalReq);

    // Did NOT call interceptor handler
    expect(interceptorCallCount).toBe(0);

    teardown();
  });

  it("11. SPA navigation: old candidate requests are aborted immediately", async () => {
    const pool = new PlayerClientPool();
    let aborted = false;

    const fakeInternalFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {}); // never finishes
    });

    const manager = new AlternatePlayerManager(pool, fakeInternalFetch);
    const promise = manager.fetchCleanAlternateResponse(
      { videoId: "spa-nav-vid", context: {} },
      "spa-nav-vid",
      1500
    );

    // SPA navigation occurs
    manager.abortAllPending();
    await promise;

    expect(aborted).toBe(true);
  });

  it("12. Original response: original object remains strictly immutable", () => {
    const original = JSON.parse(JSON.stringify(adFixture));
    const originalSerialized = JSON.stringify(original);

    const cleanCandidate = JSON.parse(JSON.stringify(cleanFixture));
    const merged = mergeCleanPlaybackData(original, cleanCandidate);

    expect(merged).not.toBe(original);
    expect(JSON.stringify(original)).toBe(originalSerialized);
  });
});
