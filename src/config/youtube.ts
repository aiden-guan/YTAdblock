/**
 * Centralized, volatile configuration for YouTube endpoints, selectors,
 * ad fields, and runtime constants.
 */

/**
 * Endpoints targeted for player-response sanitization.
 * Only exact or prefix matches against the pathname are inspected.
 */
export const TARGET_PLAYER_PATHS = [
  "/youtubei/v1/player"
] as const;

/**
 * Verified top-level advertising fields in player API responses.
 * Strictly allowlisted: never blindly delete arbitrary keys.
 */
export const KNOWN_PLAYER_AD_FIELDS = new Set<string>([
  "adPlacements",
  "playerAds",
  "adSlots",
  "adBreakHeartbeatParams",
  "adBreakParams"
]);

/**
 * Legitimate player metadata fields that MUST NEVER be removed.
 */
export const ESSENTIAL_PLAYER_FIELDS = [
  "streamingData",
  "videoDetails",
  "captions",
  "playabilityStatus",
  "microformat",
  "playbackTracking"
] as const;

/**
 * Selectors for YouTube player ad-skip buttons.
 * Checked in order of appearance in modern vs classic players.
 */
export const SKIP_SELECTORS = [
  ".ytp-skip-ad-button",
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
  "button.ytp-ad-skip-button",
  ".ytp-ad-skip-button-text",
  "[id^='skip-button:']",
  ".ytp-ad-overlay-close-button",
  "button.ytp-ad-overlay-close-button"
] as const;

/**
 * Ad container elements within the YouTube player module.
 */
export const AD_CONTAINER_SELECTORS = [
  ".video-ads",
  ".ytp-ad-module",
  ".ytp-ad-player-overlay",
  ".ytp-ad-player-overlay-flyout-cta",
  ".ytp-ad-overlay-container",
  ".ytp-ad-text",
  ".ytp-ad-preview-container",
  ".ytp-ad-duration-remaining"
] as const;

/**
 * Selectors for verified promoted/advertising DOM elements outside the player.
 * Used for cosmetic filtering and ad-slot suppression.
 */
export const PROMOTED_SELECTORS = [
  "ytd-ad-slot-renderer",
  "ytd-display-ad-renderer",
  "ytd-promoted-sparkles-web-renderer",
  "ytd-promoted-video-renderer",
  "ytd-in-feed-ad-layout-renderer",
  "ytd-banner-promo-renderer",
  "ytd-statement-banner-renderer",
  "ytd-action-companion-ad-renderer",
  "#masthead-ad",
  "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)",
  "ytd-rich-section-renderer:has(ytd-ad-slot-renderer)"
] as const;

/**
 * YouTube SPA lifecycle events.
 */
export const NAVIGATION_EVENTS = [
  "yt-navigate-start",
  "yt-navigate-finish",
  "yt-page-data-updated",
  "spfdone",
  "popstate"
] as const;

/**
 * Selectors for anti-adblock warning / enforcement dialogs.
 */
export const ANTI_ADBLOCK_DIALOG_SELECTORS = [
  "ytd-enforcement-message-view-model",
  "tp-yt-paper-dialog:has(#feedback.ytd-enforcement-message-view-model)",
  ".yt-playability-error-supported-renderers"
] as const;

/**
 * Known anti-adblock text signatures.
 */
export const ANTI_ADBLOCK_TEXT_PATTERNS = [
  /ad blockers violate youtube's terms of service/i,
  /ad blockers are not allowed on youtube/i,
  /it looks like you may be using an ad blocker/i,
  /allow ads on youtube/i,
  /unblock ads/i,
  /ad blocker detected/i
];

export const COSMETIC_ATTRIBUTE_DISABLED = "ytclean-cosmetic-disabled";

/**
 * Non-colliding global flags and event bridge names.
 */
export const GLOBAL_INSTALL_KEY = Symbol.for("ytclean.installed");
export const BRIDGE_EVENT_MAIN_TO_ISOLATED = "ytclean:main-event";
export const BRIDGE_EVENT_ISOLATED_TO_MAIN = "ytclean:isolated-command";

/**
 * Health monitor thresholds.
 */
export const HEALTH_CONFIG = {
  maxErrorsInWindow: 3,
  windowDurationMs: 30_000,
  maxLogRingBufferSize: 200
} as const;
