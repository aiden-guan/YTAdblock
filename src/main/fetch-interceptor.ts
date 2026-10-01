import { TARGET_PLAYER_PATHS } from "../config/youtube";
import { sanitizePlayerResponse } from "./player-response";
import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import {
  globalAlternatePlayer,
  AlternatePlayerManager,
  type OriginalPlayerRequestContext
} from "./alternate-player/alternate-player";
import { mergeCleanPlaybackData } from "./alternate-player/response-merger";
import type { BlockerEvent } from "../types/events";

export type EventCallback = (event: BlockerEvent) => void;

export function isPlayerEndpoint(urlStr: string): boolean {
  try {
    const url = new URL(urlStr, "https://www.youtube.com");
    return TARGET_PLAYER_PATHS.some((path) => url.pathname.includes(path));
  } catch {
    return false;
  }
}

export function isMediaEndpoint(urlStr: string): boolean {
  return urlStr.includes("/videoplayback") || urlStr.includes("googlevideo.com");
}

/**
 * Retained for compatibility/tests. Internal alternate requests use the captured
 * native fetch directly, so no marker header is required in production.
 */
export function isInternalFetch(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = new Headers(
    init?.headers ||
      (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined)
  );
  return headers.get("X-YTClean-Internal") === "1";
}

export function extractUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    return (input as Request).url;
  }
  return String(input);
}

export function extractPayloadFromInitOrData(
  init?: RequestInit,
  _input?: RequestInfo | URL,
  data?: any
): Record<string, unknown> | null {
  if (init?.body && typeof init.body === "string") {
    try {
      return JSON.parse(init.body);
    } catch {
      // Ignore malformed request bodies.
    }
  }

  if (data?.videoDetails?.videoId) {
    return {
      videoId: data.videoDetails.videoId,
      context: {
        client: {
          clientName: "WEB"
        }
      }
    };
  }

  return null;
}

export function extractVideoId(
  urlStr: string,
  init?: RequestInit,
  data?: any
): string | undefined {
  if (data?.videoDetails?.videoId) return data.videoDetails.videoId;

  try {
    const url = new URL(urlStr, "https://www.youtube.com");
    const fromUrl = url.searchParams.get("v") || url.searchParams.get("videoId");
    if (fromUrl) return fromUrl;
  } catch {
    // Ignore malformed URL.
  }

  if (init?.body && typeof init.body === "string") {
    try {
      const parsed = JSON.parse(init.body);
      if (parsed.videoId) return parsed.videoId;
    } catch {
      // Ignore malformed body.
    }
  }

  return undefined;
}

