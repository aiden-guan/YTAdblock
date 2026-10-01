import type { PageAdapter } from "./base";
import type { BlockerEvent, UserPlaybackState } from "../../types/events";

export class ShortsAdapter implements PageAdapter {
  public readonly pageType = "shorts";
  private observer: MutationObserver | null = null;
  private currentActiveReel: HTMLElement | null = null;
  private savedUserState: UserPlaybackState | null = null;

  constructor(
    private readonly rootElement: Document | HTMLElement = document,
    private readonly onEvent?: (event: BlockerEvent) => void
  ) {}

  public mount(): void {
    this.update();

    this.observer = new MutationObserver(() => {
      this.update();
    });

    const target = this.rootElement instanceof Document
      ? (this.rootElement.documentElement || this.rootElement)
      : this.rootElement;

    if (target) {
      this.observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["is-active", "class"]
      });
    }

    if (this.rootElement instanceof Document && this.rootElement.readyState === "loading") {
      this.rootElement.addEventListener(
        "DOMContentLoaded",
        () => {
          this.update();
        },
        { once: true }
      );
    }
  }

  public update(): void {
    // Find active reel video renderer
    const activeReel = this.rootElement.querySelector<HTMLElement>(
      "ytd-reel-video-renderer[is-active], .reel-video-in-sequence[is-active]"
    );

    if (!activeReel) {
      return;
    }

    if (this.currentActiveReel !== activeReel) {
      this.currentActiveReel = activeReel;
    }

    // Check if the active reel is a sponsored ad reel
    const isAdReel =
      activeReel.querySelector(
        "ytd-ad-slot-renderer, ytd-reel-ad-header-renderer, .shorts-ad-badge, .badge-shape-wiz--ad"
      ) !== null ||
      activeReel.classList.contains("ad-showing") ||
      activeReel.hasAttribute("is-ad");

    if (isAdReel) {
      this.handleAdReel(activeReel);
    } else {
      // Organic reel: restore user audio/speed settings if previously suppressed on ad reel
      this.restoreUserState(activeReel);
    }
  }

  private handleAdReel(adReel: HTMLElement): void {
    this.onEvent?.({
      type: "AD_CONFIRMED",
      signals: ["Shorts ad reel detected"]
    });

    const video = adReel.querySelector<HTMLVideoElement>("video");

    // Snapshot user settings before altering playback
    if (video && this.savedUserState === null) {
      const rate = video.playbackRate > 4 || video.playbackRate <= 0 ? 1 : video.playbackRate;
      this.savedUserState = {
        muted: video.muted,
        volume: video.volume,
        playbackRate: rate
      };
    }

    // Mute ad immediately to prevent audio blips
    if (video) {
      try {
        video.muted = true;
      } catch {
        // Ignore mute error
      }
    }

    // 1. Try to advance to the next short via navigation button
    const nextBtn = this.rootElement.querySelector<HTMLElement>(
      "#navigation-button-down button, #navigation-button-down yt-button-shape, button[aria-label='Next video'], button[aria-label='Next']"
    );

    if (nextBtn) {
      try {
        nextBtn.click();
        this.onEvent?.({ type: "SKIP_CLICKED" });
      } catch {
        // Fallback to video manipulation
      }
    }

    // 2. Fallback / supplementary acceleration: seek video in ad reel to end and accelerate
    if (video) {
      try {
        video.muted = true;
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
          this.onEvent?.({ type: "AD_SEEKED" });
        } else {
          video.playbackRate = 16;
          this.onEvent?.({ type: "AD_ACCELERATED" });
        }
      } catch {
        // Ignore video manipulation error
      }
    }
  }

  private restoreUserState(activeReel?: HTMLElement | null): void {
    if (this.savedUserState === null) return;

    const reel = activeReel || this.currentActiveReel;
    const video = reel?.querySelector<HTMLVideoElement>("video");
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

  public resetForNavigation(): void {
    this.restoreUserState();
  }

  public unmount(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.restoreUserState();
    this.currentActiveReel = null;
  }
}
