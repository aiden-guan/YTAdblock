import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installXhrInterceptor } from "../src/main/xhr-interceptor";
import adFixture from "./fixtures/player-with-ads.json";
import cleanFixture from "./fixtures/player-clean.json";
import type { BlockerEvent } from "../src/types/events";

describe("xhr-interceptor", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    emittedEvents = [];

    // Mock XMLHttpRequest prototype
    class MockXHR {
      public readyState = 0;
      public status = 200;
      public responseType = "";
      public _rawResponseText = "";
      public _rawResponse: any = "";
      public onreadystatechange: (() => void) | null = null;
      public onload: (() => void) | null = null;

      public open(method: string, url: string) {
        // Will be wrapped
      }

      public send(body?: any) {
        // Will be wrapped
      }
    }

    Object.defineProperty(MockXHR.prototype, "responseText", {
      configurable: true,
      get() {
        return this._rawResponseText;
      }
    });

    Object.defineProperty(MockXHR.prototype, "response", {
      configurable: true,
      get() {
        return this._rawResponse;
      }
    });

    fakeWindow = {
      XMLHttpRequest: MockXHR
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves non-player XHR requests untouched", () => {
    const teardown = installXhrInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const xhr = new fakeWindow.XMLHttpRequest();
    xhr.open("GET", "/api/stats/watchtime");
    xhr._rawResponseText = '{"status":"ok"}';
    xhr.readyState = 4;
    xhr.status = 200;

    expect(xhr.responseText).toBe('{"status":"ok"}');
    expect(emittedEvents.length).toBe(0);

    teardown();
  });

  it("sanitizes player response when onreadystatechange was assigned before send", () => {
    const teardown = installXhrInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const xhr = new fakeWindow.XMLHttpRequest();
    xhr.open("POST", "https://www.youtube.com/youtubei/v1/player");

    let receivedText = "";
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        receivedText = xhr.responseText;
      }
    };

    xhr._rawResponseText = JSON.stringify(adFixture);
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.send();

    // Trigger onreadystatechange handler as standard browser XHR would
    xhr.onreadystatechange();

    expect(receivedText).not.toBe("");
    const parsed = JSON.parse(receivedText);
    expect(parsed.adPlacements).toBeUndefined();
    expect(parsed.playerAds).toBeUndefined();
    expect(parsed.videoDetails).toBeDefined();

    expect(emittedEvents).toEqual([
      { type: "PLAYER_RESPONSE_SEEN" },
      {
        type: "PLAYER_RESPONSE_SANITIZED",
        removed: expect.arrayContaining(["adPlacements", "playerAds"])
      }
    ]);

    teardown();
  });

  it("returns parsed JSON object when responseType is json", () => {
    const teardown = installXhrInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const xhr = new fakeWindow.XMLHttpRequest();
    xhr.open("POST", "/youtubei/v1/player");
    xhr.responseType = "json";
    xhr._rawResponseText = JSON.stringify(adFixture);
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.send();

    const result = xhr.response;
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result.adPlacements).toBeUndefined();
    expect(result.streamingData).toBeDefined();

    teardown();
  });

  it("fails open and emits ERROR event on malformed JSON in XHR", () => {
    const teardown = installXhrInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const xhr = new fakeWindow.XMLHttpRequest();
    xhr.open("POST", "/youtubei/v1/player");
    xhr._rawResponseText = "{ this is invalid json";
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.send();

    expect(xhr.responseText).toBe("{ this is invalid json");
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "ERROR",
        subsystem: "XHR_SANITIZER"
      })
    );

    teardown();
  });

  it("is idempotent", () => {
    const originalOpen = fakeWindow.XMLHttpRequest.prototype.open;
    const teardown1 = installXhrInterceptor(fakeWindow);
    const patchedOpen = fakeWindow.XMLHttpRequest.prototype.open;

    const teardown2 = installXhrInterceptor(fakeWindow);
    expect(fakeWindow.XMLHttpRequest.prototype.open).toBe(patchedOpen);

    teardown1();
    teardown2();
    expect(fakeWindow.XMLHttpRequest.prototype.open).toBe(originalOpen);
  });
});
