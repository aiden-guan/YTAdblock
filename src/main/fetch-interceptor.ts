import { TARGET_PLAYER_PATHS } from "../config/youtube";
import { sanitizePlayerResponse } from "./player-response";
import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import {
  globalAlternatePlayer,
  AlternatePlayerManager
} from "./alternate-player/alternate-player";
import { mergeCleanPlaybackData } from "./alternate-player/response-merger";
import type { BlockerEvent } from "../types/events";

export type EventCallback = (event: BlockerEvent) => void;

/**
 * Determines whether a URL points to a targeted YouTube player endpoint.
 */
export function isPlayerEndpoint(urlStr: string): boolean {
  try {
    const url = new URL(urlStr, "https://www.youtube.com");
    return TARGET_PLAYER_PATHS.some((path) => url.pathname.includes(path));
  } catch {
    return false;
  }
}

/**
 * Determines whether a URL points to a GoogleVideo / YouTube media playback stream.
 */
export function isMediaEndpoint(urlStr: string): boolean {
  return urlStr.includes("/videoplayback") || urlStr.includes("googlevideo.com");
}

/**
 * Checks whether this fetch request was initiated internally by ytclean.
 */
export function isInternalFetch(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers) {
    if (typeof (init.headers as any).get === "function") {
      if ((init.headers as any).get("X-YTClean-Internal") === "1") return true;
    } else if (typeof init.headers === "object") {
      if ((init.headers as any)["X-YTClean-Internal"] === "1") return true;
    }
  }
  if (input && typeof input === "object" && "headers" in input) {
    const req = input as Request;
    if (req.headers && typeof req.headers.get === "function") {
      if (req.headers.get("X-YTClean-Internal") === "1") return true;
    }
  }
  return false;
}

/**
 * Extracts a URL string from fetch parameters (string, URL, or Request).
 */
export function extractUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    return (input as Request).url;
  }
  return String(input);
}

/**
 * Extracts payload object from fetch arguments or parsed player response.
 */
export function extractPayloadFromInitOrData(
  init?: RequestInit,
  input?: RequestInfo | URL,
  data?: any
): Record<string, unknown> | null {
  if (init?.body && typeof init.body === "string") {
    try {
      return JSON.parse(init.body);
    } catch {
      // Ignore parse error
    }
  }
  if (data?.videoDetails?.videoId) {
    return {
      videoId: data.videoDetails.videoId,
      context: { client: { clientName: "WEB", clientVersion: "2.20240901.01.00" } }
    };
  }
  return null;
}

/**
 * Extracts target videoId from URL query, request body, or response data.
 */
export function extractVideoId(
  urlStr: string,
  init?: RequestInit,
  data?: any
): string | undefined {
  if (data?.videoDetails?.videoId) {
    return data.videoDetails.videoId;
  }
  try {
    const url = new URL(urlStr, "https://www.youtube.com");
    const vParam = url.searchParams.get("v") || url.searchParams.get("videoId");
    if (vParam) return vParam;
  } catch {}
  if (init?.body && typeof init.body === "string") {
    try {
      const parsed = JSON.parse(init.body);
      if (parsed.videoId) return parsed.videoId;
    } catch {}
  }
  return undefined;
}

/**
 * Constructs a transparent replacement Response that preserves original
 * Response metadata (url, redirected, status, statusText, headers, type)
 * while serving the sanitized JSON content.
 */
