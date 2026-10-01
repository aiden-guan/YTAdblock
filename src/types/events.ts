/**
 * Typed domain events, diagnostics, and state contracts.
 */

export type BlockerEvent =
  | { type: "PLAYER_RESPONSE_SEEN" }
  | { type: "PLAYER_RESPONSE_SANITIZED"; removed: string[] }
  | { type: "PLAYER_RESPONSE_SUBSTITUTED"; candidateId: string; videoId?: string }
  | { type: "PREROLL_DETECTED"; videoId?: string; source: "initial" | "fetch" | "xhr" }
  | {
      type: "PREROLL_CLEARED";
      videoId?: string;
      reason: "clean_response" | "substituted" | "content_resumed" | "navigation" | "watchdog";
    }
  | { type: "TIMING_UPDATE"; session: any }
  | { type: "AD_POSSIBLE"; signals: string[] }
  | { type: "AD_CONFIRMED"; signals: string[] }
  | { type: "SKIP_CLICKED" }
  | { type: "AD_ACCELERATED" }
  | { type: "AD_SEEKED" }
  | { type: "CONTENT_RESUMED" }
  | { type: "COSMETIC_HIDDEN"; selector: string }
  | { type: "ANTI_ADBLOCK_DETECTED"; detail: string }
  | { type: "ANTI_ADBLOCK_DISMISSED" }
  | { type: "HEALTH_DEGRADED"; reason: string }
  | { type: "ERROR"; subsystem: string; message: string };

export interface DiagnosticEvent {
  timestamp: number;
  event: BlockerEvent;
}

export interface TelemetryCounters {
  playerResponseSeen: number;
  playerResponsesSanitized: number;
  adsPrevented: number;
  adsFallbackHandled: number;
  promotedElementsHidden: number;
  antiAdblockDismissals: number;
  sanitizerErrors: number;
  playerErrors: number;
  fallbackActivations: number;
  confirmedAds: number;
  falseRecoveryCandidates: number;
  errors: number;
}

export const DEFAULT_COUNTERS: TelemetryCounters = {
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

export interface ExtensionSettings {
  protectionEnabled: boolean;
  cosmeticFilteringEnabled: boolean;
  debugLoggingEnabled: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  protectionEnabled: true,
  cosmeticFilteringEnabled: true,
  debugLoggingEnabled: false
};

export type PlayerState =
  | "CONTENT"
  | "POSSIBLE_AD"
  | "CONFIRMED_AD"
  | "RECOVERING"
  | "UNKNOWN";

export interface UserPlaybackState {
  muted: boolean;
  volume: number;
  playbackRate: number;
}

export interface PlayerResponseSource {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface SanitizerReport {
  changed: boolean;
  removed: string[];
}

export interface SanitizerResult {
  sanitized: unknown;
  report: SanitizerReport;
}

export interface DiagnosticsExportReport {
  extensionVersion: string;
  userAgent: string;
  url: string;
  pageType: "watch" | "shorts" | "home" | "other";
  counters: TelemetryCounters;
  settings: ExtensionSettings;
  health: {
    isDegraded: boolean;
    recentErrorCount: number;
  };
  recentEvents: DiagnosticEvent[];
  startupDiagnostics?: {
    lastSession?: any;
    history?: any[];
    clientStats?: Record<string, any>;
    preferredClient?: string | null;
  };
}
