import type { BlockerEvent } from "../types/events";

const SHIELD_ATTRIBUTE = "ytclean-preroll-pending";
const WATCHDOG_MS = 12_000;

export type ShieldClearReason =
  | "substituted"
  | "content_resumed"
  | "content_playing"
  | "navigation"
  | "watchdog";

/**
 * MAIN-world preroll shield.
 *
 * This controller owns the earliest possible visual protection. It mutates the
 * shared DOM directly from the same synchronous callback that detects the
 * player response, avoiding the MAIN -> isolated CustomEvent startup race.
 *
 * The shield is intentionally latched: once a preroll is known for a watch
 * navigation, later unrelated/secondary "clean" player responses are not
 * allowed to clear it. Only a verified terminal condition can.
 */
export class PrerollShieldController {
  private active = false;
  private activeVideoId: string | undefined;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private rootObserver: MutationObserver | null = null;

  constructor(private readonly targetDocument: Document = document) {}

  public isActive(): boolean {
    return this.active;
  }

  public getActiveVideoId(): string | undefined {
    return this.activeVideoId;
  }

  public arm(videoId?: string): void {
    this.active = true;
    if (videoId) {
      this.activeVideoId = videoId;
    }

    this.applyAttribute(true);
    this.restartWatchdog();
  }

  /**
   * A clean_response is deliberately not accepted as a clear reason here.
   * YouTube can issue secondary clean player responses while the real preroll
   * session is still active. That was causing the shield to disappear before
   * the ad painted.
   */
  public clear(reason: ShieldClearReason, videoId?: string): void {
    if (!this.active) {
      this.applyAttribute(false);
      return;
    }

    if (
      videoId &&
      this.activeVideoId &&
      videoId !== this.activeVideoId &&
      reason !== "navigation"
    ) {
      return;
    }

    this.active = false;
    this.activeVideoId = undefined;
    this.stopWatchdog();
    this.applyAttribute(false);
  }

  public handleEvent(event: BlockerEvent): void {
    if (event.type === "PREROLL_DETECTED") {
      this.arm(event.videoId);
      return;
    }

    if (event.type === "PLAYER_RESPONSE_SUBSTITUTED") {
      this.clear("substituted", event.videoId);
      return;
    }

    if (event.type === "CONTENT_RESUMED") {
      this.clear("content_resumed");
      return;
    }

    if (event.type === "PREROLL_CLEARED") {
      switch (event.reason) {
        case "substituted":
          this.clear("substituted", event.videoId);
          break;
        case "content_resumed":
          this.clear("content_resumed", event.videoId);
          break;
        case "watchdog":
          this.clear("watchdog", event.videoId);
          break;
        // Do not clear a latched shield from clean_response or navigation
        // events emitted during the SPA transition. main/index owns navigation.
        case "clean_response":
        case "navigation":
          break;
      }
    }
  }

  /**
   * Called from the captured HTMLVideoElement "playing" event after a short
   * settling delay. Actual content playback is a stronger clear signal than a
   * secondary player response.
   */
  public clearForContentPlayback(): void {
    this.clear("content_playing");
  }

  private applyAttribute(active: boolean): void {
    const root = this.targetDocument.documentElement;

    if (root) {
      if (active) {
        root.setAttribute(SHIELD_ATTRIBUTE, "true");
      } else {
        root.removeAttribute(SHIELD_ATTRIBUTE);
      }
      this.rootObserver?.disconnect();
      this.rootObserver = null;
      return;
    }

    if (!active || typeof MutationObserver === "undefined") return;

    if (this.rootObserver) return;

    this.rootObserver = new MutationObserver(() => {
      const newRoot = this.targetDocument.documentElement;
      if (!newRoot) return;

      if (this.active) {
        newRoot.setAttribute(SHIELD_ATTRIBUTE, "true");
      }
      this.rootObserver?.disconnect();
      this.rootObserver = null;
    });

    this.rootObserver.observe(this.targetDocument, {
      childList: true,
      subtree: true
    });
  }

  private restartWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setTimeout(() => {
      this.clear("watchdog");
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}

export function isPlayerCurrentlyAdvertising(
  playerElement: HTMLElement | null
): boolean {
  if (!playerElement) return false;

  if (
    playerElement.classList.contains("ad-showing") ||
    playerElement.classList.contains("ad-interrupting")
  ) {
    return true;
  }

  const selectors = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-skip-ad-button-modern",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-flyout-cta",
    ".ytp-visit-advertiser-link",
    ".ytp-ad-duration-remaining",
    ".ytp-ad-text"
  ];

  for (const selector of selectors) {
    const element = playerElement.querySelector<HTMLElement>(selector);
    if (!element || element.hidden) continue;

    const style = getComputedStyle(element);
    if (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      (element.offsetWidth > 0 ||
        element.offsetHeight > 0 ||
        element.getClientRects().length > 0)
    ) {
      return true;
    }
  }

  return false;
}

export const globalPrerollShield = new PrerollShieldController();
