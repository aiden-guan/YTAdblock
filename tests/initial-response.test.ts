import { describe, it, expect, vi, beforeEach } from "vitest";
import { installInitialPlayerResponseHook } from "../src/main/initial-response";
import cleanFixture from "./fixtures/player-clean.json";
import adFixture from "./fixtures/player-with-ads.json";
import type { BlockerEvent } from "../src/types/events";

describe("initial-response", () => {
  let fakeWindow: any;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    fakeWindow = {};
    emittedEvents = [];
  });

  it("observes but preserves ad-bound ytInitialPlayerResponse on subsequent assignment", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow, (ev) => emittedEvents.push(ev));

    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));

    const result = fakeWindow.ytInitialPlayerResponse;
    expect(result.adPlacements).toBeDefined();
    expect(result.playerAds).toBeDefined();
    expect(result.videoDetails).toBeDefined();

    expect(emittedEvents).toEqual([
      { type: "PLAYER_RESPONSE_SEEN" },
      {
        type: "PREROLL_DETECTED",
        videoId: adFixture.videoDetails.videoId,
        source: "initial"
      }
    ]);

    teardown();
  });

  it("preserves clean response on assignment without unnecessary modification", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow, (ev) => emittedEvents.push(ev));

    fakeWindow.ytInitialPlayerResponse = cleanFixture;
    expect(fakeWindow.ytInitialPlayerResponse).toBe(cleanFixture);

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

  it("preserves a pre-existing ad-bound ytInitialPlayerResponse", () => {
    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));

    const teardown = installInitialPlayerResponseHook(fakeWindow, (ev) => emittedEvents.push(ev));

    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeDefined();
    expect(fakeWindow.ytInitialPlayerResponse.playerAds).toBeDefined();

    teardown();
  });

  it("preserves get/set semantics across multiple reassignments", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow);

    fakeWindow.ytInitialPlayerResponse = { videoDetails: { id: "1" } };
    expect(fakeWindow.ytInitialPlayerResponse.videoDetails.id).toBe("1");

    fakeWindow.ytInitialPlayerResponse = { videoDetails: { id: "2" }, adPlacements: [1] };
    expect(fakeWindow.ytInitialPlayerResponse.videoDetails.id).toBe("2");
    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeDefined();

    teardown();
  });

  it("is idempotent when called multiple times", () => {
    const teardown1 = installInitialPlayerResponseHook(fakeWindow);
    const teardown2 = installInitialPlayerResponseHook(fakeWindow);

    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));
    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeDefined();

    teardown1();
    teardown2();
  });
});
