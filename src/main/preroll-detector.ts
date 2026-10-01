/**
 * Explicit preroll detector for YouTube player responses.
 *
 * Inspects explicit, verified YouTube ad structures (adPlacements, adSlots, playerAds)
 * to determine whether a response is ad-bound with prerolls, how many preroll ads exist,
 * and the estimated preroll duration before sanitization destroys this metadata.
 *
 * Strict constraint: NEVER use a recursive "anything containing ad" parser.
 * Only inspect explicit known schemas.
 */

export interface PrerollInfo {
  hasPreroll: boolean;
  estimatedDurationMs?: number;
  adCount?: number;
}

/**
 * Extracts preroll information from an unsanitized player response.
 */
export function detectPrerollInfo(input: unknown): PrerollInfo {
  const result: PrerollInfo = {
    hasPreroll: false,
    estimatedDurationMs: 0,
    adCount: 0
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return result;
  }

  const root = input as Record<string, unknown>;
  const candidate = (
    root.playerResponse &&
    typeof root.playerResponse === "object" &&
    !Array.isArray(root.playerResponse)
      ? (root.playerResponse as Record<string, unknown>)
      : root
  );

  let prerollCount = 0;
  let totalDurationMs = 0;
  let hasExplicitPreroll = false;

  // 1. Inspect adPlacements (most common in modern YouTube web player)
  if (Array.isArray(candidate.adPlacements)) {
    for (const placement of candidate.adPlacements) {
      if (!placement || typeof placement !== "object") continue;

      const renderer = placement.adPlacementRenderer || placement;
      const config = renderer.config || {};
      const timeOffset = config.adTimeOffset || {};

      // Check offset for preroll: offset "0", 0, or kind "AD_PLACEMENT_KIND_PREROLL"
      const offset = timeOffset.offset;
      const kind = timeOffset.kind;
      const isPreroll =
        offset === "0" ||
        offset === 0 ||
        kind === "AD_PLACEMENT_KIND_PREROLL" ||
        config.kind === "AD_PLACEMENT_KIND_PREROLL";

      if (isPreroll) {
        hasExplicitPreroll = true;
        prerollCount++;

        // Extract duration if present
        let foundDuration = false;
        const linearAds =
          renderer.renderer?.linearAdSequenceRenderer?.linearAds ||
          renderer.linearAdSequenceRenderer?.linearAds;

        if (Array.isArray(linearAds)) {
          for (const ad of linearAds) {
            const adRenderer = ad?.playerLinearAdRenderer || ad;
            const durationMs =
              adRenderer?.durationMilliseconds ||
              adRenderer?.adDurationMilliseconds;
            if (durationMs !== undefined) {
              const parsed = Number(durationMs);
              if (Number.isFinite(parsed) && parsed > 0) {
                totalDurationMs += parsed;
                foundDuration = true;
              }
            }
          }
        }

        if (!foundDuration && typeof renderer.durationMs === "number") {
          totalDurationMs += renderer.durationMs;
          foundDuration = true;
        }

        // If no explicit duration found on this preroll placement, add default estimate (15s)
        if (!foundDuration) {
          totalDurationMs += 15_000;
        }
      }
    }
  }

  // 2. Inspect adSlots
  if (Array.isArray(candidate.adSlots)) {
    for (const slot of candidate.adSlots) {
      if (!slot || typeof slot !== "object") continue;
      const slotRenderer = slot.adSlotRenderer || slot;

      // Slot type player byte or slotIdentifier slot-0 / preroll triggers
      const slotType = slotRenderer.adSlotType;
      const slotId = slotRenderer.slotIdentifier;
      const timeOffset = slotRenderer.adSlotTimeOffset;

      const isPrerollSlot =
        slotType === "SLOT_TYPE_PLAYER_BYTE" ||
        (typeof slotId === "string" && (slotId.includes("slot-0") || slotId.includes("preroll"))) ||
        timeOffset === 0 ||
        timeOffset === "0";

      if (isPrerollSlot && !hasExplicitPreroll) {
        hasExplicitPreroll = true;
        prerollCount = Math.max(prerollCount, 1);
        if (totalDurationMs === 0) {
          totalDurationMs = 15_000;
        }
      }
    }
  }

  // 3. Inspect playerAds (legacy player structure)
  if (Array.isArray(candidate.playerAds) && candidate.playerAds.length > 0) {
    if (!hasExplicitPreroll) {
      hasExplicitPreroll = true;
      prerollCount = Math.max(prerollCount, candidate.playerAds.length);
      if (totalDurationMs === 0) {
        totalDurationMs = 15_000 * candidate.playerAds.length;
      }
    }
  }

  result.hasPreroll = hasExplicitPreroll;
  result.adCount = prerollCount;
  result.estimatedDurationMs = hasExplicitPreroll ? totalDurationMs : 0;

  return result;
}
