import { HEALTH_CONFIG } from "../config/youtube";
import type {
  BlockerEvent,
  DiagnosticEvent,
  TelemetryCounters,
  ExtensionSettings,
  DiagnosticsExportReport
} from "../types/events";

export class DiagnosticsManager {
  private eventRingBuffer: DiagnosticEvent[] = [];
  private counters: TelemetryCounters = {
    playerResponseSeen: 0,
    playerResponsesSanitized: 0,
    adsPrevented: 0,
    adsFallbackHandled: 0,
    promotedElementsHidden: 0,
    antiAdblockDismissals: 0,
    sanitizerErrors: 0,
    playerErrors: 0,
    fallbackActivations: 0,
    confirmedAds: 0,
    falseRecoveryCandidates: 0,
    errors: 0
  };

  private lastStartupSession: any = null;
  private startupSessionHistory: any[] = [];

  constructor(
    private settings: ExtensionSettings,
    private readonly maxBufferSize: number = HEALTH_CONFIG.maxLogRingBufferSize
  ) {}

  public recordEvent(event: BlockerEvent): void {
    if (event.type === "TIMING_UPDATE") {
      this.lastStartupSession = event.session;
      this.startupSessionHistory.push(event.session);
      if (this.startupSessionHistory.length > 20) {
        this.startupSessionHistory.shift();
      }
      return;
    }

    // 1. Update cumulative counters
    switch (event.type) {
      case "PLAYER_RESPONSE_SEEN":
        this.counters.playerResponseSeen++;
        break;
      case "PLAYER_RESPONSE_SANITIZED":
        this.counters.playerResponsesSanitized++;
        this.counters.adsPrevented++;
        break;
      case "AD_POSSIBLE":
        this.counters.falseRecoveryCandidates++;
        break;
      case "AD_CONFIRMED":
        this.counters.confirmedAds++;
        break;
      case "SKIP_CLICKED":
      case "AD_ACCELERATED":
      case "AD_SEEKED":
        this.counters.adsFallbackHandled++;
        this.counters.fallbackActivations++;
        break;
      case "COSMETIC_HIDDEN":
        this.counters.promotedElementsHidden++;
        break;
      case "ANTI_ADBLOCK_DISMISSED":
        this.counters.antiAdblockDismissals++;
        break;
      case "ERROR":
        this.counters.errors++;
        if (
          event.subsystem === "SANITIZER" ||
          event.subsystem === "INITIAL_RESPONSE" ||
          event.subsystem === "XHR_SANITIZER"
        ) {
          this.counters.sanitizerErrors++;
        } else if (event.subsystem === "PLAYER" || event.subsystem === "STATE_MACHINE") {
          this.counters.playerErrors++;
        }
        break;
    }

    // 2. Append to non-sensitive ring buffer
    const entry: DiagnosticEvent = {
      timestamp: Date.now(),
      event
    };

    this.eventRingBuffer.push(entry);
    if (this.eventRingBuffer.length > this.maxBufferSize) {
      this.eventRingBuffer.shift();
    }

    // 3. Conditional debug logging
    if (this.settings.debugLoggingEnabled) {
      this.logToConsole(event);
    }
  }

  private logToConsole(event: BlockerEvent): void {
    let prefix = "[YTCLEAN]";
    switch (event.type) {
      case "PLAYER_RESPONSE_SEEN":
      case "PLAYER_RESPONSE_SANITIZED":
        prefix = "[YTCLEAN:RESPONSE]";
        break;
      case "AD_POSSIBLE":
      case "AD_CONFIRMED":
      case "SKIP_CLICKED":
      case "AD_ACCELERATED":
      case "AD_SEEKED":
        prefix = "[YTCLEAN:PLAYER]";
        break;
      case "CONTENT_RESUMED":
        prefix = "[YTCLEAN:STATE]";
        break;
      case "COSMETIC_HIDDEN":
        prefix = "[YTCLEAN:COSMETIC]";
        break;
      case "ANTI_ADBLOCK_DETECTED":
      case "ANTI_ADBLOCK_DISMISSED":
      case "HEALTH_DEGRADED":
      case "ERROR":
        prefix = "[YTCLEAN:ERROR]";
        break;
    }
    console.log(prefix, event);
  }

  public getCounters(): TelemetryCounters {
    return { ...this.counters };
  }

  public getRecentEvents(): DiagnosticEvent[] {
    return [...this.eventRingBuffer];
  }

  public getStartupDiagnostics(): { lastSession: any; history: any[] } {
    return {
      lastSession: this.lastStartupSession,
      history: [...this.startupSessionHistory]
    };
  }

  public updateSettings(newSettings: ExtensionSettings): void {
    this.settings = { ...newSettings };
  }

  public generateExportReport(
    version: string,
    isDegraded = false,
    recentErrorCount = 0
  ): DiagnosticsExportReport {
    let pageType: DiagnosticsExportReport["pageType"] = "other";
    const path = typeof window !== "undefined" ? window.location.pathname : "";
    if (path.startsWith("/watch")) {
      pageType = "watch";
    } else if (path.startsWith("/shorts")) {
      pageType = "shorts";
    } else if (path === "/" || path === "") {
      pageType = "home";
    }

    return {
      extensionVersion: version,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "Unknown",
      url: typeof window !== "undefined" ? window.location.origin + window.location.pathname : "",
      pageType,
      counters: this.getCounters(),
      settings: { ...this.settings },
      health: {
        isDegraded,
        recentErrorCount
      },
      recentEvents: this.getRecentEvents(),
      startupDiagnostics: {
        lastSession: this.lastStartupSession,
        history: [...this.startupSessionHistory]
      }
    };
  }
}
