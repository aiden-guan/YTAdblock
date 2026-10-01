/**
 * YouTube Player-Side Delay Bypass.
 *
 * Handles scenarios where clean media was obtained and substituted, but YouTube's
 * internal player state machine remains artificially locked in a preroll ad-gate.
 *
 * Strict safety rules:
 * - NEVER monkey-patch window.setTimeout or window.setInterval.
 * - Only activates when clean content media is verified and NO ad is playing.
 * - Uses the least invasive mechanism available.
 * - Explicitly documents which signal was changed.
 */

import { SKIP_SELECTORS } from "../../config/youtube";

export interface PlayerDelayAssessment {
  isStuckInAdState: boolean;
  hasAdShowingClass: boolean;
  hasSkipButton: boolean;
  skipButtonElement?: HTMLElement;
  hasCleanMedia: boolean;
  videoElement?: HTMLVideoElement;
}

export interface DelayBypassResult {
  bypassed: boolean;
  signalChanged?: string;
  mechanism?: string;
}

export class PlayerDelayBypassManager {
  /**
   * Evaluates whether the player is artificially stuck in an ad-state despite having clean media.
   */
  public assessPlayerState(
    playerElement: HTMLElement,
    hasCleanMediaResponse = false
  ): PlayerDelayAssessment {
    const classList = playerElement.classList;
    const hasAdShowingClass =
      classList.contains("ad-showing") || classList.contains("ad-interrupting");

    const video = playerElement.querySelector<HTMLVideoElement>("video") || undefined;
    const videoSrc = video?.src || video?.currentSrc || "";

    // An actual ad video stream typically contains /ad/ or doubleclick
    const isActualAdVideo =
      videoSrc.includes("/ad/") ||
      videoSrc.includes("googleads") ||
      videoSrc.includes("pagead");

    const hasCleanMedia =
      hasCleanMediaResponse ||
      (Boolean(video) && !isActualAdVideo && (video?.duration || 0) > 0);

    // Find any skip button
    let skipButton: HTMLElement | undefined;
    for (const selector of SKIP_SELECTORS) {
      const btn = playerElement.querySelector<HTMLElement>(selector);
      if (btn) {
        skipButton = btn;
        break;
      }
    }

    const isStuckInAdState =
      hasAdShowingClass &&
      hasCleanMedia &&
      !isActualAdVideo;

    return {
      isStuckInAdState,
      hasAdShowingClass,
      hasSkipButton: Boolean(skipButton),
      skipButtonElement: skipButton,
      hasCleanMedia,
      videoElement: video
    };
  }

  /**
   * Transitions player back to normal content playback using the least invasive mechanism.
   * Documented signals:
   * 1. CLICKED_STUCK_AD_SKIP_BUTTON
   * 2. INVOKED_PLAYER_SKIP_API
   * 3. REMOVED_STUCK_AD_SHOWING_CLASS
   * 4. TRIGGERED_CONTENT_PLAY
   */
  public bypassDelay(
    playerElement: HTMLElement,
    assessment: PlayerDelayAssessment
  ): DelayBypassResult {
    if (!assessment.isStuckInAdState) {
      return { bypassed: false };
    }

    // Mechanism 1: Click visible skip button if available
    if (assessment.skipButtonElement) {
      try {
        assessment.skipButtonElement.click();
        return {
          bypassed: true,
          signalChanged: "CLICKED_STUCK_AD_SKIP_BUTTON",
          mechanism: "DOM_CLICK"
        };
      } catch {
        // Fall through to next mechanism
      }
    }

    // Mechanism 2: Invoke player object API if exposed on the custom element
    const playerApi = playerElement as any;
    if (typeof playerApi.skipAd === "function") {
      try {
        playerApi.skipAd();
        return {
          bypassed: true,
          signalChanged: "INVOKED_PLAYER_SKIP_API",
          mechanism: "PLAYER_API_skipAd"
        };
      } catch {
        // Fall through
      }
    }

    // Mechanism 3: Remove stuck CSS class markers and unblock player overlay
    if (assessment.hasAdShowingClass) {
      playerElement.classList.remove("ad-showing");
      playerElement.classList.remove("ad-interrupting");

      // Check if video is paused at start of content
      if (assessment.videoElement && assessment.videoElement.paused) {
        try {
          assessment.videoElement.play();
        } catch {
          // Playback promise rejection (e.g. user gesture required) is non-fatal
        }
      }

      return {
        bypassed: true,
        signalChanged: "REMOVED_STUCK_AD_SHOWING_CLASS",
        mechanism: "DOM_CLASS_RESET"
      };
    }

    return { bypassed: false };
  }
}

export const globalPlayerDelayBypass = new PlayerDelayBypassManager();
