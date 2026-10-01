import type { BlockerEvent } from "../types/events";

const SHIELD_ATTRIBUTE = "ytclean-preroll-pending";
const SOFT_WATCHDOG_MS = 12_000;
const HARD_WATCHDOG_MS = 45_000;

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
  private confirmedPreroll = false;
  private softWatchdog: ReturnType<typeof setTimeout> | null = null;
  private hardWatchdog: ReturnType<typeof setTimeout> | null = null;
  private rootObserver: MutationObserver | null = null;

  constructor(private readonly targetDocument: Document = document) {}

  public isActive(): boolean {
    return this.active;
  }

  public getActiveVideoId(): string | undefined {
    return this.activeVideoId;
  }

  /**
   * Pre-arm a navigation before we know whether the destination has an ad.
   * This is intentionally revealable by confirmed content playback.
   */
  public preArmNavigation(): void {
    this.active = true;
    this.activeVideoId = undefined;
    this.confirmedPreroll = false;
    this.applyAttribute(true);
    this.restartWatchdogs();
  }

  /**
   * Latch a known preroll. Once this happens, an HTMLVideoElement "playing"
   * event is not sufficient to reveal the player because that event may belong
   * to the ad itself.
   */
  public armDetectedPreroll(videoId?: string): void {
    this.active = true;
    if (videoId) {
      this.activeVideoId = videoId;
    }
    this.confirmedPreroll = true;
    this.applyAttribute(true);
    this.restartWatchdogs();
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
    this.confirmedPreroll = false;
    this.stopWatchdogs();
    this.applyAttribute(false);
  }

  public handleEvent(event: BlockerEvent): void {
    if (event.type === "PREROLL_DETECTED") {
      this.armDetectedPreroll(event.videoId);
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
    if (this.confirmedPreroll) {
      return;
    }
    this.clear("content_playing");
  }

  public hasConfirmedPreroll(): boolean {
    return this.confirmedPreroll;
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

  private restartWatchdogs(): void {
    this.stopWatchdogs();

    // Soft fail-open is only for pre-armed clean navigations that somehow never
    // produce a reliable content signal. Once a preroll is explicitly confirmed,
    // this timer MUST NOT reveal the ad/end-card.
    this.softWatchdog = setTimeout(() => {
      this.softWatchdog = null;

      if (!this.active) return;

      if (this.confirmedPreroll) {
        return;
      }

      this.clear("watchdog");
    }, SOFT_WATCHDOG_MS);

    // Absolute safety cap: never leave a tab permanently black if YouTube changes
    // its lifecycle so completely that neither recovery nor substitution fires.
    this.hardWatchdog = setTimeout(() => {
      this.hardWatchdog = null;
      if (this.active) {
        this.clear("watchdog");
      }
    }, HARD_WATCHDOG_MS);
  }

  private stopWatchdogs(): void {
    if (this.softWatchdog !== null) {
      clearTimeout(this.softWatchdog);
      this.softWatchdog = null;
    }

    if (this.hardWatchdog !== null) {
      clearTimeout(this.hardWatchdog);
      this.hardWatchdog = null;
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
