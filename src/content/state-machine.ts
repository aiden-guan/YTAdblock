import type { PlayerState, BlockerEvent } from "../types/events";
import { detectAdSignals, type AdDetectionResult } from "./ad-detector";
import { PlayerController } from "./player-controller";

export type StateChangeEvent = (from: PlayerState, to: PlayerState) => void;

const RECOVERY_STABLE_MS = 650;

export class PlaybackStateMachine {
  private state: PlayerState = "CONTENT";
  private controller: PlayerController;
  private shortLivedTimer: ReturnType<typeof setInterval> | null = null;
  private postClickVerifyTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;

  constructor(
    private readonly playerElement: HTMLElement,
    private readonly onEvent?: (event: BlockerEvent) => void,
    private readonly onStateChange?: StateChangeEvent
  ) {
    this.controller = new PlayerController(playerElement, onEvent);
  }

  public getState(): PlayerState {
    return this.state;
  }

  public getController(): PlayerController {
    return this.controller;
  }

  public update(): void {
    const detection = detectAdSignals(this.playerElement);

    switch (this.state) {
      case "CONTENT":
      case "UNKNOWN": {
        if (detection.isConfirmedAd) {
          this.transitionTo("CONFIRMED_AD");
          this.handleConfirmedAd(detection);
        } else if (detection.isPossibleAd) {
          this.transitionTo("POSSIBLE_AD");
          this.onEvent?.({
            type: "AD_POSSIBLE",
            signals: detection.signals.map((s) => s.detail)
          });
        }
        break;
      }

      case "POSSIBLE_AD": {
        if (detection.isConfirmedAd) {
          this.transitionTo("CONFIRMED_AD");
          this.handleConfirmedAd(detection);
        } else if (detection.signals.length === 0) {
          this.transitionTo("CONTENT");
        }
        break;
      }

      case "CONFIRMED_AD": {
        if (detection.isConfirmedAd || detection.hasAdShowingClass) {
          this.attemptAdCompletion(detection);
        } else {
          this.beginRecoveryVerification();
        }
        break;
      }

      case "RECOVERING": {
        if (detection.isConfirmedAd || detection.hasAdShowingClass) {
          // YouTube often has a brief signal-free gap between the linear ad and
          // its advertiser end card. Treat any reappearance inside the recovery
          // window as the SAME ad, not as resumed content.
          this.cancelRecoveryTimer();
          this.transitionTo("CONFIRMED_AD");
          this.attemptAdCompletion(detection);
          this.startShortLivedTimer();
        } else {
          this.scheduleRecoveryTimer();
        }
        break;
      }
    }
  }

  private transitionTo(newState: PlayerState): void {
    if (this.state === newState) return;
    const old = this.state;
    this.state = newState;
    this.onStateChange?.(old, newState);
  }

  private handleConfirmedAd(detection: AdDetectionResult): void {
    this.onEvent?.({
      type: "AD_CONFIRMED",
      signals: detection.signals.map((s) => s.detail)
    });

    this.controller.snapshotUserState();
    this.attemptAdCompletion(detection);
    this.startShortLivedTimer();
  }

  private attemptAdCompletion(detection: AdDetectionResult): void {
    this.controller.snapshotUserState();
    this.controller.applyAccelerationAndMute();

    const clickAttempted = this.controller.tryClickSkipButton(detection);

    if (!clickAttempted) {
      this.controller.trySeekToEndOfAd(detection);
      return;
    }

    this.schedulePostClickVerification();
  }

  private schedulePostClickVerification(): void {
    if (this.postClickVerifyTimer !== null) return;

    this.postClickVerifyTimer = setTimeout(() => {
      this.postClickVerifyTimer = null;

      if (this.state !== "CONFIRMED_AD") return;

      const freshDetection = detectAdSignals(this.playerElement);
      if (freshDetection.isConfirmedAd || freshDetection.hasAdShowingClass) {
        this.controller.applyAccelerationAndMute();
        this.controller.trySeekToEndOfAd(freshDetection);
      }
    }, 80);
  }

  /**
   * Do not restore playback on the first signal-free mutation. YouTube can tear
   * down the linear-ad DOM and create an advertiser end card a few hundred
   * milliseconds later. Keeping RECOVERING shielded avoids exposing that card.
   */
  private beginRecoveryVerification(): void {
    this.clearPostClickVerification();
    this.transitionTo("RECOVERING");
    this.scheduleRecoveryTimer();
  }

  private scheduleRecoveryTimer(): void {
    if (this.recoveryTimer !== null) return;

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;

      if (this.state !== "RECOVERING") return;

      const freshDetection = detectAdSignals(this.playerElement);
      if (freshDetection.isConfirmedAd || freshDetection.hasAdShowingClass) {
        this.transitionTo("CONFIRMED_AD");
        this.attemptAdCompletion(freshDetection);
        this.startShortLivedTimer();
        return;
      }

      this.completeRecovery();
    }, RECOVERY_STABLE_MS);
  }

  private completeRecovery(): void {
    this.stopShortLivedTimer();
    this.clearPostClickVerification();
    this.cancelRecoveryTimer();

    this.controller.restoreUserState();
    this.onEvent?.({
      type: "PREROLL_CLEARED",
      reason: "content_resumed"
    });
    this.transitionTo("CONTENT");
  }

  private startShortLivedTimer(): void {
    if (this.shortLivedTimer !== null) return;

    let iterations = 0;
    const maxIterations = 120; // up to 12 seconds of active ad monitoring

    this.shortLivedTimer = setInterval(() => {
      iterations++;
      this.update();

      if (
        (this.state !== "CONFIRMED_AD" && this.state !== "RECOVERING") ||
        iterations >= maxIterations
      ) {
        this.stopShortLivedTimer();
      }
    }, 100);
  }

  private clearPostClickVerification(): void {
    if (this.postClickVerifyTimer !== null) {
      clearTimeout(this.postClickVerifyTimer);
      this.postClickVerifyTimer = null;
    }
  }

  private cancelRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private stopShortLivedTimer(): void {
    if (this.shortLivedTimer !== null) {
      clearInterval(this.shortLivedTimer);
      this.shortLivedTimer = null;
    }
  }

  public attachObserver(): void {
    this.detachObserver();

    this.observer = new MutationObserver(() => {
      this.update();
    });

    this.observer.observe(this.playerElement, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-disabled"],
      childList: true,
      subtree: true
    });

    this.update();
  }

  public detachObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.stopShortLivedTimer();
    this.clearPostClickVerification();
    this.cancelRecoveryTimer();
  }

  public resetForNavigation(): void {
    this.stopShortLivedTimer();
    this.clearPostClickVerification();
    this.cancelRecoveryTimer();

    if (this.state === "CONFIRMED_AD" || this.state === "RECOVERING") {
      this.controller.restoreUserState(false);
    }

    this.state = "CONTENT";
  }

  public destroy(): void {
    this.detachObserver();

    if (this.state === "CONFIRMED_AD" || this.state === "RECOVERING") {
      this.controller.restoreUserState(false);
    }

    this.state = "CONTENT";
  }
}
