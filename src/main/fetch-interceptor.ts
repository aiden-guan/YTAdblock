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

function parsePlayerPayload(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;

  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Capture the actual JSON payload before native fetch consumes a Request body.
 *
 * YouTube may call fetch(new Request(...)) rather than fetch(url, { body }).
 * The previous implementation only inspected init.body, causing requestPayload
 * to be null and silently disabling alternate-player substitution for that path.
 */
export async function capturePlayerRequestPayload(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Record<string, unknown> | null> {
  if (typeof init?.body === "string") {
    return parsePlayerPayload(init.body);
  }

  if (
    !init?.body &&
    typeof Request !== "undefined" &&
    input instanceof Request &&
    !input.bodyUsed
  ) {
    try {
      return parsePlayerPayload(await input.clone().text());
    } catch {
      return null;
    }
  }

  return null;
}

export function extractPayloadFromInitOrData(
  init?: RequestInit,
  _input?: RequestInfo | URL,
  _data?: any
): Record<string, unknown> | null {
  return typeof init?.body === "string"
    ? parsePlayerPayload(init.body)
    : null;
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
    const parsed = parsePlayerPayload(init.body);
    if (typeof parsed?.videoId === "string") return parsed.videoId;
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

    if (prerollInfo.hasPreroll) {
      onEvent?.({ type: "PREROLL_DETECTED", videoId, source: "fetch" });
    } else {
      onEvent?.({
        type: "PREROLL_CLEARED",
        videoId,
        reason: "clean_response"
      });
    }

    const { report } = sanitizePlayerResponse(data);

    if (!report.changed) {
      if (videoId) {
        globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", videoId);
      }
      return originalResponse;
    }

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
          type: "PREROLL_CLEARED",
          videoId,
          reason: "substituted"
        });

        onEvent?.({
          type: "PLAYER_RESPONSE_SANITIZED",
          removed: report.removed
        });

        return createSanitizedResponse(originalResponse, cleanMerged);
      }
    }

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

    // Start cloning the body BEFORE native fetch consumes a Request object, but
    // do not delay the original YouTube request while the clone is being parsed.
    const payloadPromise = playerRequest
      ? capturePlayerRequestPayload(input, init)
      : Promise.resolve(null);

    if (playerRequest) {
      const videoId = extractVideoId(urlStr, init);
      if (videoId) {
        globalPlaybackTiming.startSession(videoId);
        globalPlaybackTiming.recordMilestone("PLAYER_REQUEST_STARTED", videoId);
      }
    }

    const response = await boundFetch(input, init);
    const payload = await payloadPromise;

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
