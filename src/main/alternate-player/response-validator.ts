/**
 * Alternate Player Response Validator.
 *
 * Ensures candidate responses are strictly valid, playable, clean of preroll ads,
 * and match the expected content video before any substitution occurs.
 *
 * Fail-safe principle: NEVER substitute an invalid or unplayable response.
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
  const candidate = (
    root.playerResponse &&
    typeof root.playerResponse === "object" &&
    !Array.isArray(root.playerResponse)
      ? (root.playerResponse as Record<string, unknown>)
      : root
  );

  // 1. videoDetails and expectedVideoId match
  const videoDetails = candidate.videoDetails as Record<string, unknown> | undefined;
  if (!videoDetails || typeof videoDetails !== "object") {
    return false;
  }
  if (videoDetails.videoId !== expectedVideoId) {
    return false;
  }

  // 2. Playability status must be "OK"
  const playabilityStatus = candidate.playabilityStatus as Record<string, unknown> | undefined;
  if (!playabilityStatus || typeof playabilityStatus !== "object") {
    return false;
  }
  const status = playabilityStatus.status;
  if (status !== "OK") {
    return false; // Rejects LOGIN_REQUIRED, AGE_CHECK_REQUIRED, UNPLAYABLE, ERROR, etc.
  }

  // 3. Streaming data must be present with valid playback formats
  const streamingData = candidate.streamingData as Record<string, unknown> | undefined;
  if (!streamingData || typeof streamingData !== "object") {
    return false;
  }

  const hasStandardFormats =
    Array.isArray(streamingData.formats) && streamingData.formats.length > 0;
  const hasAdaptiveFormats =
    Array.isArray(streamingData.adaptiveFormats) && streamingData.adaptiveFormats.length > 0;
  const hasHlsManifest =
    typeof streamingData.hlsManifestUrl === "string" && streamingData.hlsManifestUrl.length > 0;

  if (!hasStandardFormats && !hasAdaptiveFormats && !hasHlsManifest) {
    return false;
  }

  // 4. Must NOT contain obvious preroll ad structures
  const prerollInfo = detectPrerollInfo(candidate);
  if (prerollInfo.hasPreroll) {
    return false;
  }

  // 5. Video duration must be consistent / positive
  if (videoDetails.lengthSeconds !== undefined) {
    const length = Number(videoDetails.lengthSeconds);
    if (!Number.isFinite(length) || length < 0) {
      return false;
    }
  }

  return true;
}
