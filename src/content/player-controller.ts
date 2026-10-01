import type { UserPlaybackState, BlockerEvent } from "../types/events";
import type { AdDetectionResult } from "./ad-detector";

export type ControllerEventCallback = (event: BlockerEvent) => void;

/**
 * Executes progressive fallback strategies on confirmed ads and restores
 * genuine user playback configuration.
 */
export class PlayerController {
  private savedUserState: UserPlaybackState | null = null;

  constructor(
    private readonly playerElement: HTMLElement,
    private readonly onEvent?: ControllerEventCallback
  ) {}

  public getVideoElement(): HTMLVideoElement | null {
    return this.playerElement.querySelector<HTMLVideoElement>("video");
  }

  /**
   * Captures the user's intended playback settings before any ad manipulation.
   */
  public snapshotUserState(): void {
    if (this.savedUserState !== null) {
      // Retain the original state prior to entering the ad cycle
      return;
    }

    const video = this.getVideoElement();
    if (!video) return;

    const rate = video.playbackRate > 4 || video.playbackRate <= 0 ? 1 : video.playbackRate;
    this.savedUserState = {
      muted: video.muted,
      volume: video.volume,
      playbackRate: rate
    };
  }

  /**
   * Strategy 1: Find and trigger legitimate skip button.
   */
  public tryClickSkipButton(detection: AdDetectionResult): boolean {
    const btn = detection.skipButtonElement;
    if (btn) {
      if (btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true") {
        return false;
      }
      try {
        btn.click();
        this.onEvent?.({ type: "SKIP_CLICKED" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Strategy 2: Accelerate and mute ad video.
   */
  public applyAccelerationAndMute(): void {
    const video = this.getVideoElement();
    if (!video) return;

    try {
      video.muted = true;
      // Chrome supports up to 16x playbackRate
      video.playbackRate = 16;
      this.onEvent?.({ type: "AD_ACCELERATED" });
    } catch {
      try {
        video.playbackRate = 8;
        this.onEvent?.({ type: "AD_ACCELERATED" });
      } catch {
        // Ignore playback rate failure
      }
    }
  }

  /**
   * Strategy 3: Fast-forward / seek near end of ad if safe.
   */
  public trySeekToEndOfAd(detection: AdDetectionResult): boolean {
    // High confidence guard: MUST have ad-showing class and be confirmed
    if (!detection.isConfirmedAd || !detection.hasAdShowingClass) {
      return false;
    }

    const video = this.getVideoElement();
    if (!video) return false;

    if (
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      !isNaN(video.currentTime)
    ) {
      try {
        const target = Math.max(0, video.duration - 0.05);
        video.currentTime = target;
        this.onEvent?.({ type: "AD_SEEKED" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Strategy 4: Restores original user audio and speed settings.
   */
  public restoreUserState(): void {
    if (!this.savedUserState) return;

    const video = this.getVideoElement();
    if (video) {
      try {
        video.muted = this.savedUserState.muted;
        video.volume = this.savedUserState.volume;
        video.playbackRate = this.savedUserState.playbackRate;
      } catch {
        // Ignore restoration error
      }
    }

    this.savedUserState = null;
    this.onEvent?.({ type: "CONTENT_RESUMED" });
  }

  public getSavedUserState(): UserPlaybackState | null {
    return this.savedUserState ? { ...this.savedUserState } : null;
  }
}
