/**
 * YouTube Player Client Pool & Session Cache.
 *
 * Manages diverse Innertube client profiles (WEB_EMBEDDED_PLAYER, TVHTML5, ANDROID, IOS, VISIONOS)
 * to avoid hard-coding a single fragile fallback.
 *
 * Replicates client contexts modeled after current Innertube player protocols:
 * - WEB_EMBEDDED_PLAYER: unbundled embed playback context with embed originalUrl
 * - TVHTML5: web-compatible HTML5 TV client profile
 * - ANDROID: native mobile profile with modern SDK attributes
 * - IOS: native iOS player client profile
 *
 * Manages runtime health, session preferences, and stats to adaptively prioritize
 * reliable clients and isolate 403-failing profiles.
 */

export interface PlayerClientProfile {
  id: string;
  clientName: string;
  clientVersion: string;
  userAgentOverride?: string;
  enabled: boolean;
  clientScreen?: string;
  requiresOriginalUrl?: boolean;
  osName?: string;
  osVersion?: string;
  androidSdkVersion?: number;
  deviceModel?: string;
}

export interface StrategyStats {
  attempts: number;
  successes: number;
  medianStartupMs: number;
  media403s: number;
  failures: number;
}

export const INITIAL_CLIENT_PROFILES: PlayerClientProfile[] = [
  {
    id: "web-embedded",
    clientName: "WEB_EMBEDDED_PLAYER",
    clientVersion: "1.20240901.01.00",
    requiresOriginalUrl: true,
    enabled: true
  },
  {
    id: "tvhtml5",
    clientName: "TVHTML5",
    clientVersion: "7.20240901.12.00",
    clientScreen: "WATCH",
    enabled: true
  },
  {
    id: "android",
    clientName: "ANDROID",
    clientVersion: "19.29.35",
    osName: "Android",
    osVersion: "14",
    androidSdkVersion: 34,
    enabled: true
  },
  {
    id: "ios",
    clientName: "IOS",
    clientVersion: "19.29.1",
    osName: "iOS",
    osVersion: "17.5.1",
    deviceModel: "iPhone16,2",
    enabled: true
  },
  {
    id: "visionos",
    clientName: "VISIONOS",
    clientVersion: "1.0.0",
    enabled: true
  }
];

export class PlayerClientPool {
  private profiles: Map<string, PlayerClientProfile> = new Map();
  private stats: Map<string, StrategyStats> = new Map();
  private preferredCleanClient: string | null = null;
  private readonly max403Threshold = 2;

  constructor(initialProfiles: PlayerClientProfile[] = INITIAL_CLIENT_PROFILES) {
    for (const p of initialProfiles) {
      this.profiles.set(p.id, { ...p });
      this.stats.set(p.id, {
        attempts: 0,
        successes: 0,
        medianStartupMs: 0,
        media403s: 0,
        failures: 0
      });
    }
  }

  /**
   * Returns healthy candidate profiles ordered by session preference and performance.
   */
  public getCandidates(): PlayerClientProfile[] {
    const available = Array.from(this.profiles.values()).filter((p) => {
      if (!p.enabled) return false;
      const stat = this.stats.get(p.id);
      // Suppress candidate if it encountered repeated media 403s in this session
      if (stat && stat.media403s >= this.max403Threshold) {
        return false;
      }
      return true;
    });

    return available.sort((a, b) => {
      // 1. Preferred working client for current session takes top priority
      if (a.id === this.preferredCleanClient) return -1;
      if (b.id === this.preferredCleanClient) return 1;

      // 2. Score based on successes, failures, and media 403s
      const statA = this.stats.get(a.id)!;
      const statB = this.stats.get(b.id)!;

      const scoreA = statA.successes * 2 - statA.failures - statA.media403s * 3;
      const scoreB = statB.successes * 2 - statB.failures - statB.media403s * 3;

      return scoreB - scoreA;
    });
  }

  public getProfile(id: string): PlayerClientProfile | undefined {
    return this.profiles.get(id);
  }

  public getPreferredClient(): string | null {
    return this.preferredCleanClient;
  }

  public markAttempt(id: string): void {
    const s = this.stats.get(id);
    if (s) {
      s.attempts++;
    }
  }

  public markSuccess(id: string, startupDurationMs?: number): void {
    const s = this.stats.get(id);
    if (s) {
      s.successes++;
      if (startupDurationMs && startupDurationMs > 0) {
        s.medianStartupMs = s.medianStartupMs === 0
          ? startupDurationMs
          : Math.round((s.medianStartupMs + startupDurationMs) / 2);
      }
    }
    // Remember working client for subsequent videos in this session
    this.preferredCleanClient = id;
  }

  public markFailure(id: string, reason: string): void {
    const s = this.stats.get(id);
    if (s) {
      s.failures++;
      if (reason === "MEDIA_403" || reason === "MEDIA_401" || reason === "MEDIA_410") {
        s.media403s++;
      }
    }

    // Rotate preferred client if the current preferred failed
    if (this.preferredCleanClient === id) {
      this.preferredCleanClient = null;
    }

    // Disable if excessive failures
    if (s && s.media403s >= this.max403Threshold) {
      const profile = this.profiles.get(id);
      if (profile) {
        profile.enabled = false;
      }
    }
  }

  public getStats(id: string): StrategyStats | undefined {
    const s = this.stats.get(id);
    return s ? { ...s } : undefined;
  }

  public getAllStats(): Record<string, StrategyStats> {
    const result: Record<string, StrategyStats> = {};
    for (const [id, s] of this.stats.entries()) {
      result[id] = { ...s };
    }
    return result;
  }

  public resetSessionCache(): void {
    this.preferredCleanClient = null;
    for (const s of this.stats.values()) {
      s.attempts = 0;
      s.successes = 0;
      s.failures = 0;
      s.media403s = 0;
    }
    for (const p of this.profiles.values()) {
      p.enabled = true;
    }
  }
}
