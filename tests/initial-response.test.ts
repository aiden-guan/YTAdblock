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

  it("sanitizes ytInitialPlayerResponse on subsequent assignment", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow, (ev) => emittedEvents.push(ev));

    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));

    const result = fakeWindow.ytInitialPlayerResponse;
    expect(result.adPlacements).toBeUndefined();
    expect(result.playerAds).toBeUndefined();
    expect(result.videoDetails).toBeDefined();

    expect(emittedEvents).toEqual([
      { type: "PLAYER_RESPONSE_SEEN" },
      {
        type: "PLAYER_RESPONSE_SANITIZED",
        removed: expect.arrayContaining(["adPlacements", "playerAds"])
      }
    ]);

    teardown();
  });

  it("preserves clean response on assignment without unnecessary modification", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow, (ev) => emittedEvents.push(ev));

    fakeWindow.ytInitialPlayerResponse = cleanFixture;
    expect(fakeWindow.ytInitialPlayerResponse).toBe(cleanFixture);

    expect(emittedEvents).toEqual([{ type: "PLAYER_RESPONSE_SEEN" }]);

    teardown();
  });

  it("sanitizes ytInitialPlayerResponse if it was pre-existing before install", () => {
    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));

    const teardown = installInitialPlayerResponseHook(fakeWindow, (ev) => emittedEvents.push(ev));

    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeUndefined();
    expect(fakeWindow.ytInitialPlayerResponse.playerAds).toBeUndefined();

    teardown();
  });

  it("preserves get/set semantics across multiple reassignments", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow);

    fakeWindow.ytInitialPlayerResponse = { videoDetails: { id: "1" } };
    expect(fakeWindow.ytInitialPlayerResponse.videoDetails.id).toBe("1");

    fakeWindow.ytInitialPlayerResponse = { videoDetails: { id: "2" }, adPlacements: [1] };
    expect(fakeWindow.ytInitialPlayerResponse.videoDetails.id).toBe("2");
    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeUndefined();

    teardown();
  });

  it("is idempotent when called multiple times", () => {
    const teardown1 = installInitialPlayerResponseHook(fakeWindow);
    const teardown2 = installInitialPlayerResponseHook(fakeWindow);

    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));
    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeUndefined();

    teardown1();
    teardown2();
  });
});
