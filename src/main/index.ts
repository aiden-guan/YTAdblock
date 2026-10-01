import {
  GLOBAL_INSTALL_KEY,
  BRIDGE_EVENT_ISOLATED_TO_MAIN,
  BRIDGE_EVENT_MAIN_TO_ISOLATED
} from "../config/youtube";
import { MainWorldPlayerResponseSource } from "./source-interface";
import { globalPlaybackTiming } from "./playback-timing";
import { globalAlternatePlayer } from "./alternate-player/alternate-player";
import { globalPlayerDelayBypass } from "./delay/player-delay";
import {
  globalPrerollShield,
  isPlayerCurrentlyAdvertising
} from "./preroll-shield";

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

  // Direct watch-page loads do not fire YouTube's SPA navigation event before
  // the first player paint. Arm immediately so neither an ad nor its end card
  // can flash before the player response is classified.
  if (window.location.pathname === "/watch") {
    globalPrerollShield.preArmNavigation();
  }

  const source = new MainWorldPlayerResponseSource(window, (event) => {
    if (event.type === "PLAYER_RESPONSE_SUBSTITUTED" || event.type === "PLAYER_RESPONSE_SANITIZED") {
      emitTimingUpdate();
    }
  });
  source.start();

  // Section 17: SPA navigation.
  //
  // Arm at navigation START, before the destination player exists. The CSS
  // selector is harmless on pages without #movie_player and guarantees that a
  // newly-created watch player begins covered rather than painting one ad frame.
  window.addEventListener("yt-navigate-start", () => {
    globalPrerollShield.preArmNavigation();

    // Abort pending alternate client races from the departing video.
    globalAlternatePlayer.abortAllPending();
    globalPlaybackTiming.finalizeSession();
  });

  window.addEventListener("yt-navigate-finish", () => {
    if (window.location.pathname !== "/watch") {
      globalPrerollShield.clear("navigation");
    }
  });

  // Track media and HTMLVideoElement playback milestones
  window.addEventListener(
    "playing",
    (e) => {
      if (e.target instanceof HTMLVideoElement) {
        globalPlaybackTiming.recordMilestone("VIDEO_PLAYING");
        emitTimingUpdate();

        // Check if player element was stuck in preroll gate and bypass if needed.
        const playerEl = document.querySelector<HTMLElement>("#movie_player, .html5-video-player");
        if (playerEl) {
          const assessment = globalPlayerDelayBypass.assessPlayerState(playerEl, true);
          if (assessment.isStuckInAdState) {
            globalPlayerDelayBypass.bypassDelay(playerEl, assessment);
          }
        }

        // A direct/SPA watch navigation starts shielded. Once a playing event
        // has settled and the live player has no ad signals, actual content is
        // on screen and it is safe to reveal the player. The short delay gives
        // YouTube time to attach ad-showing/ad UI for a preroll before we decide.
        if (globalPrerollShield.isActive()) {
          window.setTimeout(() => {
            const livePlayer = document.querySelector<HTMLElement>(
              "#movie_player, .html5-video-player"
            );
            if (!isPlayerCurrentlyAdvertising(livePlayer)) {
              globalPrerollShield.clearForContentPlayback();
            }
          }, 75);
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
