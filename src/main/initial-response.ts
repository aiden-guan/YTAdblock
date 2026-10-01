import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import type { BlockerEvent } from "../types/events";

export type InitialResponseEventCallback = (event: BlockerEvent) => void;

/**
 * Observe ytInitialPlayerResponse early without rewriting ad-bound playback data.
 *
 * Removing ad metadata from the initial response while leaving the original
 * streamingData intact can produce YouTube's full-preroll backoff. For the
 * initial response we therefore collect diagnostics only and leave the value
 * untouched. The DOM fallback can then terminate a real ad state immediately,
 * while fetch-based responses still get a chance at verified clean substitution.
 */
export function installInitialPlayerResponseHook(
  targetWindow: Window = window,
  onEvent?: InitialResponseEventCallback
): () => void {
  const hookSymbol = Symbol.for("ytclean.initialResponse.installed");
  const win = targetWindow as unknown as Record<symbol, boolean> & {
    ytInitialPlayerResponse?: unknown;
  };

  if (win[hookSymbol]) return () => {};

  const observeResponseValue = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;

    const videoId = (value as any)?.videoDetails?.videoId;
    const prerollInfo = detectPrerollInfo(value);

    if (videoId) {
      globalPlaybackTiming.startSession(videoId);
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RECEIVED", videoId);
      globalPlaybackTiming.setPrerollInfo(prerollInfo, videoId);
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
    }

    onEvent?.({ type: "PLAYER_RESPONSE_SEEN" });

    if (prerollInfo.hasPreroll) {
      onEvent?.({
        type: "PREROLL_DETECTED",
        videoId,
        source: "initial"
      });
    } else {
      onEvent?.({
        type: "PREROLL_CLEARED",
        videoId,
        reason: "clean_response"
      });
    }
    return value;
  };

  let currentValue: unknown = win.ytInitialPlayerResponse;

  if (currentValue !== undefined) {
    try {
      currentValue = observeResponseValue(currentValue);
    } catch (err) {
      onEvent?.({
        type: "ERROR",
        subsystem: "INITIAL_RESPONSE",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    targetWindow,
    "ytInitialPlayerResponse"
  );

  try {
    Object.defineProperty(targetWindow, "ytInitialPlayerResponse", {
      configurable: true,
      enumerable: true,
      get() {
        return currentValue;
      },
      set(newValue: unknown) {
        try {
          currentValue = observeResponseValue(newValue);
        } catch (err) {
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
  } catch {
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
      // Ignore teardown failure.
    }
  };
}
