/**
 * Alternate Player Response Coordinator.
 *
 * The production-critical detail here is that alternate player calls must retain
 * the original Innertube request URL (including the API key) and the browser
 * session headers/credentials. Rebuilding a naked POST to /youtubei/v1/player
 * loses visitor/auth context and is unreliable on current YouTube.
 */

import { PlayerClientPool, type PlayerClientProfile } from "./client-pool";
import { validateAlternatePlayerResponse } from "./response-validator";
import { globalPlaybackTiming } from "../playback-timing";

export interface AlternateSubstitutionResult {
  response: unknown;
  candidateId: string;
}

export interface PlayerRequestSnapshot {
  url: string;
  payload: Record<string, unknown>;
  headers?: Array<[string, string]>;
  credentials?: RequestCredentials;
}

const PRESERVED_CLIENT_KEYS = [
  "hl",
  "gl",
  "timeZone",
  "utcOffsetMinutes",
  "visitorData",
  "userInterfaceTheme"
] as const;

function isRequestSnapshot(
  input: PlayerRequestSnapshot | Record<string, unknown>
): input is PlayerRequestSnapshot {
  return (
    typeof (input as PlayerRequestSnapshot).url === "string" &&
    !!(input as PlayerRequestSnapshot).payload
  );
}

export class AlternatePlayerManager {
  private clientPool: PlayerClientPool;
  private nativeFetch: typeof window.fetch;
  private activeControllers: Set<AbortController> = new Set();

  constructor(
    clientPool: PlayerClientPool = new PlayerClientPool(),
    customFetch?: typeof window.fetch
  ) {
    this.clientPool = clientPool;
    if (customFetch) {
      this.nativeFetch = customFetch;
    } else if (typeof window !== "undefined" && window.fetch) {
      this.nativeFetch = window.fetch.bind(window);
    } else {
      this.nativeFetch = fetch;
    }
  }

  public getClientPool(): PlayerClientPool {
    return this.clientPool;
  }

  public setNativeFetch(fn: typeof window.fetch): void {
    this.nativeFetch = fn;
  }

