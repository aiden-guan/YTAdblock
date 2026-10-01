import { TARGET_PLAYER_PATHS } from "../config/youtube";
import { sanitizePlayerResponse } from "./player-response";
import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import {
  globalAlternatePlayer,
  AlternatePlayerManager,
  type PlayerRequestSnapshot
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
 * Kept for compatibility with older builds/tests. The production alternate
 * request path no longer needs to send a custom marker to YouTube because it
 * uses the unpatched native fetch captured before interception.
 */
export function isInternalFetch(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers) {
    const headers = new Headers(init.headers);
    if (headers.get("X-YTClean-Internal") === "1") return true;
  }
  if (input && typeof input === "object" && "headers" in input) {
    const req = input as Request;
    if (req.headers?.get("X-YTClean-Internal") === "1") return true;
  }
  return false;
}

export function extractUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    return (input as Request).url;
  }
  return String(input);
}

function parseJsonBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

/**
 * Capture the real player request before native fetch consumes a Request body.
 * This is what allows the alternate client request to preserve the original API
 * key, visitor data, auth/session headers and credentials.
 */
export async function capturePlayerRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  urlStr: string
): Promise<PlayerRequestSnapshot | null> {
  try {
    const requestObject =
      typeof Request !== "undefined" && input instanceof Request ? input : null;

    const headers = new Headers(requestObject?.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    let bodyText: string | undefined;
    if (typeof init?.body === "string") {
      bodyText = init.body;
    } else if (!init?.body && requestObject && !requestObject.bodyUsed) {
      try {
        bodyText = await requestObject.clone().text();
      } catch {
        // Fail open: request may have a non-clonable/locked body.
      }
    }

    const payload = parseJsonBody(bodyText);
    if (!payload) return null;

    const credentials =
      init?.credentials ??
      requestObject?.credentials ??
      "same-origin";

    return {
      url: urlStr,
      payload,
      headers: Array.from(headers.entries()),
      credentials
    };
  } catch {
    return null;
  }
}

/**
 * Backwards-compatible helper retained for tests and callers that already have
 * the body. It deliberately does NOT fabricate a stale WEB context from a
 * response anymore.
 */
export function extractPayloadFromInitOrData(
  init?: RequestInit,
  _input?: RequestInfo | URL,
  data?: any
): Record<string, unknown> | null {
  if (init?.body && typeof init.body === "string") {
    return parseJsonBody(init.body);
  }
  if (data?.videoDetails?.videoId) {
    return { videoId: data.videoDetails.videoId };
  }
  return null;
}

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
  } catch {
    // Ignore malformed URL.
  }
  if (init?.body && typeof init.body === "string") {
    const parsed = parseJsonBody(init.body);
    const videoId = parsed?.videoId;
    if (typeof videoId === "string") return videoId;
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
      if (prop === "redirected") {
        return originalResponse.redirected ?? target.redirected;
      }
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

export async function handleFetchResponse(
  originalResponse: Response,
  urlStr: string,
  onEvent?: EventCallback,
  requestContext?: PlayerRequestSnapshot | Record<string, unknown> | null,
  alternateManager: AlternatePlayerManager = globalAlternatePlayer
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
    if (videoId) {
      globalPlaybackTiming.setPrerollInfo(prerollInfo, videoId);
    }

    if (!prerollInfo.hasPreroll) {
      const { sanitized, report } = sanitizePlayerResponse(data);
      if (videoId) {
        globalPlaybackTiming.recordMilestone(
          "PLAYER_RESPONSE_RETURNED_TO_YOUTUBE",
          videoId
        );
      }

      if (!report.changed) return originalResponse;

      onEvent?.({
        type: "PLAYER_RESPONSE_SANITIZED",
        removed: report.removed
      });

      return createSanitizedResponse(originalResponse, sanitized);
    }

    /**
     * For a preroll response, substitution is all-or-nothing.
     *
     * Previous behavior deleted ad metadata even when no clean alternate stream
     * had been obtained. Current YouTube can then keep the content media session
     * in preroll backoff, producing the exact "blank wait for the ad duration"
     * failure this extension is trying to avoid.
     *
     * If substitution fails, return the ORIGINAL ad-bound response intact and
     * let the DOM fallback immediately skip/seek/accelerate the real ad. That is
     * dramatically safer than manufacturing an incomplete player state.
     */
    if (requestContext && videoId) {
      const alternateResult =
        await alternateManager.fetchCleanAlternateResponse(
          requestContext,
          videoId,
          1200
        );

      if (alternateResult) {
        const cleanMerged = mergeCleanPlaybackData(
          data,
          alternateResult.response
        );

        globalPlaybackTiming.recordMilestone(
          "PLAYER_RESPONSE_RETURNED_TO_YOUTUBE",
          videoId
        );

        onEvent?.({
          type: "PLAYER_RESPONSE_SUBSTITUTED",
          candidateId: alternateResult.candidateId,
          videoId
        });

        onEvent?.({
          type: "PLAYER_RESPONSE_SANITIZED",
          removed: [
            "adPlacements",
            "playerAds",
            "adSlots",
            "adBreakHeartbeatParams"
          ]
        });

        return createSanitizedResponse(originalResponse, cleanMerged);
      }
    }

    if (videoId) {
      globalPlaybackTiming.recordMilestone(
        "PLAYER_RESPONSE_RETURNED_TO_YOUTUBE",
        videoId
      );
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

      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 410
      ) {
        const activePreferred =
          alternateManager.getClientPool().getPreferredClient();
        if (activePreferred) {
          alternateManager
            .getClientPool()
            .markFailure(activePreferred, `MEDIA_${response.status}`);
        }
      }

      return response;
    }

    const playerRequest = isPlayerEndpoint(urlStr);
    const requestSnapshotPromise = playerRequest
      ? capturePlayerRequest(input, init, urlStr)
      : Promise.resolve(null);

    if (playerRequest) {
      const videoId = extractVideoId(urlStr, init);
      if (videoId) {
        globalPlaybackTiming.startSession(videoId);
        globalPlaybackTiming.recordMilestone("PLAYER_REQUEST_STARTED", videoId);
      }
    }

    const response = await boundFetch(input, init);
    const requestSnapshot = await requestSnapshotPromise;

    return handleFetchResponse(
      response,
      urlStr,
      onEvent,
      requestSnapshot,
      alternateManager
    );
  };

  targetWindow.fetch = patchedFetch;
  win[installKey] = true;

  return () => {
    targetWindow.fetch = originalFetch;
    delete win[installKey];
  };
}
