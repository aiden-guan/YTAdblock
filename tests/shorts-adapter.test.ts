import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShortsAdapter } from "../src/content/adapters/shorts";
import type { BlockerEvent } from "../src/types/events";

describe("ShortsAdapter", () => {
  let container: HTMLElement;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    emittedEvents = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves normal organic shorts untouched", () => {
    const reel = document.createElement("ytd-reel-video-renderer");
    reel.setAttribute("is-active", "");
    const video = document.createElement("video");
    video.currentTime = 2;
    video.muted = false;
    reel.appendChild(video);
    container.appendChild(reel);

    const adapter = new ShortsAdapter(container, (ev) => emittedEvents.push(ev));
    adapter.mount();

    expect(video.muted).toBe(false);
    expect(video.currentTime).toBe(2);
    expect(emittedEvents.length).toBe(0);

    adapter.unmount();
  });

  it("detects sponsored shorts ad reel and clicks next button", () => {
    const reel = document.createElement("ytd-reel-video-renderer");
    reel.setAttribute("is-active", "");
    const adSlot = document.createElement("ytd-ad-slot-renderer");
    reel.appendChild(adSlot);

    const navContainer = document.createElement("div");
    navContainer.id = "navigation-button-down";
    const nextBtn = document.createElement("button");
    const clickSpy = vi.fn();
    nextBtn.onclick = clickSpy;
    navContainer.appendChild(nextBtn);
    container.appendChild(navContainer);
    container.appendChild(reel);

    const adapter = new ShortsAdapter(container, (ev) => emittedEvents.push(ev));
    adapter.mount();

    expect(clickSpy).toHaveBeenCalled();
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AD_CONFIRMED" }),
        expect.objectContaining({ type: "SKIP_CLICKED" })
      ])
    );

    adapter.unmount();
  });

  it("mutes and seeks video when next button is not available", () => {
    const reel = document.createElement("ytd-reel-video-renderer");
    reel.setAttribute("is-active", "");
    reel.classList.add("ad-showing");

    const video = document.createElement("video");
    Object.defineProperty(video, "duration", { value: 15, writable: true });
    video.currentTime = 0;
    video.muted = false;
    reel.appendChild(video);
    container.appendChild(reel);

    const adapter = new ShortsAdapter(container, (ev) => emittedEvents.push(ev));
    adapter.mount();

    expect(video.muted).toBe(true);
    expect(video.currentTime).toBe(15);
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "AD_CONFIRMED" }),
        expect.objectContaining({ type: "AD_SEEKED" })
      ])
    );

    adapter.unmount();
  });

  it("restores user volume, speed, and muted state when moving from ad short to organic short", () => {
    // 1. Initial ad reel
    const adReel = document.createElement("ytd-reel-video-renderer");
    adReel.setAttribute("is-active", "");
    adReel.classList.add("ad-showing");

    const adVideo = document.createElement("video");
    Object.defineProperty(adVideo, "duration", { value: 15, writable: true });
    adVideo.currentTime = 0;
    adVideo.muted = false;
    adVideo.volume = 0.65;
    adVideo.playbackRate = 1.25;
    adReel.appendChild(adVideo);
    container.appendChild(adReel);

    const adapter = new ShortsAdapter(container, (ev) => emittedEvents.push(ev));
    adapter.mount();

    // Ad video should be muted and accelerated
    expect(adVideo.muted).toBe(true);

    // 2. User swipes to next organic short
    adReel.removeAttribute("is-active");
    adReel.classList.remove("ad-showing");

    const nextReel = document.createElement("ytd-reel-video-renderer");
    nextReel.setAttribute("is-active", "");
    const nextVideo = document.createElement("video");
    nextVideo.muted = true; // Player default
    nextReel.appendChild(nextVideo);
    container.appendChild(nextReel);

    adapter.update();

    // Must restore user volume, playbackRate, and unmuted status on organic short
    expect(nextVideo.muted).toBe(false);
    expect(nextVideo.volume).toBe(0.65);
    expect(nextVideo.playbackRate).toBe(1.25);
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({ type: "CONTENT_RESUMED" })
    );

    adapter.unmount();
  });
});
