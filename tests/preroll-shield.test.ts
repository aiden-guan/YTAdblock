import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PrerollShieldController,
  isPlayerCurrentlyAdvertising
} from "../src/main/preroll-shield";

describe("PrerollShieldController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.removeAttribute("ytclean-preroll-pending");
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute("ytclean-preroll-pending");
    document.body.innerHTML = "";
  });

  it("pre-arms a watch navigation immediately", () => {
    const shield = new PrerollShieldController(document);
    shield.preArmNavigation();

    expect(shield.isActive()).toBe(true);
    expect(document.documentElement.getAttribute("ytclean-preroll-pending")).toBe("true");
  });

  it("latches a confirmed preroll and ignores clean-response clearing", () => {
    const shield = new PrerollShieldController(document);

    shield.handleEvent({
      type: "PREROLL_DETECTED",
      videoId: "video-a",
      source: "fetch"
    });

    shield.handleEvent({
      type: "PREROLL_CLEARED",
      videoId: "video-a",
      reason: "clean_response"
    });

    expect(shield.isActive()).toBe(true);
    expect(shield.hasConfirmedPreroll()).toBe(true);
    expect(document.documentElement.getAttribute("ytclean-preroll-pending")).toBe("true");
  });

  it("does not reveal a confirmed preroll merely because a video element is playing", () => {
    const shield = new PrerollShieldController(document);

    shield.handleEvent({
      type: "PREROLL_DETECTED",
      videoId: "video-a",
      source: "initial"
    });

    shield.clearForContentPlayback();

    expect(shield.isActive()).toBe(true);
    expect(document.documentElement.getAttribute("ytclean-preroll-pending")).toBe("true");
  });

  it("allows a clean pre-armed navigation to reveal on actual content playback", () => {
    const shield = new PrerollShieldController(document);
    shield.preArmNavigation();

    shield.clearForContentPlayback();

    expect(shield.isActive()).toBe(false);
    expect(document.documentElement.hasAttribute("ytclean-preroll-pending")).toBe(false);
  });

  it("clears a confirmed preroll on verified substitution", () => {
    const shield = new PrerollShieldController(document);

    shield.handleEvent({
      type: "PREROLL_DETECTED",
      videoId: "video-a",
      source: "fetch"
    });

    shield.handleEvent({
      type: "PLAYER_RESPONSE_SUBSTITUTED",
      candidateId: "web-embedded",
      videoId: "video-a"
    });

    expect(shield.isActive()).toBe(false);
  });

  it("ignores a mismatched video clear", () => {
    const shield = new PrerollShieldController(document);

    shield.handleEvent({
      type: "PREROLL_DETECTED",
      videoId: "video-a",
      source: "fetch"
    });

    shield.handleEvent({
      type: "PLAYER_RESPONSE_SUBSTITUTED",
      candidateId: "web-embedded",
      videoId: "video-b"
    });

    expect(shield.isActive()).toBe(true);
  });

  it("fails open after the watchdog", () => {
    const shield = new PrerollShieldController(document);
    shield.handleEvent({
      type: "PREROLL_DETECTED",
      videoId: "video-a",
      source: "fetch"
    });

    vi.advanceTimersByTime(12_000);

    expect(shield.isActive()).toBe(false);
    expect(document.documentElement.hasAttribute("ytclean-preroll-pending")).toBe(false);
  });
});

describe("isPlayerCurrentlyAdvertising", () => {
  it("detects YouTube's explicit ad class", () => {
    const player = document.createElement("div");
    player.className = "ad-showing";

    expect(isPlayerCurrentlyAdvertising(player)).toBe(true);
  });

  it("returns false for a normal player with no ad UI", () => {
    const player = document.createElement("div");
    const video = document.createElement("video");
    player.appendChild(video);

    expect(isPlayerCurrentlyAdvertising(player)).toBe(false);
  });
});
