import { isPlayerEndpoint, isMediaEndpoint, extractVideoId } from "./fetch-interceptor";
import { detectPrerollInfo } from "./preroll-detector";
import { globalPlaybackTiming } from "./playback-timing";
import { globalAlternatePlayer } from "./alternate-player/alternate-player";
import type { BlockerEvent } from "../types/events";

export type XhrEventCallback = (event: BlockerEvent) => void;

/**
 * Observe XHR-based player/media requests without rewriting player responses.
 *
 * We intentionally avoid stripping ad fields from XHR responses because doing so
 * while retaining the original ad-bound streaming session can trigger YouTube's
 * preroll-duration playback backoff. Fetch responses can use verified alternate
 * substitution; XHR falls back to rapid player-level ad completion.
 */
export function installXhrInterceptor(
  targetWindow: Window = window,
  onEvent?: XhrEventCallback
): () => void {
  const installKey = Symbol.for("ytclean.xhr.installed");
  const win = targetWindow as unknown as Record<symbol, boolean>;

  if (win[installKey]) return () => {};

  const OriginalXHR = (targetWindow as any).XMLHttpRequest as
    | typeof XMLHttpRequest
    | undefined;
  if (!OriginalXHR) return () => {};

  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

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
      if (videoId) globalPlaybackTiming.startSession(videoId);
    }

    return (originalOpen as Function).apply(this, [method, url, ...rest]);
  };

  OriginalXHR.prototype.send = function (this: XMLHttpRequest, ...args: any[]) {
    if ((this as any).__ytclean_is_player) {
      const videoId = (this as any).__ytclean_video_id;
      onEvent?.({ type: "PLAYER_RESPONSE_SEEN" });
      globalPlaybackTiming.recordMilestone("PLAYER_REQUEST_STARTED", videoId);

      if (typeof this.addEventListener === "function") this.addEventListener(
        "loadend",
        () => {
          try {
            if (this.status < 200 || this.status >= 300) return;

            let parsed: any = null;
            if (this.responseType === "json" && this.response && typeof this.response === "object") {
              parsed = this.response;
            } else if (
              (this.responseType === "" || this.responseType === "text") &&
              typeof this.responseText === "string" &&
              this.responseText
            ) {
              parsed = JSON.parse(this.responseText);
            }

            if (!parsed) return;

            const resolvedVideoId =
              videoId || parsed?.videoDetails?.videoId || undefined;

            globalPlaybackTiming.recordMilestone(
              "PLAYER_RESPONSE_RECEIVED",
              resolvedVideoId
            );
            globalPlaybackTiming.setPrerollInfo(
              detectPrerollInfo(parsed),
              resolvedVideoId
            );
            globalPlaybackTiming.recordMilestone(
              "PLAYER_RESPONSE_RETURNED_TO_YOUTUBE",
              resolvedVideoId
            );
          } catch {
            // Diagnostics are best-effort only. Never interfere with the response.
          }
        },
        { once: true }
      );
    } else if ((this as any).__ytclean_is_media) {
      const urlStr = (this as any).__ytclean_url || "";
      globalPlaybackTiming.monitorMediaRequest(urlStr, true);

      if (typeof this.addEventListener === "function") this.addEventListener(
        "loadend",
        () => {
          globalPlaybackTiming.monitorMediaRequest(urlStr, false);
          if (this.status === 401 || this.status === 403 || this.status === 410) {
            const preferred = globalAlternatePlayer
              .getClientPool()
              .getPreferredClient();
            if (preferred) {
              globalAlternatePlayer
                .getClientPool()
                .markFailure(preferred, `MEDIA_${this.status}`);
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
