import { isPlayerEndpoint, isMediaEndpoint, extractVideoId } from "./fetch-interceptor";
import { sanitizePlayerResponse } from "./player-response";
import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import { globalAlternatePlayer } from "./alternate-player/alternate-player";
import type { BlockerEvent } from "../types/events";

export type XhrEventCallback = (event: BlockerEvent) => void;

/**
 * Narrowly-scoped XMLHttpRequest interceptor for YouTube player endpoints and media streams.
 * Only activates when open() is invoked with a targeted player endpoint or media stream URL.
 */
export function installXhrInterceptor(
  targetWindow: Window = window,
  onEvent?: XhrEventCallback
): () => void {
  const installKey = Symbol.for("ytclean.xhr.installed");
  const win = targetWindow as unknown as Record<symbol, boolean>;

  if (win[installKey]) {
    return () => {};
  }

  const OriginalXHR = (targetWindow as any).XMLHttpRequest as typeof XMLHttpRequest | undefined;
  if (!OriginalXHR) {
    return () => {};
  }

  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;
  const originalResponseTextDescriptor = Object.getOwnPropertyDescriptor(
    OriginalXHR.prototype,
    "responseText"
  );
  const originalResponseDescriptor = Object.getOwnPropertyDescriptor(
    OriginalXHR.prototype,
    "response"
  );

  OriginalXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    const urlStr = typeof url === "string" ? url : url.href;
    const isPlayer = isPlayerEndpoint(urlStr);
    const isMedia = isMediaEndpoint(urlStr);

    (this as any).__ytclean_is_player = isPlayer;
    (this as any).__ytclean_is_media = isMedia;
    (this as any).__ytclean_url = urlStr;

    if (isPlayer) {
      const videoId = extractVideoId(urlStr);
      (this as any).__ytclean_video_id = videoId;
      if (videoId) {
        globalPlaybackTiming.startSession(videoId);
      }

      let sanitizedCache: { text?: string; json?: unknown } | null = null;
      let hasSanitized = false;

      const computeSanitized = (xhr: XMLHttpRequest) => {
        if (hasSanitized) return sanitizedCache;
        if (xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) {
          return null;
        }

        hasSanitized = true;
        try {
          const rawText = originalResponseTextDescriptor?.get
            ? originalResponseTextDescriptor.get.call(xhr)
            : (xhr as any)._rawResponseText;

          if (rawText && typeof rawText === "string") {
            const parsed = JSON.parse(rawText);
            const resolvedVid = (xhr as any).__ytclean_video_id || parsed?.videoDetails?.videoId;

            globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RECEIVED", resolvedVid);

            const prerollInfo = detectPrerollInfo(parsed);
            globalPlaybackTiming.setPrerollInfo(prerollInfo, resolvedVid);

            const { sanitized, report } = sanitizePlayerResponse(parsed);

            globalPlaybackTiming.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", resolvedVid);

            if (report.changed) {
              const sanitizedText = JSON.stringify(sanitized);
              sanitizedCache = { text: sanitizedText, json: sanitized };
              onEvent?.({
                type: "PLAYER_RESPONSE_SANITIZED",
                removed: report.removed
              });
              return sanitizedCache;
            }
          }
        } catch (err) {
          onEvent?.({
            type: "ERROR",
            subsystem: "XHR_SANITIZER",
            message: err instanceof Error ? err.message : String(err)
          });
        }
        return null;
      };

      Object.defineProperty(this, "responseText", {
        configurable: true,
        get() {
          const cached = computeSanitized(this);
          if (cached?.text !== undefined) {
            return cached.text;
          }
          return originalResponseTextDescriptor?.get
            ? originalResponseTextDescriptor.get.call(this)
            : (this as any)._rawResponseText;
        }
      });

      Object.defineProperty(this, "response", {
        configurable: true,
        get() {
          const cached = computeSanitized(this);
          if (cached) {
            if (this.responseType === "json" && cached.json !== undefined) {
              return cached.json;
            }
            if ((this.responseType === "" || this.responseType === "text") && cached.text !== undefined) {
              return cached.text;
            }
          }
          return originalResponseDescriptor?.get
            ? originalResponseDescriptor.get.call(this)
            : (this as any)._rawResponse;
        }
      });
    }

    return (originalOpen as Function).apply(this, [method, url, ...rest]);
  };

  OriginalXHR.prototype.send = function (this: XMLHttpRequest, ...args: any[]) {
    if ((this as any).__ytclean_is_player) {
      onEvent?.({ type: "PLAYER_RESPONSE_SEEN" });
      const videoId = (this as any).__ytclean_video_id;
      globalPlaybackTiming.recordMilestone("PLAYER_REQUEST_STARTED", videoId);
    } else if ((this as any).__ytclean_is_media) {
      const urlStr = (this as any).__ytclean_url || "";
      globalPlaybackTiming.monitorMediaRequest(urlStr, true);

      this.addEventListener(
        "loadend",
        () => {
          globalPlaybackTiming.monitorMediaRequest(urlStr, false);
          if (this.status === 401 || this.status === 403 || this.status === 410) {
            const preferred = globalAlternatePlayer.getClientPool().getPreferredClient();
            if (preferred) {
              globalAlternatePlayer.getClientPool().markFailure(preferred, "MEDIA_403");
            }
          }
        },
        { once: true }
      );
    }

    return (originalSend as Function).apply(this, args);
  };

  win[installKey] = true;

  return () => {
    OriginalXHR.prototype.open = originalOpen;
    OriginalXHR.prototype.send = originalSend;
    delete win[installKey];
  };
}
