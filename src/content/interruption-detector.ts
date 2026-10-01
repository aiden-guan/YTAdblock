import {
  ANTI_ADBLOCK_DIALOG_SELECTORS,
  ANTI_ADBLOCK_TEXT_PATTERNS
} from "../config/youtube";
import type { BlockerEvent } from "../types/events";

const EXCLUSION_PATTERNS = [
  /age-restrict/i,
  /verify your age/i,
  /sign in to confirm/i,
  /confirm your account/i,
  /purchase/i,
  /membership/i,
  /join this channel/i,
  /video unavailable/i,
  /this video is private/i,
  /cookie/i,
  /before you continue to youtube/i
];

export interface InterruptionStatus {
  isInterrupted: boolean;
  dialogElement: HTMLElement | null;
  dismissButton: HTMLElement | null;
  reason?: string;
}

export class AntiAdblockInterruptionDetector {
  private recentDismissals: number[] = [];
  private readonly maxDismissalsPerMinute = 3;

  constructor(
    private readonly rootElement: Document | HTMLElement = document,
    private readonly onEvent?: (event: BlockerEvent) => void
  ) {}

  /**
   * Scans for active anti-adblock dialogs, validating against legitimate system dialogs.
   */
  public detectInterruption(): InterruptionStatus {
    for (const selector of ANTI_ADBLOCK_DIALOG_SELECTORS) {
      const candidates = this.rootElement.querySelectorAll<HTMLElement>(selector);
      for (const el of Array.from(candidates)) {
        const text = el.textContent || el.innerText || "";

        // Check exclusions first (age gate, security, purchase, consent)
        const isExcluded = EXCLUSION_PATTERNS.some((pattern) => pattern.test(text));
        if (isExcluded) {
          continue;
        }

        // Check against anti-adblock signatures
        const matchesAntiAdblock = ANTI_ADBLOCK_TEXT_PATTERNS.some((pattern) =>
          pattern.test(text)
        );

        if (matchesAntiAdblock) {
          const dismissButton = el.querySelector<HTMLElement>(
            "button, tp-yt-paper-button, yt-button-shape, #dismiss-button, [aria-label='Close']"
          );

          return {
            isInterrupted: true,
            dialogElement: el,
            dismissButton,
            reason: "Detected enforcement dialog matching anti-adblock signatures"
          };
        }
      }
    }

    return {
      isInterrupted: false,
      dialogElement: null,
      dismissButton: null
    };
  }

  /**
   * Attempts safe, minimally invasive recovery without entering an infinite loop.
   */
  public attemptRecovery(): boolean {
    const status = this.detectInterruption();
    if (!status.isInterrupted || !status.dialogElement) {
      return false;
    }

    // Rate-limiting check: avoid infinite dismiss loops
    const now = Date.now();
    this.recentDismissals = this.recentDismissals.filter((t) => now - t < 60_000);
    if (this.recentDismissals.length >= this.maxDismissalsPerMinute) {
      this.onEvent?.({
        type: "ERROR",
        subsystem: "INTERRUPTION_DETECTOR",
        message: "Maximum anti-adblock recovery attempts reached for current time window"
      });
      return false;
    }

    this.onEvent?.({
      type: "ANTI_ADBLOCK_DETECTED",
      detail: status.reason || "Enforcement dialog"
    });

    let dismissed = false;

    // 1. Try clicking dismiss button
    if (status.dismissButton) {
      try {
        status.dismissButton.click();
        dismissed = true;
      } catch {
        // Fall back to removal
      }
    }

    // 2. If clicking didn't remove it or button wasn't found, detach dialog safely
    if (!dismissed || status.dialogElement.isConnected) {
      try {
        status.dialogElement.remove();
        dismissed = true;
      } catch {
        status.dialogElement.style.display = "none";
        dismissed = true;
      }
    }

    // 3. Remove modal backdrop overlay so page remains fully clickable
    const backdrops = this.rootElement.querySelectorAll<HTMLElement>("tp-yt-iron-overlay-backdrop");
    for (const backdrop of Array.from(backdrops)) {
      try {
        backdrop.remove();
      } catch {
        backdrop.style.display = "none";
      }
    }

    // 4. Resume paused video if playback was halted
    const video = this.rootElement.querySelector<HTMLVideoElement>("video");
    if (video && video.paused) {
      try {
        const playPromise = video.play();
        if (playPromise) {
          playPromise.catch(() => {});
        }
      } catch {
        // Ignore play failure
      }
    }

    if (dismissed) {
      this.recentDismissals.push(now);
      this.onEvent?.({ type: "ANTI_ADBLOCK_DISMISSED" });
    }

    return dismissed;
  }
}
