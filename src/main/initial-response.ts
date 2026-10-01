import { sanitizePlayerResponse } from "./player-response";
import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import type { BlockerEvent } from "../types/events";

export type InitialResponseEventCallback = (event: BlockerEvent) => void;

/**
 * Defensive hook for window.ytInitialPlayerResponse.
 *
 * Traps assignments to `window.ytInitialPlayerResponse` before or during page load,
 * captures preroll diagnostics before sanitization, sanitizes any advertising structures
 * before YouTube's player components read it, and maintains transparent getter/setter
 * semantics with fail-open behavior.
 */
export function installInitialPlayerResponseHook(
  targetWindow: Window = window,
  onEvent?: InitialResponseEventCallback
): () => void {
  const hookSymbol = Symbol.for("ytclean.initialResponse.installed");
  const win = targetWindow as unknown as Record<symbol, boolean> & {
    ytInitialPlayerResponse?: unknown;
  };

  if (win[hookSymbol]) {
    // Idempotent
    return () => {};
  }

  const processResponseValue = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
      return value;
    }

    const videoId = (value as any)?.videoDetails?.videoId;
    if (videoId) {
      globalPlaybackTiming.startSession(videoId);
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RECEIVED", videoId);
    }

    const prerollInfo = detectPrerollInfo(value);
    if (videoId) {
      globalPlaybackTiming.setPrerollInfo(prerollInfo, videoId);
    }

    onEvent?.({ type: "PLAYER_RESPONSE_SEEN" });

    const { sanitized, report } = sanitizePlayerResponse(value);

    if (videoId) {
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
    }

    if (report.changed) {
      onEvent?.({
        type: "PLAYER_RESPONSE_SANITIZED",
        removed: report.removed
      });
      return sanitized;
    }

    return value;
  };

  let currentValue: unknown = win.ytInitialPlayerResponse;

  // If already present upon execution, sanitize it immediately
  if (currentValue !== undefined) {
    try {
      currentValue = processResponseValue(currentValue);
    } catch (err) {
      // Fail-open: keep original value
      onEvent?.({
        type: "ERROR",
        subsystem: "INITIAL_RESPONSE",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(targetWindow, "ytInitialPlayerResponse");

  try {
    Object.defineProperty(targetWindow, "ytInitialPlayerResponse", {
      configurable: true,
      enumerable: true,
      get() {
        return currentValue;
      },
      set(newValue: unknown) {
        try {
          currentValue = processResponseValue(newValue);
        } catch (err) {
          // Fail-open: assign unadulterated value on unexpected error
          currentValue = newValue;
          onEvent?.({
            type: "ERROR",
            subsystem: "INITIAL_RESPONSE",
            message: err instanceof Error ? err.message : String(err)
          });
        }
      }
    });

    win[hookSymbol] = true;
  } catch (_e) {
    // If defineProperty fails (e.g. non-configurable), do not break global object
    return () => {};
  }

  return () => {
    try {
      if (originalDescriptor) {
        Object.defineProperty(targetWindow, "ytInitialPlayerResponse", originalDescriptor);
      } else {
        delete (targetWindow as any).ytInitialPlayerResponse;
        (targetWindow as any).ytInitialPlayerResponse = currentValue;
      }
      delete win[hookSymbol];
    } catch {
      // Ignore teardown failure
    }
  };
}
