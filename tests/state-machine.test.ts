import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybackStateMachine } from "../src/content/state-machine";
import type { BlockerEvent, PlayerState } from "../src/types/events";

describe("PlaybackStateMachine", () => {
  let playerEl: HTMLElement;
  let videoEl: HTMLVideoElement;
  let emittedEvents: BlockerEvent[];
  let stateTransitions: { from: PlayerState; to: PlayerState }[];

  beforeEach(() => {
    vi.useFakeTimers();
    emittedEvents = [];
    stateTransitions = [];

    playerEl = document.createElement("div");
    playerEl.id = "movie_player";

    videoEl = document.createElement("video");
    Object.defineProperty(videoEl, "duration", { value: 60, writable: true });
    videoEl.currentTime = 10;
    videoEl.volume = 0.37;
    videoEl.muted = false;
    videoEl.playbackRate = 1.5;

    playerEl.appendChild(videoEl);
    document.body.appendChild(playerEl);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("starts in CONTENT state and stays there when no ad signals exist", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    expect(sm.getState()).toBe("CONTENT");
    sm.update();
    expect(sm.getState()).toBe("CONTENT");
    expect(emittedEvents.length).toBe(0);
  });

  it("transitions to POSSIBLE_AD on a single weak signal without altering playback", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    // Add single weak signal: ad container with no ad-showing class
    const overlay = document.createElement("div");
    overlay.className = "ytp-ad-overlay-container";
    // Mock visible
    Object.defineProperty(overlay, "offsetWidth", { value: 100 });
    Object.defineProperty(overlay, "offsetHeight", { value: 50 });
    playerEl.appendChild(overlay);

    sm.update();

    expect(sm.getState()).toBe("POSSIBLE_AD");
    // Playback must NOT be muted, accelerated, or seeked
    expect(videoEl.muted).toBe(false);
    expect(videoEl.playbackRate).toBe(1.5);
    expect(videoEl.currentTime).toBe(10);
  });

  it("transitions to CONFIRMED_AD on strong signals and executes progressive fallback", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    // Player has ad-showing class
    playerEl.classList.add("ad-showing");

    // Add skip button
    const skipBtn = document.createElement("button");
    skipBtn.className = "ytp-ad-skip-button";
    Object.defineProperty(skipBtn, "offsetWidth", { value: 80 });
    Object.defineProperty(skipBtn, "offsetHeight", { value: 30 });
    const clickSpy = vi.fn();
    skipBtn.onclick = clickSpy;
    playerEl.appendChild(skipBtn);

    sm.update();

    expect(sm.getState()).toBe("CONFIRMED_AD");
    expect(clickSpy).toHaveBeenCalled();
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AD_CONFIRMED" }),
        expect.objectContaining({ type: "SKIP_CLICKED" })
      ])
    );
  });

  it("mutes, accelerates, and seeks near end when no skip button is present", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    // Strong confirmation: ad-showing + ad text
    playerEl.classList.add("ad-showing");
    const adText = document.createElement("div");
    adText.className = "ytp-ad-text";
    adText.textContent = "Ad 1 of 2 (0:15)";
    Object.defineProperty(adText, "offsetWidth", { value: 100 });
    Object.defineProperty(adText, "offsetHeight", { value: 20 });
    playerEl.appendChild(adText);

    sm.update();

    expect(sm.getState()).toBe("CONFIRMED_AD");
    expect(videoEl.muted).toBe(true);
    expect(videoEl.playbackRate).toBe(16);
    // Confirmed ads are driven to the exact media end.
    expect(videoEl.currentTime).toBeCloseTo(60, 2);
  });

  it("falls back to media completion when a synthetic skip click is ignored", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    playerEl.classList.add("ad-showing");

    const skipBtn = document.createElement("button");
    skipBtn.className = "ytp-ad-skip-button-modern";
    Object.defineProperty(skipBtn, "offsetWidth", { value: 80 });
    Object.defineProperty(skipBtn, "offsetHeight", { value: 30 });

    // The DOM click fires, but the player remains in ad-showing — matching
    // YouTube rejecting/ignoring a synthetic skip action.
    const clickSpy = vi.fn();
    skipBtn.onclick = clickSpy;
    playerEl.appendChild(skipBtn);

    sm.update();

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(videoEl.currentTime).toBe(10);

    vi.advanceTimersByTime(80);

    expect(videoEl.currentTime).toBeCloseTo(60, 2);
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "SKIP_CLICKED" }),
        expect.objectContaining({ type: "AD_SEEKED" })
      ])
    );
  });

  it("recognizes the modern end-card without relying on ad-showing class", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    const skipSlot = document.createElement("div");
    skipSlot.className = "ytp-ad-skip-button-slot";
    Object.defineProperty(skipSlot, "offsetWidth", { value: 100 });
    Object.defineProperty(skipSlot, "offsetHeight", { value: 40 });

    const skipBtn = document.createElement("button");
    skipBtn.setAttribute("aria-label", "Skip ad");
    Object.defineProperty(skipBtn, "offsetWidth", { value: 80 });
    Object.defineProperty(skipBtn, "offsetHeight", { value: 30 });
    skipSlot.appendChild(skipBtn);

    const advertiser = document.createElement("div");
    advertiser.className = "ytp-visit-advertiser-link";
    Object.defineProperty(advertiser, "offsetWidth", { value: 120 });
    Object.defineProperty(advertiser, "offsetHeight", { value: 30 });

    playerEl.appendChild(skipSlot);
    playerEl.appendChild(advertiser);

    sm.update();

    expect(sm.getState()).toBe("CONFIRMED_AD");
    expect(playerEl.getAttribute("ytclean-ad-active")).toBe("true");
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AD_CONFIRMED" })
      ])
    );
  });

  it("completely restores exact user volume, speed, and muted state on recovery", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev),
      (from, to) => stateTransitions.push({ from, to })
    );

    // User initially had custom configuration
    videoEl.volume = 0.42;
    videoEl.muted = false;
    videoEl.playbackRate = 1.25;

    // Trigger ad state
    playerEl.classList.add("ad-showing");
    const adText = document.createElement("div");
    adText.className = "ytp-ad-text";
    adText.textContent = "Ad";
    Object.defineProperty(adText, "offsetWidth", { value: 50 });
    Object.defineProperty(adText, "offsetHeight", { value: 20 });
    playerEl.appendChild(adText);

    sm.update();
    expect(sm.getState()).toBe("CONFIRMED_AD");
    expect(videoEl.muted).toBe(true);
    expect(videoEl.playbackRate).toBe(16);

    // Simulate ad finishing: remove ad-showing and ad text
    playerEl.classList.remove("ad-showing");
    playerEl.removeChild(adText);

    sm.update();

    expect(sm.getState()).toBe("CONTENT");
    expect(videoEl.muted).toBe(false);
    expect(videoEl.volume).toBe(0.42);
    expect(videoEl.playbackRate).toBe(1.25);
  });

  it("preserves pre-existing muted state if user was already muted", () => {
    const sm = new PlaybackStateMachine(
      playerEl,
      (ev) => emittedEvents.push(ev)
    );

    videoEl.muted = true;
    videoEl.volume = 0.5;

    playerEl.classList.add("ad-showing");
    const skipBtn = document.createElement("button");
    skipBtn.className = "ytp-ad-skip-button";
    Object.defineProperty(skipBtn, "offsetWidth", { value: 50 });
    Object.defineProperty(skipBtn, "offsetHeight", { value: 20 });
    playerEl.appendChild(skipBtn);

    sm.update();
    expect(sm.getState()).toBe("CONFIRMED_AD");

    // Ad ends
    playerEl.classList.remove("ad-showing");
    playerEl.removeChild(skipBtn);

    sm.update();
    expect(sm.getState()).toBe("CONTENT");
    expect(videoEl.muted).toBe(true); // Must remain muted
  });

  it("handles SPA navigation by resetting state and clearing timers cleanly", () => {
    const sm = new PlaybackStateMachine(playerEl);
    playerEl.classList.add("ad-showing");
    const adText = document.createElement("div");
    adText.className = "ytp-ad-text";
    adText.textContent = "Ad";
    Object.defineProperty(adText, "offsetWidth", { value: 50 });
    Object.defineProperty(adText, "offsetHeight", { value: 20 });
    playerEl.appendChild(adText);

    sm.update();
    expect(sm.getState()).toBe("CONFIRMED_AD");

    sm.resetForNavigation();
    expect(sm.getState()).toBe("CONTENT");
    expect(videoEl.muted).toBe(false);
    expect(videoEl.playbackRate).toBe(1.5);
  });
});
