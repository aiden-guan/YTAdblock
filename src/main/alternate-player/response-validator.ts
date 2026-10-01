/**
 * Alternate Player Response Validator.
 *
 * Structural validation answers "is this a clean player response?".
 * Substitution additionally requires a media URL that can be probed before we
 * hand the response to YouTube. A structurally valid SABR-only response is not
 * sufficient evidence that the normal WEB player can consume that session.
 */

import { detectPrerollInfo } from "../preroll-detector";

function unwrapPlayerResponse(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }

  const root = response as Record<string, unknown>;
  if (
    root.playerResponse &&
    typeof root.playerResponse === "object" &&
    !Array.isArray(root.playerResponse)
  ) {
    return root.playerResponse as Record<string, unknown>;
  }

  return root;
}

export function validateAlternatePlayerResponse(
  response: unknown,
  expectedVideoId: string
): boolean {
  const candidate = unwrapPlayerResponse(response);
  if (!candidate) return false;

  const videoDetails = candidate.videoDetails as Record<string, unknown> | undefined;
  if (!videoDetails || typeof videoDetails !== "object") return false;
  if (videoDetails.videoId !== expectedVideoId) return false;

  const playabilityStatus = candidate.playabilityStatus as
    | Record<string, unknown>
    | undefined;
  if (!playabilityStatus || playabilityStatus.status !== "OK") return false;

  const streamingData = candidate.streamingData as Record<string, unknown> | undefined;
  if (!streamingData || typeof streamingData !== "object") return false;

  const hasStandardFormats =
    Array.isArray(streamingData.formats) && streamingData.formats.length > 0;
  const hasAdaptiveFormats =
    Array.isArray(streamingData.adaptiveFormats) &&
    streamingData.adaptiveFormats.length > 0;
  const hasHlsManifest =
    typeof streamingData.hlsManifestUrl === "string" &&
    streamingData.hlsManifestUrl.length > 0;
  const hasDashManifest =
    typeof streamingData.dashManifestUrl === "string" &&
    streamingData.dashManifestUrl.length > 0;
  const hasServerAbr =
    typeof streamingData.serverAbrStreamingUrl === "string" &&
    streamingData.serverAbrStreamingUrl.length > 0;

  if (
    !hasStandardFormats &&
    !hasAdaptiveFormats &&
    !hasHlsManifest &&
    !hasDashManifest &&
    !hasServerAbr
  ) {
    return false;
  }

  if (detectPrerollInfo(candidate).hasPreroll) return false;

  if (videoDetails.lengthSeconds !== undefined) {
    const length = Number(videoDetails.lengthSeconds);
    if (!Number.isFinite(length) || length < 0) return false;
  }

  return true;
}

export function isAllowedMediaProbeUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();
    return (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "googlevideo.com" ||
      host.endsWith(".googlevideo.com")
    );
  } catch {
    return false;
  }
}

/**
 * Return a transport we can cheaply verify before substitution.
 *
 * Prefer muxed/direct formats, then adaptive direct formats, then manifests.
 * Deliberately DO NOT return serverAbrStreamingUrl: SABR can be structurally
 * present yet unusable when transplanted between player-client sessions, which
 * is the buffering failure this guard is designed to prevent.
 */
export function extractProbeableMediaUrl(response: unknown): string | null {
  const candidate = unwrapPlayerResponse(response);
  if (!candidate) return null;

  const streamingData = candidate.streamingData as Record<string, unknown> | undefined;
  if (!streamingData || typeof streamingData !== "object") return null;

  const formatGroups = [streamingData.formats, streamingData.adaptiveFormats];

  for (const group of formatGroups) {
    if (!Array.isArray(group)) continue;

    for (const entry of group) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const url = (entry as Record<string, unknown>).url;
      if (typeof url === "string" && isAllowedMediaProbeUrl(url)) {
        return url;
      }
    }
  }

  for (const manifestKey of ["hlsManifestUrl", "dashManifestUrl"] as const) {
    const manifestUrl = streamingData[manifestKey];
    if (
      typeof manifestUrl === "string" &&
      isAllowedMediaProbeUrl(manifestUrl)
    ) {
      return manifestUrl;
    }
  }

  return null;
}
