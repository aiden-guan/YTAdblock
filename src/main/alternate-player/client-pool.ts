/**
 * YouTube Player Client Pool & Session Cache.
 *
 * Client identities are intentionally centralized because YouTube changes them
 * frequently. Values below track current maintained yt-dlp client definitions
 * (2026-07 generation) instead of the stale 2024 identities this project
 * previously shipped with.
 *
 * Important: a candidate is only useful if the player response AND the media
 * URLs it returns remain usable in the current browser session. Runtime 401/403/
 * 410 failures therefore suppress that candidate for the remainder of the tab.
 */

export interface PlayerClientProfile {
  id: string;
  clientName: string;
  clientVersion: string;
  clientNameId?: number;
  userAgentOverride?: string;
  enabled: boolean;
  clientScreen?: string;
  thirdPartyEmbedUrl?: string;
  osName?: string;
  osVersion?: string;
  androidSdkVersion?: number;
  deviceMake?: string;
  deviceModel?: string;
}

export interface StrategyStats {
  attempts: number;
  successes: number;
  medianStartupMs: number;
  media403s: number;
  failures: number;
}

/**
 * Order is deliberate. WEB_EMBEDDED_PLAYER and TVHTML5 remain the first
 * candidates because they are web-compatible and currently do not carry the
 * same GVS PO-token requirements that several mobile clients do.
 */
export const INITIAL_CLIENT_PROFILES: PlayerClientProfile[] = [
  {
    id: "web-embedded",
    clientName: "WEB_EMBEDDED_PLAYER",
    clientVersion: "2.20260708.00.00",
    clientNameId: 56,
    userAgentOverride:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)",
    thirdPartyEmbedUrl: "https://www.reddit.com/",
    enabled: true
  },
  {
    id: "tvhtml5",
    clientName: "TVHTML5",
    clientVersion: "7.20260707.07.00",
    clientNameId: 7,
    userAgentOverride:
      "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
    enabled: true
  },
  {
    id: "visionos",
    clientName: "VISIONOS",
    clientVersion: "1.02",
    clientNameId: 101,
    userAgentOverride:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    osName: "visionOS",
    osVersion: "26.5.23O471",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    enabled: true
  },
  {
    id: "android",
    clientName: "ANDROID",
    clientVersion: "21.26.364",
    clientNameId: 3,
    userAgentOverride:
      "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
    osName: "Android",
    osVersion: "11",
    androidSdkVersion: 30,
    enabled: true
  },
  {
    id: "ios",
    clientName: "IOS",
    clientVersion: "21.26.4",
    clientNameId: 5,
    userAgentOverride:
      "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    osName: "iPhone",
    osVersion: "18.3.2.22D82",
    deviceMake: "Apple",
    deviceModel: "iPhone16,2",
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

  public getCandidates(): PlayerClientProfile[] {
    const available = Array.from(this.profiles.values()).filter((p) => {
      if (!p.enabled) return false;
      const stat = this.stats.get(p.id);
      if (stat && stat.media403s >= this.max403Threshold) {
        return false;
      }
      return true;
    });

    return available.sort((a, b) => {
      if (a.id === this.preferredCleanClient) return -1;
      if (b.id === this.preferredCleanClient) return 1;

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
    if (s) s.attempts++;
  }

  public markSuccess(id: string, startupDurationMs?: number): void {
    const s = this.stats.get(id);
    if (s) {
      s.successes++;
      if (startupDurationMs && startupDurationMs > 0) {
        s.medianStartupMs =
          s.medianStartupMs === 0
            ? startupDurationMs
            : Math.round((s.medianStartupMs + startupDurationMs) / 2);
      }
    }
    this.preferredCleanClient = id;
  }

  public markFailure(id: string, reason: string): void {
    const s = this.stats.get(id);
    if (s) {
      s.failures++;
      if (
        reason === "MEDIA_403" ||
        reason === "MEDIA_401" ||
        reason === "MEDIA_410"
      ) {
        s.media403s++;
      }
    }

    if (this.preferredCleanClient === id) {
      this.preferredCleanClient = null;
    }

    if (s && s.media403s >= this.max403Threshold) {
      const profile = this.profiles.get(id);
      if (profile) profile.enabled = false;
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
      s.medianStartupMs = 0;
    }
    for (const p of this.profiles.values()) {
      p.enabled = true;
    }
  }
}
