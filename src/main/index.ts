import {
  GLOBAL_INSTALL_KEY,
  BRIDGE_EVENT_ISOLATED_TO_MAIN,
  BRIDGE_EVENT_MAIN_TO_ISOLATED
} from "../config/youtube";
import { MainWorldPlayerResponseSource } from "./source-interface";
import { globalPlaybackTiming } from "./playback-timing";
import { globalAlternatePlayer } from "./alternate-player/alternate-player";
import { globalPlayerDelayBypass } from "./delay/player-delay";

(function initMainWorld() {
  const win = window as any;
  if (win[GLOBAL_INSTALL_KEY]) {
    return;
  }
  win[GLOBAL_INSTALL_KEY] = true;

  const emitBridgeEvent = (detail: unknown) => {
    try {
      window.dispatchEvent(
        new CustomEvent(BRIDGE_EVENT_MAIN_TO_ISOLATED, { detail })
      );
    } catch {
      // Ignore boundary dispatch errors
    }
  };

  const emitTimingUpdate = () => {
    const session = globalPlaybackTiming.getCurrentSession();
    if (session) {
      emitBridgeEvent({
        type: "TIMING_UPDATE",
        session: {
          videoId: session.videoId,
          timestamps: session.timestamps,
          prerollInfo: session.prerollInfo,
          candidateRace: session.candidateRace,
          selectedCandidate: session.selectedCandidate,
          suspectedCause: session.suspectedCause,
          avoidedPrerollWaitMs: session.avoidedPrerollWaitMs,
          completed: session.completed
        }
      });
    }
  };

  const source = new MainWorldPlayerResponseSource(window, (event) => {
    if (event.type === "PLAYER_RESPONSE_SUBSTITUTED" || event.type === "PLAYER_RESPONSE_SANITIZED") {
      emitTimingUpdate();
    }
  });
  source.start();

  // Section 17: SPA Navigation cleanup
  window.addEventListener("yt-navigate-start", () => {
    // Abort pending alternate client races from the departing video
    globalAlternatePlayer.abortAllPending();
    globalPlaybackTiming.finalizeSession();
  });

  // Track media and HTMLVideoElement playback milestones
  window.addEventListener(
    "playing",
    (e) => {
      if (e.target instanceof HTMLVideoElement) {
        globalPlaybackTiming.recordMilestone("VIDEO_PLAYING");
        emitTimingUpdate();

        // Check if player element was stuck in preroll gate and bypass if needed
        const playerEl = document.querySelector<HTMLElement>("#movie_player, .html5-video-player");
        if (playerEl) {
          const assessment = globalPlayerDelayBypass.assessPlayerState(playerEl, true);
          if (assessment.isStuckInAdState) {
            globalPlayerDelayBypass.bypassDelay(playerEl, assessment);
          }
        }
      }
    },
    true
  );

  window.addEventListener(
    "canplay",
    (e) => {
      if (e.target instanceof HTMLVideoElement) {
        globalPlaybackTiming.recordMilestone("VIDEO_CANPLAY");
      }
    },
    true
  );

  window.addEventListener(
    "loadedmetadata",
    (e) => {
      if (e.target instanceof HTMLVideoElement) {
        globalPlaybackTiming.recordMilestone("VIDEO_METADATA_LOADED");
      }
    },
    true
  );

  // Listen for commands from the isolated world
  window.addEventListener(BRIDGE_EVENT_ISOLATED_TO_MAIN, ((e: CustomEvent) => {
    const detail = e.detail;
    if (!detail || typeof detail !== "object") return;

    if (detail.action === "PAUSE_SANITIZER") {
      source.stop();
    } else if (detail.action === "RESUME_SANITIZER") {
      source.start();
    } else if (detail.action === "REQUEST_TIMING") {
      emitTimingUpdate();
    }
  }) as EventListener);
})();
