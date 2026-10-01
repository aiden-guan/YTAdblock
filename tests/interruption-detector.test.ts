import { describe, it, expect, vi, beforeEach } from "vitest";
import { AntiAdblockInterruptionDetector } from "../src/content/interruption-detector";
import type { BlockerEvent } from "../src/types/events";

describe("AntiAdblockInterruptionDetector", () => {
  let container: HTMLElement;
  let videoEl: HTMLVideoElement;
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    container = document.createElement("div");
    videoEl = document.createElement("video");
    vi.spyOn(videoEl, "play").mockImplementation(() => Promise.resolve());
    Object.defineProperty(videoEl, "paused", { value: true, writable: true });
    container.appendChild(videoEl);
    emittedEvents = [];
  });

  it("detects and dismisses anti-adblock enforcement dialogs", () => {
    const dialog = document.createElement("ytd-enforcement-message-view-model");
    dialog.textContent = "Ad blockers violate YouTube's Terms of Service";
    const dismissBtn = document.createElement("button");
    dismissBtn.id = "dismiss-button";
    const clickSpy = vi.fn();
    dismissBtn.onclick = clickSpy;
    dialog.appendChild(dismissBtn);
    container.appendChild(dialog);

    const detector = new AntiAdblockInterruptionDetector(container, (ev) =>
      emittedEvents.push(ev)
    );

    const status = detector.detectInterruption();
    expect(status.isInterrupted).toBe(true);
    expect(status.dismissButton).toBe(dismissBtn);

    const recovered = detector.attemptRecovery();
    expect(recovered).toBe(true);
    expect(clickSpy).toHaveBeenCalled();
    expect(videoEl.play).toHaveBeenCalled();

    expect(emittedEvents).toEqual([
      {
        type: "ANTI_ADBLOCK_DETECTED",
        detail: expect.stringContaining("enforcement dialog")
      },
      { type: "ANTI_ADBLOCK_DISMISSED" }
    ]);
  });

  it("ignores legitimate age restriction dialogs", () => {
    const dialog = document.createElement("div");
    dialog.className = "yt-playability-error-supported-renderers";
    dialog.textContent = "Sign in to confirm your age. This video is age-restricted.";
    container.appendChild(dialog);

    const detector = new AntiAdblockInterruptionDetector(container, (ev) =>
      emittedEvents.push(ev)
    );

    const status = detector.detectInterruption();
    expect(status.isInterrupted).toBe(false);

    const recovered = detector.attemptRecovery();
    expect(recovered).toBe(false);
    expect(videoEl.play).not.toHaveBeenCalled();
  });

  it("ignores purchase and membership dialogs", () => {
    const dialog = document.createElement("ytd-enforcement-message-view-model");
    dialog.textContent = "Complete your purchase to join this channel membership.";
    container.appendChild(dialog);

    const detector = new AntiAdblockInterruptionDetector(container, (ev) =>
      emittedEvents.push(ev)
    );

    const status = detector.detectInterruption();
    expect(status.isInterrupted).toBe(false);
  });

  it("throttles recovery attempts to prevent infinite loops", () => {
    const detector = new AntiAdblockInterruptionDetector(container, (ev) =>
      emittedEvents.push(ev)
    );

    // Trigger 3 dialogs
    for (let i = 0; i < 3; i++) {
      const dialog = document.createElement("ytd-enforcement-message-view-model");
      dialog.textContent = "Ad blockers are not allowed on YouTube";
      container.appendChild(dialog);
      const res = detector.attemptRecovery();
      expect(res).toBe(true);
    }

    // 4th dialog in the same minute should be rejected
    const dialog4 = document.createElement("ytd-enforcement-message-view-model");
    dialog4.textContent = "Ad blockers are not allowed on YouTube";
    container.appendChild(dialog4);

    const res4 = detector.attemptRecovery();
    expect(res4).toBe(false);
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "ERROR",
        subsystem: "INTERRUPTION_DETECTOR"
      })
    );
  });
});
