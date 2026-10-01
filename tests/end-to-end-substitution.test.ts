import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleFetchResponse,
  installFetchInterceptor,
  isInternalFetch
} from "../src/main/fetch-interceptor";
import {
  AlternatePlayerManager,
  type PlayerRequestSnapshot
} from "../src/main/alternate-player/alternate-player";
import { PlayerClientPool } from "../src/main/alternate-player/client-pool";
import { mergeCleanPlaybackData } from "../src/main/alternate-player/response-merger";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";
import type { BlockerEvent } from "../src/types/events";

describe("player substitution integration", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    emittedEvents = [];
    fakeWindow = { fetch: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("substitutes a valid clean alternate response and removes preroll fields", async () => {
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    const targetVideoId = "abc123xyz89";
    originalAdResponse.videoDetails.videoId = targetVideoId;

    const cleanCandidateData = JSON.parse(JSON.stringify(cleanFixture));
    cleanCandidateData.videoDetails.videoId = targetVideoId;
    cleanCandidateData.streamingData.formats[0].itag = 777;

    const fakeInternalFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(cleanCandidateData), { status: 200 })
    );

    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      fakeInternalFetch
    );

    const snapshot: PlayerRequestSnapshot = {
      url: "https://www.youtube.com/youtubei/v1/player?key=real-key&prettyPrint=false",
      payload: {
        videoId: targetVideoId,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20260708.00.00",
            visitorData: "visitor-123"
          }
        }
      },
      headers: [
        ["content-type", "application/json"],
        ["x-goog-visitor-id", "visitor-123"],
        ["x-youtube-client-name", "1"],
        ["x-youtube-client-version", "2.20260708.00.00"]
      ],
      credentials: "include"
    };

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      snapshot.url,
      (ev) => emittedEvents.push(ev),
      snapshot,
      manager
    );

    const json = await res.json();
    expect(json.streamingData.formats[0].itag).toBe(777);
    expect(json.adPlacements).toBeUndefined();
    expect(json.playerAds).toBeUndefined();
    expect(json.adSlots).toBeUndefined();

    expect(fakeInternalFetch).toHaveBeenCalled();
    const [calledUrl, calledInit] = fakeInternalFetch.mock.calls[0];
    expect(calledUrl).toBe(snapshot.url);
    expect(calledInit.credentials).toBe("include");
    expect(new Headers(calledInit.headers).get("x-goog-visitor-id")).toBe(
      "visitor-123"
    );

    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "PLAYER_RESPONSE_SUBSTITUTED",
        videoId: targetVideoId
      })
    );
  });

  it("does not make alternate calls for a clean player response", async () => {
    const fakeInternalFetch = vi.fn();
    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      fakeInternalFetch
    );

    const originalResponse = new Response(JSON.stringify(cleanFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      undefined,
      {
        videoId: cleanFixture.videoDetails.videoId,
        context: { client: { clientName: "WEB" } }
      },
      manager
    );

    expect(fakeInternalFetch).not.toHaveBeenCalled();
    expect(await res.json()).toEqual(cleanFixture);
  });

  it("fails open to the original preroll response when all alternate clients are invalid", async () => {
    const targetVideoId = "target-correct-vid";
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    originalAdResponse.videoDetails.videoId = targetVideoId;

    const wrongVideo = JSON.parse(JSON.stringify(cleanFixture));
    wrongVideo.videoDetails.videoId = "wrong-video";

    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(wrongVideo), { status: 200 })
      )
    );

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200
    });

    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player?key=x",
      undefined,
      { videoId: targetVideoId, context: {} },
      manager
    );

    const json = await res.json();
    expect(json.videoDetails.videoId).toBe(targetVideoId);
    expect(json.adPlacements).toBeDefined();
    expect(json.playerAds).toBeDefined();
  });

  it("fails open on alternate timeout instead of manufacturing a stripped preroll session", async () => {
    const targetVideoId = "timeout-video";
    const originalAdResponse = JSON.parse(JSON.stringify(adFixture));
    originalAdResponse.videoDetails.videoId = targetVideoId;

    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      vi.fn().mockImplementation(() => new Promise(() => {}))
    );

    const originalResponse = new Response(JSON.stringify(originalAdResponse), {
      status: 200
    });

    const start = Date.now();
    const res = await handleFetchResponse(
      originalResponse,
      "https://www.youtube.com/youtubei/v1/player",
      undefined,
      { videoId: targetVideoId, context: {} },
      manager
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1700);
    expect((await res.json()).adPlacements).toBeDefined();
  });

  it("updates candidate request header identity to match the candidate body", async () => {
    const cleanData = JSON.parse(JSON.stringify(cleanFixture));
    cleanData.videoDetails.videoId = "candidate-header-video";

    const fakeInternalFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(cleanData), { status: 200 })
    );
    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      fakeInternalFetch
    );

    await manager.fetchCleanAlternateResponse(
      {
        url: "https://www.youtube.com/youtubei/v1/player?key=abc",
        payload: {
          videoId: "candidate-header-video",
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20260708.00.00",
              visitorData: "v1"
            }
          }
        },
        headers: [
          ["x-youtube-client-name", "1"],
          ["x-youtube-client-version", "2.20260708.00.00"],
          ["x-goog-visitor-id", "v1"]
        ]
      },
      "candidate-header-video"
    );

    const [, init] = fakeInternalFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const headers = new Headers(init.headers);

    expect(body.context.client.clientName).toBe("WEB_EMBEDDED_PLAYER");
    expect(body.context.thirdParty.embedUrl).toBe("https://www.reddit.com/");
    expect(headers.get("x-youtube-client-name")).toBe("56");
    expect(headers.get("x-youtube-client-version")).toBe("2.20260708.00.00");
    expect(headers.get("x-goog-visitor-id")).toBe("v1");
  });

  it("suppresses a candidate after repeated media authorization failures", () => {
    const pool = new PlayerClientPool();
    pool.markSuccess("web-embedded");
    pool.markFailure("web-embedded", "MEDIA_403");
    pool.markFailure("web-embedded", "MEDIA_403");

    expect(
      pool.getCandidates().find((candidate) => candidate.id === "web-embedded")
    ).toBeUndefined();
  });

  it("aborts in-flight candidate requests on SPA navigation", async () => {
    const pool = new PlayerClientPool();
    let aborted = false;

    const fakeInternalFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      }
    );

    const manager = new AlternatePlayerManager(pool, fakeInternalFetch);
    const promise = manager.fetchCleanAlternateResponse(
      { videoId: "spa-video", context: {} },
      "spa-video",
      1000
    );

    manager.abortAllPending();
    await promise;
    expect(aborted).toBe(true);
  });

  it("keeps explicit internal requests outside the interceptor", async () => {
    let primaryCalls = 0;
    fakeWindow.fetch = vi.fn().mockImplementation(
      async (input: any, init?: RequestInit) => {
        if (isInternalFetch(input, init)) {
          return new Response(JSON.stringify(cleanFixture));
        }
        primaryCalls++;
        return new Response(JSON.stringify(adFixture));
      }
    );

    const teardown = installFetchInterceptor(fakeWindow);
    const request = new Request(
      "https://www.youtube.com/youtubei/v1/player",
      { headers: { "X-YTClean-Internal": "1" } }
    );

    await fakeWindow.fetch(request);
    expect(primaryCalls).toBe(0);
    teardown();
  });

  it("does not mutate the original response object during merging", () => {
    const original = JSON.parse(JSON.stringify(adFixture));
    const serialized = JSON.stringify(original);
    const clean = JSON.parse(JSON.stringify(cleanFixture));

    const merged = mergeCleanPlaybackData(original, clean);
    expect(merged).not.toBe(original);
    expect(JSON.stringify(original)).toBe(serialized);
  });
});
