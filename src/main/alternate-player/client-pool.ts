export interface PlayerClientProfile {
  id: string;
  clientName: string;
  clientVersion: string;
  innertubeContextClientName: number;
  enabled: boolean;
  clientScreen?: string;
  requiresEmbedContext?: boolean;
  useAdPlaybackContext?: boolean;
  contextUserAgent?: string;
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
 * Browser-usable clean-player candidates.
 *
 * Ordering is deliberate and follows the practical 2026 YouTube client state
 * tracked by maintained yt-dlp:
 *
 * - tv_downgraded: cookie-capable, no declared GVS PO-token requirement, and
 *   explicitly used by yt-dlp as an authenticated/free-account fallback.
 * - web_embedded: cookie-capable and no declared GVS PO-token requirement.
 * - tv: cookie-capable and no declared GVS PO-token requirement.
 * - visionos: useful JS-less/public fallback, but not cookie-capable.
 * - mweb: kept only as a late fallback because current HTTPS/DASH playback is
 *   declared PO-token-required; spending an early race slot on it is wasteful.
 */
export const INITIAL_CLIENT_PROFILES: PlayerClientProfile[] = [
  {
    id: "tv-downgraded",
    clientName: "TVHTML5",
    clientVersion: "5.20260707",
    innertubeContextClientName: 7,
    contextUserAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
    enabled: true
  },
  {
    id: "web-embedded",
    clientName: "WEB_EMBEDDED_PLAYER",
    clientVersion: "2.20260708.00.00",
    innertubeContextClientName: 56,
    contextUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)",
    requiresEmbedContext: true,
    enabled: true
  },
  {
    id: "tvhtml5",
    clientName: "TVHTML5",
    clientVersion: "7.20260707.07.00",
    innertubeContextClientName: 7,
    contextUserAgent:
      "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
    enabled: true
  },
  {
    id: "visionos",
    clientName: "VISIONOS",
    clientVersion: "1.02",
    innertubeContextClientName: 101,
    contextUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    osName: "visionOS",
    osVersion: "26.5.23O471",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    enabled: true
  },
  {
    id: "mweb-ad-context",
    clientName: "MWEB",
    clientVersion: "2.20260708.05.00",
    innertubeContextClientName: 2,
    contextUserAgent:
      "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
    useAdPlaybackContext: true,
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
      return !(stat && stat.media403s >= this.max403Threshold);
    });

    return available.sort((a, b) => {
      if (a.id === this.preferredCleanClient) return -1;
      if (b.id === this.preferredCleanClient) return 1;

      const statA = this.stats.get(a.id)!;
      const statB = this.stats.get(b.id)!;
      const scoreA = statA.successes * 2 - statA.failures - statA.media403s * 3;
      const scoreB = statB.successes * 2 - statB.failures - statB.media403s * 3;

      // Array#sort is stable in modern Chromium/Node, so equal scores retain the
      // deliberate base ordering above.
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
    this.stats.get(id) && this.stats.get(id)!.attempts++;
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
      if (reason === "MEDIA_403" || reason === "MEDIA_401" || reason === "MEDIA_410") {
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
    for (const [id, s] of this.stats.entries()) result[id] = { ...s };
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
    for (const p of this.profiles.values()) p.enabled = true;
  }
}
