/**
 * Surgical Response Merger.
 *
 * Merges clean playback data (streamingData) from a validated alternate player response
 * into the primary WEB player response, preserving YouTube-specific page metadata
 * (captions, microformat, storyboards, annotations, metadata, and tracking)
 * while eliminating ad-bound advertising structures.
 *
 * Strict requirements:
 * 1. Never mutate input objects.
 * 2. Maintain stream session consistency.
 * 3. Preserve critical page-level player components.
 */

import { KNOWN_PLAYER_AD_FIELDS } from "../../config/youtube";

export function mergeCleanPlaybackData(
  originalWebResponse: unknown,
  alternateResponse: unknown
): unknown {
  if (
    !originalWebResponse ||
    typeof originalWebResponse !== "object" ||
    Array.isArray(originalWebResponse)
  ) {
    return originalWebResponse;
  }

  if (
    !alternateResponse ||
    typeof alternateResponse !== "object" ||
    Array.isArray(alternateResponse)
  ) {
    return originalWebResponse;
  }

  try {
    const originalRoot = originalWebResponse as Record<string, unknown>;
    const alternateRoot = alternateResponse as Record<string, unknown>;

    // Extract clean streamingData from alternate response
    const cleanStreamingData = (
      alternateRoot.streamingData ||
      (alternateRoot.playerResponse as any)?.streamingData
    );

    if (!cleanStreamingData) {
      return originalWebResponse;
    }

    // Helper to sanitize and merge an object level
    const mergeObject = (orig: Record<string, unknown>, cleanStream: unknown): Record<string, unknown> => {
      const copy: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(orig)) {
        if (KNOWN_PLAYER_AD_FIELDS.has(key)) {
          // Exclude ad fields
          continue;
        }

        if (key === "streamingData") {
          // Substitute clean streaming data
          copy[key] = cleanStream;
        } else if (key === "playerResponse" && value && typeof value === "object" && !Array.isArray(value)) {
          // Recursively merge nested playerResponse
          copy[key] = mergeObject(value as Record<string, unknown>, cleanStream);
        } else {
          copy[key] = value;
        }
      }

      // Ensure clean streamingData is attached if not already present
      if (!copy.streamingData) {
        copy.streamingData = cleanStream;
      }

      return copy;
    };

    return mergeObject(originalRoot, cleanStreamingData);
  } catch (_err) {
    // Fail-open: return original untouched on unforeseen error
    return originalWebResponse;
  }
}
