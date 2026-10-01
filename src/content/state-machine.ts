import type { PlayerState, BlockerEvent } from "../types/events";
import { detectAdSignals, type AdDetectionResult } from "./ad-detector";
import { PlayerController } from "./player-controller";

export type StateChangeEvent = (from: PlayerState, to: PlayerState) => void;

export class PlaybackStateMachine {
  private state: PlayerState = "CONTENT";
  private controller: PlayerController;
  private shortLivedTimer: ReturnType<typeof setInterval> | null = null;
  private postClickVerifyTimer: ReturnType<typeof setTimeout> | null = null;
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
          this.finishRecovery();
        }
        break;
      }

      case "RECOVERING": {
        this.finishRecovery();
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

  /**
   * A synthetic button click is only an attempt, not a success signal.
   *
   * We click if a native control exists, then re-check the player shortly after.
   * If YouTube ignored the synthetic click and the ad is still active, fall back
   * to muting/accelerating/seeking the confirmed ad media.
   */
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

  private finishRecovery(): void {
    this.stopShortLivedTimer();
    this.clearPostClickVerification();
    this.transitionTo("RECOVERING");
    this.controller.restoreUserState();
    this.transitionTo("CONTENT");
  }

  private startShortLivedTimer(): void {
    if (this.shortLivedTimer !== null) return;

    let iterations = 0;
    const maxIterations = 100; // up to 10 seconds of ad-only monitoring

    this.shortLivedTimer = setInterval(() => {
      iterations++;
      this.update();

      if (this.state !== "CONFIRMED_AD" || iterations >= maxIterations) {
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
  }

  public resetForNavigation(): void {
    this.stopShortLivedTimer();
    this.clearPostClickVerification();

    if (this.state === "CONFIRMED_AD" || this.state === "RECOVERING") {
      this.controller.restoreUserState();
    }

    this.state = "CONTENT";
  }

  public destroy(): void {
    this.detachObserver();

    if (this.state === "CONFIRMED_AD" || this.state === "RECOVERING") {
      this.controller.restoreUserState();
    }

    this.state = "CONTENT";
  }
}
