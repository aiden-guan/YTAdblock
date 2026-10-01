import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installFetchInterceptor,
  isPlayerEndpoint,
  extractUrlFromFetchInput,
  createSanitizedResponse,
  capturePlayerRequest,
  handleFetchResponse
} from "../src/main/fetch-interceptor";
import { AlternatePlayerManager } from "../src/main/alternate-player/alternate-player";
import { PlayerClientPool } from "../src/main/alternate-player/client-pool";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";
import type { BlockerEvent } from "../src/types/events";

describe("fetch-interceptor", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    emittedEvents = [];
    fakeWindow = { fetch: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies player endpoints correctly", () => {
    expect(isPlayerEndpoint("/youtubei/v1/player")).toBe(true);
    expect(
      isPlayerEndpoint("https://www.youtube.com/youtubei/v1/player?key=ABC")
    ).toBe(true);
    expect(isPlayerEndpoint("/youtubei/v1/next")).toBe(false);
  });

  it("extracts URL from strings, URL objects and Requests", () => {
    expect(extractUrlFromFetchInput("https://www.youtube.com/test")).toBe(
      "https://www.youtube.com/test"
    );
    expect(
      extractUrlFromFetchInput(new URL("https://www.youtube.com/test"))
    ).toBe("https://www.youtube.com/test");
    expect(
      extractUrlFromFetchInput(
        new Request("https://www.youtube.com/test")
      )
    ).toBe("https://www.youtube.com/test");
  });

  it("captures Request-object body, headers, credentials and exact URL before fetch consumes it", async () => {
    const req = new Request(
      "https://www.youtube.com/youtubei/v1/player?key=abc&prettyPrint=false",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-visitor-id": "visitor-1"
        },
        credentials: "include",
        body: JSON.stringify({
          videoId: "video-1",
          context: { client: { clientName: "WEB" } }
        })
      }
    );

    const snapshot = await capturePlayerRequest(req, undefined, req.url);
    expect(snapshot?.url).toBe(req.url);
    expect(snapshot?.payload.videoId).toBe("video-1");
    expect(snapshot?.credentials).toBe("include");
    expect(new Headers(snapshot?.headers).get("x-goog-visitor-id")).toBe(
      "visitor-1"
    );
  });

  it("leaves unrelated YouTube requests untouched", async () => {
    const unrelatedData = { contents: { results: [1, 2, 3] } };
    const originalResponse = new Response(JSON.stringify(unrelatedData), {
      status: 200
    });
    fakeWindow.fetch = vi.fn().mockResolvedValue(originalResponse);

    const teardown = installFetchInterceptor(
      fakeWindow,
      (event) => emittedEvents.push(event)
    );

    const res = await fakeWindow.fetch(
      "https://www.youtube.com/youtubei/v1/browse"
    );
    expect(res).toBe(originalResponse);
    expect(await res.json()).toEqual(unrelatedData);
    expect(emittedEvents).toEqual([]);
    teardown();
  });

  it("substitutes a clean alternate response for an ad-bound player request", async () => {
    const targetVideoId = "target-video";
    const adData = JSON.parse(JSON.stringify(adFixture));
    adData.videoDetails.videoId = targetVideoId;

    const cleanData = JSON.parse(JSON.stringify(cleanFixture));
    cleanData.videoDetails.videoId = targetVideoId;
    cleanData.streamingData.formats[0].itag = 991;

    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(cleanData), { status: 200 })
      )
    );

    const original = new Response(JSON.stringify(adData), { status: 200 });
    const res = await handleFetchResponse(
      original,
      "https://www.youtube.com/youtubei/v1/player?key=abc",
      (event) => emittedEvents.push(event),
      {
        url: "https://www.youtube.com/youtubei/v1/player?key=abc",
        payload: {
          videoId: targetVideoId,
          context: { client: { clientName: "WEB" } }
        },
        headers: [["content-type", "application/json"]]
      },
      manager
    );

    const json = await res.json();
    expect(json.streamingData.formats[0].itag).toBe(991);
    expect(json.adPlacements).toBeUndefined();
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({ type: "PLAYER_RESPONSE_SUBSTITUTED" })
    );
  });

  it("preserves the original preroll when alternate substitution fails", async () => {
    const targetVideoId = "target-video";
    const adData = JSON.parse(JSON.stringify(adFixture));
    adData.videoDetails.videoId = targetVideoId;

    const manager = new AlternatePlayerManager(
      new PlayerClientPool(),
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 }))
    );

    const original = new Response(JSON.stringify(adData), { status: 200 });
    const res = await handleFetchResponse(
      original,
      "https://www.youtube.com/youtubei/v1/player",
      undefined,
      { videoId: targetVideoId, context: {} },
      manager
    );

    const json = await res.json();
    expect(json.adPlacements).toBeDefined();
    expect(json.playerAds).toBeDefined();
  });

  it("leaves clean player responses untouched", async () => {
    const originalResponse = new Response(JSON.stringify(cleanFixture), {
      status: 200
    });
    fakeWindow.fetch = vi.fn().mockResolvedValue(originalResponse);

    const teardown = installFetchInterceptor(
      fakeWindow,
      (event) => emittedEvents.push(event)
    );

    const res = await fakeWindow.fetch("/youtubei/v1/player");
    expect(res).toBe(originalResponse);
    expect(await res.json()).toEqual(cleanFixture);
    teardown();
  });

  it("preserves network rejection errors", async () => {
    fakeWindow.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const teardown = installFetchInterceptor(fakeWindow);

    await expect(
      fakeWindow.fetch("/youtubei/v1/player")
    ).rejects.toThrow("Failed to fetch");

    teardown();
  });

  it("is idempotent and does not double-wrap fetch", () => {
    const original = fakeWindow.fetch;
    const teardown1 = installFetchInterceptor(fakeWindow);
    const patched = fakeWindow.fetch;
    const teardown2 = installFetchInterceptor(fakeWindow);

    expect(fakeWindow.fetch).toBe(patched);
    teardown1();
    teardown2();
    expect(fakeWindow.fetch).toBe(original);
  });

  it("preserves replacement Response behavior", async () => {
    const original = new Response(JSON.stringify(adFixture), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" }
    });
    const sanitized = createSanitizedResponse(original, { clean: true });

    expect(sanitized.status).toBe(200);
    expect(await sanitized.clone().json()).toEqual({ clean: true });
    expect(await sanitized.json()).toEqual({ clean: true });
    expect(() => sanitized.clone()).toThrow();
  });
});
