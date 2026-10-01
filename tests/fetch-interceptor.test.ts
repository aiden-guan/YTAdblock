import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installFetchInterceptor,
  isPlayerEndpoint,
  extractUrlFromFetchInput,
  createSanitizedResponse
} from "../src/main/fetch-interceptor";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";
import type { BlockerEvent } from "../src/types/events";

describe("fetch-interceptor", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    emittedEvents = [];
    fakeWindow = {
      fetch: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies player endpoints correctly across relative and absolute URLs", () => {
    expect(isPlayerEndpoint("/youtubei/v1/player")).toBe(true);
    expect(isPlayerEndpoint("https://www.youtube.com/youtubei/v1/player?key=ABC")).toBe(true);
    expect(isPlayerEndpoint("https://m.youtube.com/youtubei/v1/player")).toBe(true);
    expect(isPlayerEndpoint("/youtubei/v1/next")).toBe(false);
    expect(isPlayerEndpoint("/api/stats/watchtime")).toBe(false);
    expect(isPlayerEndpoint("invalid-url-string")).toBe(false);
  });

  it("extracts URL from string, URL instance, and Request object", () => {
    expect(extractUrlFromFetchInput("https://www.youtube.com/test")).toBe("https://www.youtube.com/test");
    expect(extractUrlFromFetchInput(new URL("https://www.youtube.com/test"))).toBe("https://www.youtube.com/test");
    expect(extractUrlFromFetchInput(new Request("https://www.youtube.com/test"))).toBe("https://www.youtube.com/test");
  });

  it("leaves unrelated YouTube requests untouched", async () => {
    const unrelatedData = { contents: { results: [1, 2, 3] } };
    const originalResponse = new Response(JSON.stringify(unrelatedData), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    fakeWindow.fetch = vi.fn().mockResolvedValue(originalResponse);

    const teardown = installFetchInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const res = await fakeWindow.fetch("https://www.youtube.com/youtubei/v1/browse");
    const json = await res.json();

    expect(json).toEqual(unrelatedData);
    expect(res).toBe(originalResponse); // Untouched reference
    expect(emittedEvents.length).toBe(0);

    teardown();
  });

  it("preserves an ad-bound player response when no verified alternate is available", async () => {
    const adData = JSON.parse(JSON.stringify(adFixture));
    const originalResponse = new Response(JSON.stringify(adData), {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "TestValue"
      }
    });

    fakeWindow.fetch = vi.fn().mockResolvedValue(originalResponse);

    const teardown = installFetchInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const res = await fakeWindow.fetch("https://www.youtube.com/youtubei/v1/player");
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("x-custom-header")).toBe("TestValue");

    const json = await res.json();
    expect(json.adPlacements).toBeDefined();
    expect(json.playerAds).toBeDefined();
    expect(json.videoDetails).toBeDefined();

    expect(emittedEvents).toEqual([
      { type: "PLAYER_RESPONSE_SEEN" },
      {
        type: "PREROLL_DETECTED",
        videoId: adData.videoDetails.videoId,
        source: "fetch"
      }
    ]);

    teardown();
  });

  it("leaves clean player response untouched", async () => {
    const originalResponse = new Response(JSON.stringify(cleanFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    fakeWindow.fetch = vi.fn().mockResolvedValue(originalResponse);

    const teardown = installFetchInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const res = await fakeWindow.fetch("/youtubei/v1/player");
    const json = await res.json();

    expect(json).toEqual(cleanFixture);
    expect(res).toBe(originalResponse); // Untouched because no ad fields changed
    expect(emittedEvents).toEqual([
      { type: "PLAYER_RESPONSE_SEEN" },
      {
        type: "PREROLL_CLEARED",
        videoId: cleanFixture.videoDetails.videoId,
        reason: "clean_response"
      }
    ]);

    teardown();
  });

  it("preserves failed fetch responses (e.g. 404/500)", async () => {
    const errResponse = new Response("Not Found", { status: 404, statusText: "Not Found" });
    fakeWindow.fetch = vi.fn().mockResolvedValue(errResponse);

    const teardown = installFetchInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const res = await fakeWindow.fetch("/youtubei/v1/player");
    expect(res.status).toBe(404);
    expect(res).toBe(errResponse);

    teardown();
  });

  it("preserves fetch network rejection errors", async () => {
    const networkError = new Error("Failed to fetch");
    fakeWindow.fetch = vi.fn().mockRejectedValue(networkError);

    const teardown = installFetchInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    await expect(fakeWindow.fetch("/youtubei/v1/player")).rejects.toThrow("Failed to fetch");

    teardown();
  });

  it("handles malformed JSON gracefully by failing open and reporting sanitizer error", async () => {
    const malformedResponse = new Response("{ this is not valid json", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    fakeWindow.fetch = vi.fn().mockResolvedValue(malformedResponse);

    const teardown = installFetchInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const res = await fakeWindow.fetch("/youtubei/v1/player");
    expect(res).toBe(malformedResponse);
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "ERROR",
        subsystem: "SANITIZER"
      })
    );

    teardown();
  });

  it("supports Request object with AbortSignal without breakage", async () => {
    const controller = new AbortController();
    const request = new Request("https://www.youtube.com/youtubei/v1/player", {
      signal: controller.signal
    });

    fakeWindow.fetch = vi.fn().mockImplementation((req: Request) => {
      if (req.signal.aborted) {
        return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
      }
      return Promise.resolve(new Response(JSON.stringify(cleanFixture)));
    });

    const teardown = installFetchInterceptor(fakeWindow);

    controller.abort();
    await expect(fakeWindow.fetch(request)).rejects.toThrow();

    teardown();
  });

  it("is idempotent and does not double-wrap fetch", () => {
    const original = fakeWindow.fetch;
    const teardown1 = installFetchInterceptor(fakeWindow);
    const patchedOnce = fakeWindow.fetch;

    const teardown2 = installFetchInterceptor(fakeWindow);
    expect(fakeWindow.fetch).toBe(patchedOnce); // Unchanged

    teardown1();
    teardown2();
    expect(fakeWindow.fetch).toBe(original);
  });

  it("maintains Response WebIDL property accessors and clone behavior", async () => {
    const original = new Response(JSON.stringify(adFixture), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" }
    });
    const sanitizedResp = createSanitizedResponse(original, { clean: true });

    // Verify getters on proxy work seamlessly without Illegal invocation
    expect(sanitizedResp.status).toBe(200);
    expect(sanitizedResp.statusText).toBe("OK");
    expect(typeof sanitizedResp.headers.get).toBe("function");
    expect(sanitizedResp.headers.get("content-type")).toContain("application/json");
    expect(sanitizedResp.body).toBeDefined();

    // Verify clone before consumption works
    const clone1 = sanitizedResp.clone();
    expect(await clone1.json()).toEqual({ clean: true });

    // Consuming main body
    expect(await sanitizedResp.json()).toEqual({ clean: true });
    expect(sanitizedResp.bodyUsed).toBe(true);

    // Cloning after body used must throw TypeError
    expect(() => sanitizedResp.clone()).toThrow();
  });
});
