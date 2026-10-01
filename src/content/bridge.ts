import {
  BRIDGE_EVENT_MAIN_TO_ISOLATED,
  BRIDGE_EVENT_ISOLATED_TO_MAIN
} from "../config/youtube";
import type {
  BlockerEvent,
  ExtensionSettings,
  DiagnosticsExportReport
} from "../types/events";
import { DEFAULT_SETTINGS } from "../types/events";
import { DiagnosticsManager } from "./diagnostics";
import { HealthMonitor } from "./health-monitor";
import { CosmeticController } from "./cosmetic-controller";

(function initBridge() {
  const guardKey = Symbol.for("ytclean.bridge.installed");
  const win = window as any;
  if (win[guardKey]) {
    return;
  }
  win[guardKey] = true;

  let currentSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };

  const diagnostics = new DiagnosticsManager(currentSettings);

  const cosmeticController = new CosmeticController(document, (event) => {
    handleIncomingEvent(event);
  });
  cosmeticController.init(
    currentSettings.protectionEnabled && currentSettings.cosmeticFilteringEnabled
  );

  // Load persisted settings if storage is available
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["ytclean_settings"], (res) => {
      if (res && res.ytclean_settings) {
        currentSettings = { ...DEFAULT_SETTINGS, ...res.ytclean_settings };
        diagnostics.updateSettings(currentSettings);
        applySettingsToMainWorld(currentSettings);
        cosmeticController.setEnabled(
          currentSettings.protectionEnabled && currentSettings.cosmeticFilteringEnabled
        );
      }
    });
  }

  const healthMonitor = new HealthMonitor(
    3,
    30_000,
    (reason) => {
      // Degraded health: disable main-world rewriting to fail open and avoid breaking YouTube
      sendMainWorldCommand("PAUSE_SANITIZER");
      diagnostics.recordEvent({
        type: "HEALTH_DEGRADED",
        reason
      });
    },
    (event) => diagnostics.recordEvent(event)
  );

  function sendMainWorldCommand(action: "PAUSE_SANITIZER" | "RESUME_SANITIZER") {
    try {
      window.dispatchEvent(
        new CustomEvent(BRIDGE_EVENT_ISOLATED_TO_MAIN, { detail: { action } })
      );
    } catch {
      // Ignore boundary errors
    }
  }

  function applySettingsToMainWorld(settings: ExtensionSettings) {
    if (settings.protectionEnabled) {
      sendMainWorldCommand("RESUME_SANITIZER");
    } else {
      sendMainWorldCommand("PAUSE_SANITIZER");
    }
    cosmeticController.setEnabled(
      settings.protectionEnabled && settings.cosmeticFilteringEnabled
    );
  }

  function handleIncomingEvent(event: BlockerEvent) {
    if (!currentSettings.protectionEnabled) {
      return;
    }

    if (event.type === "ERROR") {
      healthMonitor.recordError(event.subsystem, event.message);
    }

    diagnostics.recordEvent(event);
  }

  // 1. Listen for events from MAIN world
  window.addEventListener(BRIDGE_EVENT_MAIN_TO_ISOLATED, ((e: CustomEvent) => {
    if (e.detail && typeof e.detail.type === "string") {
      handleIncomingEvent(e.detail as BlockerEvent);
    }
  }) as EventListener);

  // 2. Listen for fallback / content events
  window.addEventListener("ytclean:fallback-event", ((e: CustomEvent) => {
    if (e.detail && typeof e.detail.type === "string") {
      handleIncomingEvent(e.detail as BlockerEvent);
    }
  }) as EventListener);

  // 3. Listen for messages from extension popup or background
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (!request || typeof request !== "object") return false;

      switch (request.type) {
        case "GET_STATUS": {
          const health = healthMonitor.getStatus();
          sendResponse({
            counters: diagnostics.getCounters(),
            settings: currentSettings,
            health,
            startupDiagnostics: diagnostics.getStartupDiagnostics()
          });
          return true;
        }

        case "UPDATE_SETTINGS": {
          const updated = { ...currentSettings, ...request.settings };
          currentSettings = updated;
          diagnostics.updateSettings(updated);
          applySettingsToMainWorld(updated);

          if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ ytclean_settings: updated });
          }

          sendResponse({ success: true, settings: currentSettings });
          return true;
        }

        case "EXPORT_DIAGNOSTICS": {
          const health = healthMonitor.getStatus();
          const manifestVersion = chrome.runtime.getManifest()?.version || "1.0.0";
          const report: DiagnosticsExportReport = diagnostics.generateExportReport(
            manifestVersion,
            health.isDegraded,
            health.recentErrorCount
          );
          sendResponse(report);
          return true;
        }

        case "RESET_HEALTH": {
          healthMonitor.reset();
          sendMainWorldCommand("RESUME_SANITIZER");
          sendResponse({ success: true });
          return true;
        }
      }

      return false;
    });
  }
})();
