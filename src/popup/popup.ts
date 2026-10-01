import type {
  TelemetryCounters,
  ExtensionSettings,
  DiagnosticsExportReport
} from "../types/events";
import { DEFAULT_SETTINGS, DEFAULT_COUNTERS } from "../types/events";

document.addEventListener("DOMContentLoaded", async () => {
  const badgeEl = document.getElementById("protection-badge") as HTMLElement;
  const countCleanedEl = document.getElementById("count-cleaned") as HTMLElement;
  const countFallbackEl = document.getElementById("count-fallback") as HTMLElement;
  const countCosmeticEl = document.getElementById("count-cosmetic") as HTMLElement;
  const statusEl = document.getElementById("system-status") as HTMLElement;
  const toggleProtectionBtn = document.getElementById("toggle-protection") as HTMLButtonElement;
  const checkCosmetic = document.getElementById("check-cosmetic") as HTMLInputElement;
  const checkDebug = document.getElementById("check-debug") as HTMLInputElement;
  const exportBtn = document.getElementById("btn-export-diagnostics") as HTMLButtonElement;
  const feedbackEl = document.getElementById("export-feedback") as HTMLElement;

  const timingPrerollEl = document.getElementById("timing-preroll") as HTMLElement;
  const timingEstimatedPrerollEl = document.getElementById("timing-estimated-preroll") as HTMLElement;
  const timingSelectedClientEl = document.getElementById("timing-selected-client") as HTMLElement;
  const timingAvoidedWaitEl = document.getElementById("timing-avoided-wait") as HTMLElement;
  const timingSuspectedCauseEl = document.getElementById("timing-suspected-cause") as HTMLElement;

  let currentSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  let activeTabId: number | null = null;

  // 1. Get active tab
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].id) {
      activeTabId = tabs[0].id;
    }
  }

  // 2. Fetch live status from content bridge
  async function refreshStatus() {
    let responded = false;
    if (activeTabId !== null && typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.sendMessage) {
      try {
        const response = await chrome.tabs.sendMessage(activeTabId, { type: "GET_STATUS" });
        if (response) {
          updateUI(response.counters, response.settings, response.health, response.startupDiagnostics);
          responded = true;
        }
      } catch {
        // Tab may not be YouTube or script not yet ready
      }
    }

    if (!responded && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const stored = await chrome.storage.local.get(["ytclean_settings"]);
      const settings = stored?.ytclean_settings || DEFAULT_SETTINGS;
      updateUI(
        { ...DEFAULT_COUNTERS },
        settings,
        { isDegraded: false, recentErrorCount: 0 }
      );
    }
  }

  function updateUI(
    counters: TelemetryCounters,
    settings: ExtensionSettings,
    health: { isDegraded: boolean; recentErrorCount: number },
    startupDiagnostics?: { lastSession?: any; history?: any[] }
  ) {
    currentSettings = { ...settings };

    // Badge & Toggle button
    if (settings.protectionEnabled) {
      badgeEl.textContent = "ON";
      badgeEl.className = "badge badge-on";
      toggleProtectionBtn.textContent = "Protection ON";
      toggleProtectionBtn.className = "btn btn-primary";
    } else {
      badgeEl.textContent = "OFF";
      badgeEl.className = "badge badge-off";
      toggleProtectionBtn.textContent = "Protection OFF";
      toggleProtectionBtn.className = "btn btn-primary btn-disabled";
    }

    // Checkboxes
    checkCosmetic.checked = settings.cosmeticFilteringEnabled;
    checkDebug.checked = settings.debugLoggingEnabled;

    // Counters
    countCleanedEl.textContent = String(counters.playerResponsesSanitized);
    countFallbackEl.textContent = String(counters.adsFallbackHandled);
    countCosmeticEl.textContent = String(counters.promotedElementsHidden);

    // Status
    if (health.isDegraded) {
      statusEl.textContent = "Degraded";
      statusEl.className = "status-value status-degraded";
    } else {
      statusEl.textContent = "Healthy";
      statusEl.className = "status-value status-healthy";
    }

    // Startup timing diagnostics
    if (startupDiagnostics?.lastSession) {
      const session = startupDiagnostics.lastSession;
      timingPrerollEl.textContent = session.prerollInfo?.hasPreroll ? "YES" : "No";
      timingEstimatedPrerollEl.textContent = session.prerollInfo?.estimatedDurationMs
        ? `${(session.prerollInfo.estimatedDurationMs / 1000).toFixed(1)}s`
        : "0.0s";
      timingSelectedClientEl.textContent = session.selectedCandidate || "None";
      timingAvoidedWaitEl.textContent = session.avoidedPrerollWaitMs
        ? `~${(session.avoidedPrerollWaitMs / 1000).toFixed(1)}s`
        : "0.0s";
      timingSuspectedCauseEl.textContent = session.suspectedCause || "NONE";
    }
  }

  async function saveAndSyncSettings(newSettings: Partial<ExtensionSettings>) {
    const updated = { ...currentSettings, ...newSettings };
    currentSettings = updated;

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ ytclean_settings: updated });
    }

    if (activeTabId !== null && typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.sendMessage) {
      try {
        await chrome.tabs.sendMessage(activeTabId, {
          type: "UPDATE_SETTINGS",
          settings: updated
        });
      } catch {
        // Tab not responding
      }
    }

    refreshStatus();
  }

  // Event Listeners
  toggleProtectionBtn.addEventListener("click", () => {
    saveAndSyncSettings({ protectionEnabled: !currentSettings.protectionEnabled });
  });

  checkCosmetic.addEventListener("change", () => {
    saveAndSyncSettings({ cosmeticFilteringEnabled: checkCosmetic.checked });
  });

  checkDebug.addEventListener("change", () => {
    saveAndSyncSettings({ debugLoggingEnabled: checkDebug.checked });
  });

  exportBtn.addEventListener("click", async () => {
    let report: DiagnosticsExportReport | null = null;

    if (activeTabId !== null && typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.sendMessage) {
      try {
        report = await chrome.tabs.sendMessage(activeTabId, { type: "EXPORT_DIAGNOSTICS" });
      } catch {
        // Fallback below
      }
    }

    if (!report) {
      report = {
        extensionVersion: "1.0.0",
        userAgent: navigator.userAgent,
        url: "",
        pageType: "other",
        counters: { ...DEFAULT_COUNTERS },
        settings: currentSettings,
        health: { isDegraded: false, recentErrorCount: 0 },
        recentEvents: []
      };
    }

    const jsonStr = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(jsonStr);
      feedbackEl.textContent = "Report copied to clipboard!";
      feedbackEl.style.display = "block";
      setTimeout(() => { feedbackEl.style.display = "none"; }, 3000);
    } catch {
      // Download fallback
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ytclean-diagnostics-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  });

  // Initial load
  refreshStatus();
});
