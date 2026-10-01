import type { PlayerState, BlockerEvent } from "../types/events";
import { detectAdSignals, type AdDetectionResult } from "./ad-detector";
import { PlayerController } from "./player-controller";

export type StateChangeEvent = (from: PlayerState, to: PlayerState) => void;

/**
 * Robust finite state machine governing playback protection and ad transitions.
 */
export class PlaybackStateMachine {
  private state: PlayerState = "CONTENT";
  private controller: PlayerController;
  private shortLivedTimer: ReturnType<typeof setInterval> | null = null;
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

  /**
   * Evaluates current DOM signals and transitions states accordingly.
   */
  public update(): void {
    const detection = detectAdSignals(this.playerElement);
    const prevState = this.state;

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
        // Still in ad?
        if (detection.isConfirmedAd || detection.hasAdShowingClass) {
          // Keep ad muted and fast so no audio leaks
          this.controller.applyAccelerationAndMute();
          // Re-attempt skip button if it appeared, or seek near end
          if (!this.controller.tryClickSkipButton(detection)) {
            this.controller.trySeekToEndOfAd(detection);
          }
        } else {
          // Ad terminated, begin recovery
          this.stopShortLivedTimer();
          this.transitionTo("RECOVERING");
          this.controller.restoreUserState();
          this.transitionTo("CONTENT");
        }
        break;
      }

      case "RECOVERING": {
        this.stopShortLivedTimer();
        this.controller.restoreUserState();
        this.transitionTo("CONTENT");
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

    // 1. Snapshot user configuration before taking actions
    this.controller.snapshotUserState();

    // 2. Mute ad immediately and accelerate to prevent audio leakage
    this.controller.applyAccelerationAndMute();

    // 3. Progressive strategy: click skip button -> near-end seek
    const skipped = this.controller.tryClickSkipButton(detection);
    if (!skipped) {
      this.controller.trySeekToEndOfAd(detection);
    }

    // Start a short-lived timer to track ad completion without full-page polling
    this.startShortLivedTimer();
  }

  private startShortLivedTimer(): void {
    if (this.shortLivedTimer !== null) return;
    let iterations = 0;
    const maxIterations = 50; // Max 5 seconds of active monitoring

    this.shortLivedTimer = setInterval(() => {
      iterations++;
      this.update();
      if (this.state !== "CONFIRMED_AD" || iterations >= maxIterations) {
        this.stopShortLivedTimer();
      }
    }, 100);
  }

  private stopShortLivedTimer(): void {
    if (this.shortLivedTimer !== null) {
      clearInterval(this.shortLivedTimer);
      this.shortLivedTimer = null;
    }
  }

  /**
   * Binds MutationObserver targeted at this specific player element.
   */
  public attachObserver(): void {
    this.detachObserver();

    this.observer = new MutationObserver(() => {
      this.update();
    });

    this.observer.observe(this.playerElement, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true
    });

    // Initial check
    this.update();
  }

  public detachObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.stopShortLivedTimer();
  }

  /**
   * Resets transient state during SPA navigation.
   */
  public resetForNavigation(): void {
    this.stopShortLivedTimer();
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
