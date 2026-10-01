import { describe, it, expect, beforeEach } from "vitest";
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

  it("preserves preroll-bound initial response so YouTube can advance the real ad state", () => {
    const teardown = installInitialPlayerResponseHook(
      fakeWindow,
      (ev) => emittedEvents.push(ev)
    );

    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));

    const result = fakeWindow.ytInitialPlayerResponse;
    expect(result.adPlacements).toBeDefined();
    expect(result.playerAds).toBeDefined();
    expect(result.videoDetails).toBeDefined();
    expect(emittedEvents).toEqual([{ type: "PLAYER_RESPONSE_SEEN" }]);

    teardown();
  });

  it("preserves clean response on assignment without unnecessary modification", () => {
    const teardown = installInitialPlayerResponseHook(
      fakeWindow,
      (ev) => emittedEvents.push(ev)
    );

    fakeWindow.ytInitialPlayerResponse = cleanFixture;
    expect(fakeWindow.ytInitialPlayerResponse).toBe(cleanFixture);
    expect(emittedEvents).toEqual([{ type: "PLAYER_RESPONSE_SEEN" }]);

    teardown();
  });

  it("preserves a pre-existing preroll response rather than manufacturing an incomplete player state", () => {
    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));

    const teardown = installInitialPlayerResponseHook(
      fakeWindow,
      (ev) => emittedEvents.push(ev)
    );

    expect(fakeWindow.ytInitialPlayerResponse.adPlacements).toBeDefined();
    expect(fakeWindow.ytInitialPlayerResponse.playerAds).toBeDefined();
    expect(emittedEvents).toEqual([{ type: "PLAYER_RESPONSE_SEEN" }]);

    teardown();
  });

  it("preserves get/set semantics across multiple reassignments", () => {
    const teardown = installInitialPlayerResponseHook(fakeWindow);

    fakeWindow.ytInitialPlayerResponse = { videoDetails: { id: "1" } };
    expect(fakeWindow.ytInitialPlayerResponse.videoDetails.id).toBe("1");

    fakeWindow.ytInitialPlayerResponse = JSON.parse(JSON.stringify(adFixture));
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