export function createSanitizedResponse(
  originalResponse: Response,
  sanitizedJson: unknown
): Response {
  const jsonString = JSON.stringify(sanitizedJson);

  // Copy and adjust headers
  const newHeaders = new Headers(originalResponse.headers);
  newHeaders.delete("content-length");
  newHeaders.set("content-type", "application/json; charset=utf-8");

  const replacement = new Response(jsonString, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: newHeaders
  });

  // Proxy to preserve read-only attributes like url, redirected, type
  return new Proxy(replacement, {
    get(target, prop) {
      if (prop === "url") {
        return originalResponse.url || target.url;
      }
      if (prop === "redirected") {
        return originalResponse.redirected ?? target.redirected;
      }
      if (prop === "type") {
        return originalResponse.type || target.type;
      }
      if (prop === "clone") {
        return () => {
          if (target.bodyUsed) {
            return target.clone(); // Native TypeError when body is already used
          }
          return createSanitizedResponse(originalResponse, sanitizedJson);
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    }
  });
}

/**
 * Intercepts a window.fetch call for player responses.
 * Fails open: if anything fails, returns the original response unmodified.
 */
export async function handleFetchResponse(
  originalResponse: Response,
  urlStr: string,
  onEvent?: EventCallback,
  requestPayload?: any,
  alternateManager: AlternatePlayerManager = globalAlternatePlayer
): Promise<Response> {
  if (!isPlayerEndpoint(urlStr)) {
    return originalResponse;
  }

  onEvent?.({ type: "PLAYER_RESPONSE_SEEN" });

  // Only inspect successful responses
  if (!originalResponse.ok) {
    return originalResponse;
  }

  try {
    // Clone so the original stream is preserved if not modified
    const cloned = originalResponse.clone();
    const data = await cloned.json();

    const videoId = data?.videoDetails?.videoId || extractVideoId(urlStr, undefined, data);
    if (videoId) {
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RECEIVED", videoId);
    }

    // Step 2: Stop throwing away original ad information too early.
    // Privately inspect the response and calculate PrerollInfo before sanitization.
    const prerollInfo = detectPrerollInfo(data);
    if (videoId) {
      globalPlaybackTiming.setPrerollInfo(prerollInfo, videoId);
    }

    // Performance rule: if hasPreroll is false, add ZERO latency overhead!
    if (!prerollInfo.hasPreroll) {
      const { sanitized, report } = sanitizePlayerResponse(data);
      if (videoId) {
        globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
      }

      if (!report.changed) {
        return originalResponse;
      }

      onEvent?.({
        type: "PLAYER_RESPONSE_SANITIZED",
        removed: report.removed
      });

      return createSanitizedResponse(originalResponse, sanitized);
    }

    // Step 3: Player response substitution when preroll is detected
    const payload = requestPayload || extractPayloadFromInitOrData(undefined, undefined, data);
    let substituted = false;

    if (payload && videoId) {
      const alternateResult = await alternateManager.fetchCleanAlternateResponse(
        payload,
        videoId,
        800 // 800ms bounded race time budget
      );

      if (alternateResult) {
        const cleanMerged = mergeCleanPlaybackData(data, alternateResult.response);

        if (videoId) {
          globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
        }

        onEvent?.({
          type: "PLAYER_RESPONSE_SUBSTITUTED",
          candidateId: alternateResult.candidateId,
          videoId
        });

        onEvent?.({
          type: "PLAYER_RESPONSE_SANITIZED",
          removed: ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"]
        });

        substituted = true;
        return createSanitizedResponse(originalResponse, cleanMerged);
      }
    }

    // Step 14: Fallback to existing response sanitizer if substitution is unavailable or timed out
    if (!substituted) {
      const { sanitized, report } = sanitizePlayerResponse(data);
      if (videoId) {
        globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
      }

      if (report.changed) {
        onEvent?.({
          type: "PLAYER_RESPONSE_SANITIZED",
          removed: report.removed
        });
        return createSanitizedResponse(originalResponse, sanitized);
      }
    }

    return originalResponse;
  } catch (err) {
    // Fail-open: notify health monitor of error and return original untouched response
    onEvent?.({
      type: "ERROR",
      subsystem: "SANITIZER",
      message: err instanceof Error ? err.message : String(err)
    });
    return originalResponse;
  }
}

/**
 * Patches window.fetch defensively and idempotently.
 */
export function installFetchInterceptor(
  targetWindow: Window = window,
  onEvent?: EventCallback,
  alternateManager: AlternatePlayerManager = globalAlternatePlayer
): () => void {
  const installKey = Symbol.for("ytclean.fetch.installed");
  const win = targetWindow as unknown as Record<symbol, boolean>;

  if (win[installKey]) {
    // Already installed, idempotent no-op
    return () => {};
  }

  const originalFetch = targetWindow.fetch;
  const boundFetch = originalFetch.bind(targetWindow);

  // Wire unpatched nativeFetch into the alternate player manager
  alternateManager.setNativeFetch(boundFetch);

  const patchedFetch: typeof targetWindow.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // Section 18: Protection against recursion. Tagged internal calls bypass interceptor.
    if (isInternalFetch(input, init)) {
      return boundFetch(input, init);
    }

    const urlStr = extractUrlFromFetchInput(input);

    // Monitor media requests (videoplayback / googlevideo)
    if (isMediaEndpoint(urlStr)) {
      globalPlaybackTiming.monitorMediaRequest(urlStr, true);
      const response = await boundFetch(input, init);
      globalPlaybackTiming.monitorMediaRequest(urlStr, false);

      // Section 9: 403 / 401 / 410 detection on substituted media
      if (response.status === 401 || response.status === 403 || response.status === 410) {
        const activePreferred = alternateManager.getClientPool().getPreferredClient();
        if (activePreferred) {
          alternateManager.getClientPool().markFailure(activePreferred, "MEDIA_403");
        }
      }

      return response;
    }

    // Timing milestone: Player request started
    if (isPlayerEndpoint(urlStr)) {
      const videoId = extractVideoId(urlStr, init);
      if (videoId) {
        globalPlaybackTiming.startSession(videoId);
        globalPlaybackTiming.recordMilestone("PLAYER_REQUEST_STARTED", videoId);
      }
    }

    // Run original fetch with all original arguments intact
    const response = await boundFetch(input, init);

    const payload = extractPayloadFromInitOrData(init, input);
    return handleFetchResponse(response, urlStr, onEvent, payload, alternateManager);
  };

  targetWindow.fetch = patchedFetch;
  win[installKey] = true;

  // Teardown function
  return () => {
    targetWindow.fetch = originalFetch;
    delete win[installKey];
  };
}
