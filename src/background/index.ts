/**
 * YouTube Clean - Background Service Worker (Manifest V3)
 * Manages declarative net request rulesets and extension initialization.
 */

chrome.runtime.onInstalled.addListener(async () => {
  // Ensure default settings are initialized in local storage
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

  // Ensure declarativeNetRequest ruleset is active according to settings
  if (chrome.declarativeNetRequest) {
    try {
      const isEnabled = existing?.ytclean_settings?.protectionEnabled ?? true;
      if (isEnabled) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: ["ruleset_youtube"]
        });
      } else {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          disableRulesetIds: ["ruleset_youtube"]
        });
      }
    } catch {
      // Rule already enabled or handled by manifest
    }
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.ytclean_settings) {
    const newSettings = changes.ytclean_settings.newValue;
    if (newSettings && chrome.declarativeNetRequest) {
      if (newSettings.protectionEnabled) {
        chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: ["ruleset_youtube"]
        }).catch(() => {});
      } else {
        chrome.declarativeNetRequest.updateEnabledRulesets({
          disableRulesetIds: ["ruleset_youtube"]
        }).catch(() => {});
      }
    }
  }
});
