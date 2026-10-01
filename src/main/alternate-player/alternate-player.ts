/**
 * Alternate Player Response Coordinator.
 *
 * Executes a bounded, parallelized race among healthy Innertube client profiles
 * to obtain a clean, compatible player response when the standard WEB response
 * is ad-bound.
 *
 * Key guarantees:
 * - Uses unpatched nativeFetch to eliminate recursion risk.
 * - Tags all internal calls with "X-YTClean-Internal".
 * - Bounded race (max 2-3 concurrent candidates).
 * - Enforces strict time budget (~800ms) with immediate AbortController cancellation.
 * - First valid, clean response wins; losing candidates aborted.
 * - SPA navigation cancels in-flight races.
 */

import { PlayerClientPool, type PlayerClientProfile } from "./client-pool";
import { validateAlternatePlayerResponse } from "./response-validator";
import { globalPlaybackTiming } from "../playback-timing";

export interface AlternateSubstitutionResult {
  response: unknown;
  candidateId: string;
}

export class AlternatePlayerManager {
  private clientPool: PlayerClientPool;
  private nativeFetch: typeof window.fetch;
  private activeControllers: Set<AbortController> = new Set();
  private readonly internalHeader = "X-YTClean-Internal";

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

  /**
   * Sets or updates the native fetch reference (captured before interceptor is installed).
   */
  public setNativeFetch(fn: typeof window.fetch): void {
    this.nativeFetch = fn;
  }

  public isInternalRequest(requestOrHeaders: unknown): boolean {
    if (!requestOrHeaders) return false;
    if (typeof requestOrHeaders === "object" && "headers" in (requestOrHeaders as any)) {
      const headers = (requestOrHeaders as any).headers;
      if (headers && typeof headers.get === "function") {
        return headers.get(this.internalHeader) === "1";
      }
    }
    return false;
  }

  /**
   * Aborts all pending candidate requests (e.g. upon SPA navigation).
   */
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
   * Clones and customizes the original YouTube player request for a candidate profile.
   */
  public buildCandidatePayload(
    originalPayload: Record<string, unknown>,
    candidate: PlayerClientProfile,
    videoId: string
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = JSON.parse(JSON.stringify(originalPayload));

    // Ensure context and client objects exist
    if (!payload.context || typeof payload.context !== "object") {
      payload.context = {};
    }
    const context = payload.context as Record<string, unknown>;
    if (!context.client || typeof context.client !== "object") {
      context.client = {};
    }
    const client = context.client as Record<string, unknown>;

    // Inject candidate profile identity
    client.clientName = candidate.clientName;
    client.clientVersion = candidate.clientVersion;

    if (candidate.clientScreen) {
      client.clientScreen = candidate.clientScreen;
    }
    if (candidate.osName) {
      client.osName = candidate.osName;
    }
    if (candidate.osVersion) {
      client.osVersion = candidate.osVersion;
    }
    if (candidate.androidSdkVersion) {
      client.androidSdkVersion = candidate.androidSdkVersion;
    }
    if (candidate.deviceModel) {
      client.deviceModel = candidate.deviceModel;
    }

    if (candidate.requiresOriginalUrl) {
      client.originalUrl = `https://www.youtube.com/embed/${videoId}`;
    }

    // Preserve critical playback flags
    payload.videoId = videoId;
    payload.contentCheckOk = true;
    payload.racyCheckOk = true;

    return payload;
  }

  /**
   * Executes candidate race to find a valid clean player response.
   */
  public async fetchCleanAlternateResponse(
    originalPayload: unknown,
    expectedVideoId: string,
    timeBudgetMs = 800
  ): Promise<AlternateSubstitutionResult | null> {
    if (!originalPayload || typeof originalPayload !== "object" || !expectedVideoId) {
      return null;
    }

    const candidates = this.clientPool.getCandidates().slice(0, 3);
    if (candidates.length === 0) {
      return null;
    }

    const raceController = new AbortController();
    this.activeControllers.add(raceController);

    const raceStartTime = Date.now();
    const candidateControllers: AbortController[] = [];

    // Timeout guard: if time budget elapses before a winner emerges, cancel race
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
      const candidateController = new AbortController();
      candidateControllers.push(candidateController);

      // Link raceController abort to candidateController
      const onRaceAbort = () => candidateController.abort();
      raceController.signal.addEventListener("abort", onRaceAbort, { once: true });

      const candidateStartTime = Date.now();
      this.clientPool.markAttempt(candidate.id);

      try {
        const payload = this.buildCandidatePayload(
          originalPayload as Record<string, unknown>,
          candidate,
          expectedVideoId
        );

        const response = await this.nativeFetch("/youtubei/v1/player?prettyPrint=false", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [this.internalHeader]: "1"
          },
          body: JSON.stringify(payload),
          signal: candidateController.signal
        });

        if (!response.ok) {
          const duration = Date.now() - candidateStartTime;
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
        const duration = Date.now() - candidateStartTime;

        const isValid = validateAlternatePlayerResponse(data, expectedVideoId);
        if (!isValid) {
          this.clientPool.markFailure(candidate.id, "INVALID_RESPONSE");
          globalPlaybackTiming.recordCandidateResult({
            candidateId: candidate.id,
            clientName: candidate.clientName,
            durationMs: duration,
            status: "INVALID"
          });
          throw new Error("Validation failed");
        }

        // Candidate succeeded!
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
        const duration = Date.now() - candidateStartTime;
        if (candidateController.signal.aborted) {
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
      // Promise.any takes the first resolved valid result
      const winner = await Promise.race([
        Promise.any(candidates.map((c) => executeCandidate(c))),
        timeoutPromise
      ]);

      if (winner) {
        // Abort remaining candidates immediately
        raceController.abort();
        globalPlaybackTiming.setSelectedCandidate(winner.candidateId, expectedVideoId);
        return winner;
      }
      return null;
    } catch {
      // All candidates failed
      return null;
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      this.activeControllers.delete(raceController);
    }
  }
}

export const globalAlternatePlayer = new AlternatePlayerManager();
