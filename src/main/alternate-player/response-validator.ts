/**
 * Alternate Player Response Validator.
 *
 * Ensures candidate responses are strictly valid, playable, clean of preroll ads,
 * and match the expected content video before any substitution occurs.
 *
 * Current YouTube increasingly uses server-driven ABR (SABR), so a valid
 * serverAbrStreamingUrl is an acceptable playback transport even when classic
 * formats/adaptiveFormats are sparse or absent.
 */

import { detectPrerollInfo } from "../preroll-detector";

export function validateAlternatePlayerResponse(
  response: unknown,
  expectedVideoId: string
): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return false;
  }

  const root = response as Record<string, unknown>;
  const candidate =
    root.playerResponse &&
    typeof root.playerResponse === "object" &&
    !Array.isArray(root.playerResponse)
      ? (root.playerResponse as Record<string, unknown>)
      : root;

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
