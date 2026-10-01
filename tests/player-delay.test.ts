import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlayerDelayBypassManager } from "../src/main/delay/player-delay";

describe("PlayerDelayBypassManager", () => {
  let manager: PlayerDelayBypassManager;
  let container: HTMLElement;

  beforeEach(() => {
    manager = new PlayerDelayBypassManager();
    container = document.createElement("div");
  });

  it("does not bypass when player is in normal content state", () => {
    container.className = "html5-video-player";
    const assessment = manager.assessPlayerState(container, true);
    expect(assessment.isStuckInAdState).toBe(false);

    const result = manager.bypassDelay(container, assessment);
    expect(result.bypassed).toBe(false);
  });

  it("identifies stuck player when ad-showing class is present with clean media", () => {
    container.className = "html5-video-player ad-showing";
    const video = document.createElement("video");
    video.src = "https://rr1---sn-xxx.googlevideo.com/videoplayback?id=content";
    Object.defineProperty(video, "duration", { value: 300 });
    container.appendChild(video);

    const assessment = manager.assessPlayerState(container, true);
    expect(assessment.isStuckInAdState).toBe(true);
    expect(assessment.hasAdShowingClass).toBe(true);
  });

  it("bypasses delay via skip button click if present", () => {
    container.className = "html5-video-player ad-showing";
    const skipBtn = document.createElement("button");
    skipBtn.className = "ytp-ad-skip-button-modern";
    const clickSpy = vi.spyOn(skipBtn, "click");
    container.appendChild(skipBtn);

    const assessment = manager.assessPlayerState(container, true);
    const result = manager.bypassDelay(container, assessment);

    expect(result.bypassed).toBe(true);
    expect(result.signalChanged).toBe("CLICKED_STUCK_AD_SKIP_BUTTON");
    expect(clickSpy).toHaveBeenCalled();
  });

  it("bypasses delay via DOM class reset if no skip button exists", () => {
    container.className = "html5-video-player ad-showing ad-interrupting";
    const video = document.createElement("video");
    const playSpy = vi.spyOn(video, "play").mockImplementation(() => Promise.resolve());
    Object.defineProperty(video, "paused", { value: true });
    container.appendChild(video);

    const assessment = manager.assessPlayerState(container, true);
    const result = manager.bypassDelay(container, assessment);

    expect(result.bypassed).toBe(true);
    expect(result.signalChanged).toBe("REMOVED_STUCK_AD_SHOWING_CLASS");
    expect(container.classList.contains("ad-showing")).toBe(false);
    expect(container.classList.contains("ad-interrupting")).toBe(false);
    expect(playSpy).toHaveBeenCalled();
  });
});
