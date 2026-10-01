import type { UserPlaybackState, BlockerEvent } from "../types/events";
import type { AdDetectionResult } from "./ad-detector";

export type ControllerEventCallback = (event: BlockerEvent) => void;

export class PlayerController {
  private savedUserState: UserPlaybackState | null = null;

  constructor(
    private readonly playerElement: HTMLElement,
    private readonly onEvent?: ControllerEventCallback
  ) {}

  public getVideoElement(): HTMLVideoElement | null {
    return this.playerElement.querySelector<HTMLVideoElement>("video");
  }

  public snapshotUserState(): void {
    if (this.savedUserState !== null) return;

    const video = this.getVideoElement();
    if (!video) return;

    const rate =
      video.playbackRate > 4 || video.playbackRate <= 0
        ? 1
        : video.playbackRate;

    this.savedUserState = {
      muted: video.muted,
      volume: video.volume,
      playbackRate: rate
    };

    this.playerElement.setAttribute("ytclean-ad-active", "true");
  }

  public tryClickSkipButton(detection: AdDetectionResult): boolean {
    const btn = detection.skipButtonElement;
    if (!btn) return false;

    if (
      btn.hasAttribute("disabled") ||
      btn.getAttribute("aria-disabled") === "true"
    ) {
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

  public applyAccelerationAndMute(): void {
    const video = this.getVideoElement();
    if (!video) return;

    try {
      video.muted = true;
      video.playbackRate = 16;
      if (video.paused) {
        void video.play().catch(() => {});
      }
      this.onEvent?.({ type: "AD_ACCELERATED" });
    } catch {
      try {
        video.playbackRate = 8;
        this.onEvent?.({ type: "AD_ACCELERATED" });
      } catch {
        // Ignore playback-rate failure.
      }
    }
  }

  public trySeekToEndOfAd(detection: AdDetectionResult): boolean {
    if (!detection.isConfirmedAd || !detection.hasAdShowingClass) {
      return false;
    }

    const video = this.getVideoElement();
    if (!video) return false;

    if (
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      Number.isFinite(video.currentTime)
    ) {
      try {
        video.muted = true;
        const target = Math.max(0, video.duration - 0.01);
        video.currentTime = target;

        if (video.paused) {
          void video.play().catch(() => {});
        }

        this.onEvent?.({ type: "AD_SEEKED" });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  public restoreUserState(): void {
    const saved = this.savedUserState;
    this.playerElement.removeAttribute("ytclean-ad-active");

    if (!saved) return;

    const video = this.getVideoElement();
    if (video) {
      try {
        video.muted = saved.muted;
        video.volume = saved.volume;
        video.playbackRate = saved.playbackRate;
      } catch {
        // Ignore restoration error.
      }
    }

    this.savedUserState = null;
    this.onEvent?.({ type: "CONTENT_RESUMED" });
  }

  public getSavedUserState(): UserPlaybackState | null {
    return this.savedUserState ? { ...this.savedUserState } : null;
  }
}