  public abortAllPending(): void {
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // Ignore abort error
      }
    }
    this.activeControllers.clear();
  }

  /**
   * Build a client-specific payload without carrying WEB-only identity fields
   * into a TV/mobile/embedded request. Session-safe fields such as visitorData,
   * language and timezone are retained.
   */
  public buildCandidatePayload(
    originalPayload: Record<string, unknown>,
    candidate: PlayerClientProfile,
    videoId: string
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = JSON.parse(
      JSON.stringify(originalPayload)
    );

    if (!payload.context || typeof payload.context !== "object") {
      payload.context = {};
    }
    const context = payload.context as Record<string, unknown>;
    const originalClient =
      context.client && typeof context.client === "object"
        ? (context.client as Record<string, unknown>)
        : {};

    const client: Record<string, unknown> = {};
    for (const key of PRESERVED_CLIENT_KEYS) {
      if (originalClient[key] !== undefined) {
        client[key] = originalClient[key];
      }
    }

    client.clientName = candidate.clientName;
    client.clientVersion = candidate.clientVersion;

    if (candidate.userAgentOverride) {
      client.userAgent = candidate.userAgentOverride;
    }
    if (candidate.clientScreen) client.clientScreen = candidate.clientScreen;
    if (candidate.osName) client.osName = candidate.osName;
    if (candidate.osVersion) client.osVersion = candidate.osVersion;
    if (candidate.androidSdkVersion) {
      client.androidSdkVersion = candidate.androidSdkVersion;
    }
    if (candidate.deviceMake) client.deviceMake = candidate.deviceMake;
    if (candidate.deviceModel) client.deviceModel = candidate.deviceModel;

    context.client = client;

    if (candidate.thirdPartyEmbedUrl) {
      context.thirdParty = {
        embedUrl: candidate.thirdPartyEmbedUrl
      };
    } else if (context.thirdParty) {
      delete context.thirdParty;
    }

    payload.videoId = videoId;

    // Preserve caller flags when present; only add permissive flags when absent.
    if (payload.contentCheckOk === undefined) payload.contentCheckOk = true;
    if (payload.racyCheckOk === undefined) payload.racyCheckOk = true;

    return payload;
  }

  private normalizeSnapshot(
    input: PlayerRequestSnapshot | Record<string, unknown>
  ): PlayerRequestSnapshot {
    if (isRequestSnapshot(input)) {
      return input;
    }
    return {
      url: "/youtubei/v1/player?prettyPrint=false",
      payload: input,
      headers: [["content-type", "application/json"]],
      credentials: "same-origin"
    };
  }

  private buildCandidateHeaders(
    snapshot: PlayerRequestSnapshot,
    candidate: PlayerClientProfile
  ): Headers {
    const headers = new Headers(snapshot.headers ?? []);

    // Browser recalculates these; carrying stale transport headers is unsafe.
    headers.delete("content-length");

    headers.set("content-type", "application/json");

    // Keep the request header identity consistent with the context.client body.
    headers.delete("x-youtube-client-name");
    headers.delete("x-youtube-client-version");
    if (candidate.clientNameId !== undefined) {
      headers.set("x-youtube-client-name", String(candidate.clientNameId));
    }
    headers.set("x-youtube-client-version", candidate.clientVersion);

    return headers;
  }

  public async fetchCleanAlternateResponse(
    originalRequest: PlayerRequestSnapshot | Record<string, unknown>,
    expectedVideoId: string,
    timeBudgetMs = 1200
  ): Promise<AlternateSubstitutionResult | null> {
    if (!originalRequest || typeof originalRequest !== "object" || !expectedVideoId) {
      return null;
    }

    const snapshot = this.normalizeSnapshot(originalRequest);
    if (
      !snapshot.payload ||
      typeof snapshot.payload !== "object" ||
      Array.isArray(snapshot.payload)
    ) {
      return null;
    }

    const candidates = this.clientPool.getCandidates().slice(0, 3);
    if (candidates.length === 0) return null;

    const raceController = new AbortController();
    this.activeControllers.add(raceController);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(() => {
        raceController.abort();
        resolve(null);
      }, timeBudgetMs);

      raceController.signal.addEventListener(
        "abort",
        () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve(null);
        },
        { once: true }
      );
    });

    const executeCandidate = async (
      candidate: PlayerClientProfile
    ): Promise<AlternateSubstitutionResult> => {
      const controller = new AbortController();
      const onRaceAbort = () => controller.abort();
      raceController.signal.addEventListener("abort", onRaceAbort, { once: true });

      const startedAt = Date.now();
      this.clientPool.markAttempt(candidate.id);

      try {
        const payload = this.buildCandidatePayload(
          snapshot.payload,
          candidate,
          expectedVideoId
        );
        const headers = this.buildCandidateHeaders(snapshot, candidate);

        const response = await this.nativeFetch(snapshot.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          credentials: snapshot.credentials ?? "same-origin",
          signal: controller.signal
        });

        if (!response.ok) {
          const duration = Date.now() - startedAt;
          this.clientPool.markFailure(candidate.id, `HTTP_${response.status}`);
          globalPlaybackTiming.recordCandidateResult({
            candidateId: candidate.id,
            clientName: candidate.clientName,
            durationMs: duration,
            status: "FAILED",
            error: `HTTP ${response.status}`
          });
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const duration = Date.now() - startedAt;

        if (!validateAlternatePlayerResponse(data, expectedVideoId)) {
          this.clientPool.markFailure(candidate.id, "INVALID_RESPONSE");
          globalPlaybackTiming.recordCandidateResult({
            candidateId: candidate.id,
            clientName: candidate.clientName,
            durationMs: duration,
            status: "INVALID"
          });
          throw new Error("Validation failed");
        }

        this.clientPool.markSuccess(candidate.id, duration);
        globalPlaybackTiming.recordCandidateResult({
          candidateId: candidate.id,
          clientName: candidate.clientName,
          durationMs: duration,
          status: "VALID"
        });

        return {
          response: data,
          candidateId: candidate.id
        };
      } catch (err) {
        const duration = Date.now() - startedAt;
        if (controller.signal.aborted) {
          globalPlaybackTiming.recordCandidateResult({
            candidateId: candidate.id,
            clientName: candidate.clientName,
            durationMs: duration,
            status: "ABORTED"
          });
        }
        throw err;
      } finally {
        raceController.signal.removeEventListener("abort", onRaceAbort);
      }
    };

    try {
      const winner = await Promise.race([
        Promise.any(candidates.map((candidate) => executeCandidate(candidate))),
        timeoutPromise
      ]);

      if (winner) {
        raceController.abort();
        globalPlaybackTiming.setSelectedCandidate(
          winner.candidateId,
          expectedVideoId
        );
        return winner;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.activeControllers.delete(raceController);
    }
  }
}

export const globalAlternatePlayer = new AlternatePlayerManager();
