import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installXhrInterceptor } from "../src/main/xhr-interceptor";
import adFixture from "./fixtures/player-with-ads.json";
import type { BlockerEvent } from "../src/types/events";

describe("xhr-interceptor", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    emittedEvents = [];

    class MockXHR {
      public readyState = 0;
      public status = 200;
      public responseType = "";
      public _rawResponseText = "";
      public _rawResponse: any = "";
      public onreadystatechange: (() => void) | null = null;
      public onload: (() => void) | null = null;

      public open(_method: string, _url: string) {}
      public send(_body?: any) {}
      public addEventListener(_name: string, _handler: EventListenerOrEventListenerObject, _opts?: any) {}
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

    fakeWindow = { XMLHttpRequest: MockXHR };
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

  it("preserves preroll player response instead of stripping it without a replacement stream", () => {
    const teardown = installXhrInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const xhr = new fakeWindow.XMLHttpRequest();
    xhr.open("POST", "https://www.youtube.com/youtubei/v1/player");
    xhr._rawResponseText = JSON.stringify(adFixture);
    xhr._rawResponse = JSON.stringify(adFixture);
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.send();

    const parsed = JSON.parse(xhr.responseText);
    expect(parsed.adPlacements).toBeDefined();
    expect(parsed.playerAds).toBeDefined();
    expect(parsed.videoDetails).toBeDefined();
    expect(emittedEvents).toEqual([{ type: "PLAYER_RESPONSE_SEEN" }]);

    teardown();
  });

  it("preserves preroll JSON responseType objects", () => {
    const teardown = installXhrInterceptor(fakeWindow, (ev) => emittedEvents.push(ev));

    const xhr = new fakeWindow.XMLHttpRequest();
    xhr.open("POST", "/youtubei/v1/player");
    xhr.responseType = "json";
    xhr._rawResponseText = JSON.stringify(adFixture);
    xhr._rawResponse = JSON.parse(JSON.stringify(adFixture));
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.send();

    const result = xhr.response;
    expect(result).toBeDefined();
    expect(result.adPlacements).toBeDefined();
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
