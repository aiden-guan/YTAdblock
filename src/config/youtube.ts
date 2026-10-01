/**
 * Centralized, volatile configuration for YouTube endpoints, selectors,
 * ad fields, and runtime constants.
 */

export const TARGET_PLAYER_PATHS = [
  "/youtubei/v1/player"
] as const;

export const KNOWN_PLAYER_AD_FIELDS = new Set<string>([
  "adPlacements",
  "playerAds",
  "adSlots",
  "adBreakHeartbeatParams",
  "adBreakParams"
]);

export const ESSENTIAL_PLAYER_FIELDS = [
  "streamingData",
  "videoDetails",
  "captions",
  "playabilityStatus",
  "microformat",
  "playbackTracking"
] as const;

/**
 * Current + legacy YouTube skip controls.
 *
 * The slot/container selectors matter because YouTube A/B tests the internal
 * button class. Semantic aria-label selectors are kept inside the player only.
 */
export const SKIP_SELECTORS = [
  ".ytp-skip-ad-button",
  ".ytp-skip-ad-button-modern",
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button-slot button",
  ".ytp-ad-skip-button-container button",
  "button.ytp-ad-skip-button",
  ".ytp-ad-skip-button-text",
  "[id^='skip-button:']",
  "button[aria-label^='Skip ad']",
  "button[aria-label='Skip']",
  "[role='button'][aria-label^='Skip ad']",
  ".ytp-ad-overlay-close-button",
  "button.ytp-ad-overlay-close-button"
] as const;

/**
 * Verified player-ad UI surfaces. These are detection signals, not blanket
 * document selectors, and are queried only inside #movie_player.
 */
export const AD_CONTAINER_SELECTORS = [
  ".video-ads",
  ".ytp-ad-module",
  ".ytp-ad-player-overlay",
  ".ytp-ad-player-overlay-flyout-cta",
  ".ytp-ad-overlay-container",
  ".ytp-ad-text",
  ".ytp-ad-preview-container",
  ".ytp-ad-duration-remaining",
  ".ytp-ad-progress",
  ".ytp-ad-progress-list",
  ".ytp-ad-skip-button-container",
  ".ytp-ad-skip-button-slot",
  ".ytp-visit-advertiser-link",
  ".ytp-visit-advertiser-link__text"
] as const;

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

export const NAVIGATION_EVENTS = [
  "yt-navigate-start",
  "yt-navigate-finish",
  "yt-page-data-updated",
  "spfdone",
  "popstate"
] as const;

export const ANTI_ADBLOCK_DIALOG_SELECTORS = [
  "ytd-enforcement-message-view-model",
  "tp-yt-paper-dialog:has(#feedback.ytd-enforcement-message-view-model)",
  ".yt-playability-error-supported-renderers"
] as const;

export const ANTI_ADBLOCK_TEXT_PATTERNS = [
  /ad blockers violate youtube's terms of service/i,
  /ad blockers are not allowed on youtube/i,
  /it looks like you may be using an ad blocker/i,
  /allow ads on youtube/i,
  /unblock ads/i,
  /ad blocker detected/i
];

export const COSMETIC_ATTRIBUTE_DISABLED = "ytclean-cosmetic-disabled";

export const GLOBAL_INSTALL_KEY = Symbol.for("ytclean.installed");
export const BRIDGE_EVENT_MAIN_TO_ISOLATED = "ytclean:main-event";
export const BRIDGE_EVENT_ISOLATED_TO_MAIN = "ytclean:isolated-command";

export const HEALTH_CONFIG = {
  maxErrorsInWindow: 3,
  windowDurationMs: 30_000,
  maxLogRingBufferSize: 200
} as const;
