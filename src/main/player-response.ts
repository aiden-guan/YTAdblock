import { KNOWN_PLAYER_AD_FIELDS } from "../config/youtube";
import type { SanitizerReport, SanitizerResult } from "../types/events";

/**
 * Pure, fail-open YouTube player response sanitizer.
 *
 * Requirements:
 * 1. Never mutate input object.
 * 2. Return a sanitized copy only when ad fields are removed.
 * 3. Preserve critical playback metadata (streamingData, videoDetails, etc.).
 * 4. Remove ONLY explicitly verified advertising structures from an allowlist.
 * 5. Fail open on any error, null, primitive, or unexpected schema.
 */
export function sanitizePlayerResponse(input: unknown): SanitizerResult {
  const emptyReport: SanitizerReport = { changed: false, removed: [] };

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { sanitized: input, report: emptyReport };
  }

  try {
    const candidate = input as Record<string, unknown>;
    const removed: string[] = [];

    // Check which known ad fields are present on the candidate
    for (const key of Object.keys(candidate)) {
      if (KNOWN_PLAYER_AD_FIELDS.has(key)) {
        removed.push(key);
      }
    }

    // Also check if candidate wraps playerResponse object: { playerResponse: { adPlacements: [...] } }
    let sanitizedNestedPlayerResponse: unknown = undefined;
    if (
      candidate.playerResponse &&
      typeof candidate.playerResponse === "object" &&
      !Array.isArray(candidate.playerResponse)
    ) {
      const nestedResult = sanitizePlayerResponse(candidate.playerResponse);
      if (nestedResult.report.changed) {
        sanitizedNestedPlayerResponse = nestedResult.sanitized;
        for (const item of nestedResult.report.removed) {
          removed.push(`playerResponse.${item}`);
        }
      }
    }

    if (removed.length === 0) {
      return { sanitized: input, report: emptyReport };
    }

    // Perform shallow clone without the removed ad keys to ensure zero mutation
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (key === "playerResponse" && sanitizedNestedPlayerResponse !== undefined) {
        copy[key] = sanitizedNestedPlayerResponse;
      } else if (!KNOWN_PLAYER_AD_FIELDS.has(key)) {
        copy[key] = value;
      }
    }

    return {
      sanitized: copy,
      report: {
        changed: true,
        removed
      }
    };
  } catch (_err) {
    // Fail-open: on any unforeseen parsing or structural error, return input untouched
    return {
      sanitized: input,
      report: emptyReport
    };
  }
}