export function createSanitizedResponse(
  originalResponse: Response,
  sanitizedJson: unknown
): Response {
  const jsonString = JSON.stringify(sanitizedJson);
  const newHeaders = new Headers(originalResponse.headers);
  newHeaders.delete("content-length");
  newHeaders.set("content-type", "application/json; charset=utf-8");

  const replacement = new Response(jsonString, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: newHeaders
  });

  return new Proxy(replacement, {
    get(target, prop) {
      if (prop === "url") return originalResponse.url || target.url;
      if (prop === "redirected") return originalResponse.redirected ?? target.redirected;
      if (prop === "type") return originalResponse.type || target.type;
      if (prop === "clone") {
        return () => {
          if (target.bodyUsed) return target.clone();
          return createSanitizedResponse(originalResponse, sanitizedJson);
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export function snapshotPlayerRequestContext(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  targetWindow: Window = window
): OriginalPlayerRequestContext {
  const rawUrl = extractUrlFromFetchInput(input);
  let url = rawUrl;

  try {
    url = new URL(rawUrl, targetWindow.location?.href || "https://www.youtube.com").href;
  } catch {
    // Keep original string if URL normalization fails.
  }

  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined
  );

  if (init?.headers) {
    const overlay = new Headers(init.headers);
    overlay.forEach((value, key) => headers.set(key, value));
  }

  const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;

  return {
    url,
    headers,
    credentials: init?.credentials ?? request?.credentials ?? "same-origin",
    referrer: (init?.referrer ?? request?.referrer) || targetWindow.location?.href,
    referrerPolicy: init?.referrerPolicy ?? request?.referrerPolicy
  };
}

/**
 * Handle a completed YouTube player response.
 *
 * Critical behavior:
 * - A verified clean alternate response may replace ad-bound streamingData.
 * - If no clean alternate is available, DO NOT strip ad metadata from the
 *   ad-bound response. Stripping it while retaining the original stream session
 *   is what triggers YouTube's preroll-length backoff.
 * - In that failure case we return the original response so the DOM fallback can
 *   immediately finish the real ad state (mute/seek/skip) instead of waiting.
 */
export async function handleFetchResponse(
  originalResponse: Response,
  urlStr: string,
  onEvent?: EventCallback,
  requestPayload?: any,
  alternateManager: AlternatePlayerManager = globalAlternatePlayer,
  requestContext?: OriginalPlayerRequestContext
): Promise<Response> {
  if (!isPlayerEndpoint(urlStr)) return originalResponse;

  onEvent?.({ type: "PLAYER_RESPONSE_SEEN" });

  if (!originalResponse.ok) return originalResponse;

  try {
    const data = await originalResponse.clone().json();
    const videoId = data?.videoDetails?.videoId || extractVideoId(urlStr, undefined, data);

    if (videoId) {
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RECEIVED", videoId);
    }

    const prerollInfo = detectPrerollInfo(data);
    if (videoId) globalPlaybackTiming.setPrerollInfo(prerollInfo, videoId);

    const { report } = sanitizePlayerResponse(data);

    // Truly clean response: no rewrite and no latency.
    if (!report.changed) {
      if (videoId) {
        globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
      }
      return originalResponse;
    }

    // For prerolls, attempt a clean stream substitution using the exact original
    // request URL / API key / browser session headers. Direct unit callers may
    // omit requestContext; production interception always supplies the real one.
    const effectiveRequestContext: OriginalPlayerRequestContext = requestContext ?? {
      url: new URL(urlStr, "https://www.youtube.com").href
    };

    if (prerollInfo.hasPreroll && requestPayload && videoId) {
      const alternateResult = await alternateManager.fetchCleanAlternateResponse(
        requestPayload,
        videoId,
        effectiveRequestContext,
        1200
      );

      if (alternateResult) {
        const cleanMerged = mergeCleanPlaybackData(data, alternateResult.response);

        globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);

        onEvent?.({
          type: "PLAYER_RESPONSE_SUBSTITUTED",
          candidateId: alternateResult.candidateId,
          videoId
        });

        onEvent?.({
          type: "PLAYER_RESPONSE_SANITIZED",
          removed: report.removed
        });

        return createSanitizedResponse(originalResponse, cleanMerged);
      }
    }

    // IMPORTANT: do not sanitize the original ad-bound session on failure.
    // Let YouTube initialize the ad stream and let the player fallback terminate
    // it immediately. This avoids the full-duration blocked-preroll backoff.
    if (videoId) {
      globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
    }

    return originalResponse;
  } catch (err) {
    onEvent?.({
      type: "ERROR",
      subsystem: "SANITIZER",
      message: err instanceof Error ? err.message : String(err)
    });
    return originalResponse;
  }
}

export function installFetchInterceptor(
  targetWindow: Window = window,
  onEvent?: EventCallback,
  alternateManager: AlternatePlayerManager = globalAlternatePlayer
): () => void {
  const installKey = Symbol.for("ytclean.fetch.installed");
  const win = targetWindow as unknown as Record<symbol, boolean>;

  if (win[installKey]) return () => {};

  const originalFetch = targetWindow.fetch;
  const boundFetch = originalFetch.bind(targetWindow);
  alternateManager.setNativeFetch(boundFetch);

  const patchedFetch: typeof targetWindow.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    if (isInternalFetch(input, init)) {
      return boundFetch(input, init);
    }

    const urlStr = extractUrlFromFetchInput(input);

    if (isMediaEndpoint(urlStr)) {
      globalPlaybackTiming.monitorMediaRequest(urlStr, true);
      const response = await boundFetch(input, init);
      globalPlaybackTiming.monitorMediaRequest(urlStr, false);

      if (response.status === 401 || response.status === 403 || response.status === 410) {
        const activePreferred = alternateManager.getClientPool().getPreferredClient();
        if (activePreferred) {
          alternateManager.getClientPool().markFailure(
            activePreferred,
            `MEDIA_${response.status}`
          );
        }
      }

      return response;
    }

    const playerRequest = isPlayerEndpoint(urlStr);
    const requestContext = playerRequest
      ? snapshotPlayerRequestContext(input, init, targetWindow)
      : undefined;

    if (playerRequest) {
      const videoId = extractVideoId(urlStr, init);
      if (videoId) {
        globalPlaybackTiming.startSession(videoId);
        globalPlaybackTiming.recordMilestone("PLAYER_REQUEST_STARTED", videoId);
      }
    }

    const response = await boundFetch(input, init);

    const payload = extractPayloadFromInitOrData(init, input);
    return handleFetchResponse(
      response,
      urlStr,
      onEvent,
      payload,
      alternateManager,
      requestContext
    );
  };

  targetWindow.fetch = patchedFetch;
  win[installKey] = true;

  return () => {
    targetWindow.fetch = originalFetch;
    delete win[installKey];
  };
}
