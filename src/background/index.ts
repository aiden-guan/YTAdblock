/**
 * YouTube Clean - Background Service Worker (Manifest V3)
 *
 * Initializes local settings only. Network-level DNR blocking is intentionally
 * not used: blocking YouTube ad/heartbeat requests can leave the player in an
 * ad-bound session and cause the full preroll-duration backoff this extension is
 * designed to avoid.
 */

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["ytclean_settings"]);

  if (!existing || !existing.ytclean_settings) {
    await chrome.storage.local.set({
      ytclean_settings: {
        protectionEnabled: true,
        cosmeticFilteringEnabled: true,
        debugLoggingEnabled: false
      }
    });
  }
});
