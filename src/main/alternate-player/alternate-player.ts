import { PlayerClientPool, type PlayerClientProfile } from "./client-pool";
import { validateAlternatePlayerResponse } from "./response-validator";
import { globalPlaybackTiming } from "../playback-timing";

export interface AlternateSubstitutionResult {
  response: unknown;
  candidateId: string;
}

export interface OriginalPlayerRequestContext {
  url: string;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
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
        // Ignore abort failure
      }
    }
    this.activeControllers.clear();
  }

  /**
   * Build a candidate context from the real request while removing stale WEB-only
   * client identity. Keep locale/visitor/session fields that belong to the browser
   * session, but change the actual Innertube client identity atomically.
   */
  public buildCandidatePayload(
    originalPayload: Record<string, unknown>,
    candidate: PlayerClientProfile,
    videoId: string
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = JSON.parse(JSON.stringify(originalPayload));

    const context =
      payload.context && typeof payload.context === "object" && !Array.isArray(payload.context)
        ? (payload.context as Record<string, unknown>)
        : {};

    const originalClient =
      context.client && typeof context.client === "object" && !Array.isArray(context.client)
        ? (context.client as Record<string, unknown>)
        : {};

    const nextClient: Record<string, unknown> = {
      clientName: candidate.clientName,
      clientVersion: candidate.clientVersion
    };

    for (const key of [
      "hl",
      "gl",
      "visitorData",
      "utcOffsetMinutes",
      "timeZone",
      "userInterfaceTheme"
    ]) {
      if (originalClient[key] !== undefined) {
        nextClient[key] = originalClient[key];
      }
    }

    if (candidate.clientScreen) nextClient.clientScreen = candidate.clientScreen;
    if (candidate.osName) nextClient.osName = candidate.osName;
    if (candidate.osVersion) nextClient.osVersion = candidate.osVersion;
    if (candidate.androidSdkVersion) {
      nextClient.androidSdkVersion = candidate.androidSdkVersion;
    }
    if (candidate.deviceModel) nextClient.deviceModel = candidate.deviceModel;

    context.client = nextClient;

    if (candidate.requiresEmbedContext) {
      const existingThirdParty =
        context.thirdParty &&
        typeof context.thirdParty === "object" &&
        !Array.isArray(context.thirdParty)
          ? (context.thirdParty as Record<string, unknown>)
          : {};

      // WEB_EMBEDDED_PLAYER expects thirdParty.embedUrl to represent the
      // external page hosting the embed, not youtube.com itself. This mirrors
      // maintained Innertube clients and avoids an internally inconsistent
      // embedded-player request.
      context.thirdParty = {
        ...existingThirdParty,
        embedUrl: "https://www.reddit.com/"
      };
    } else if (context.thirdParty && candidate.clientName !== "WEB_EMBEDDED_PLAYER") {
      delete context.thirdParty;
    }

    payload.context = context;
    payload.videoId = videoId;

    if (candidate.useAdPlaybackContext) {
      const playbackContext =
        payload.playbackContext &&
        typeof payload.playbackContext === "object" &&
        !Array.isArray(payload.playbackContext)
          ? (payload.playbackContext as Record<string, unknown>)
          : {};

      const existingAdPlaybackContext =
        playbackContext.adPlaybackContext &&
        typeof playbackContext.adPlaybackContext === "object" &&
        !Array.isArray(playbackContext.adPlaybackContext)
          ? (playbackContext.adPlaybackContext as Record<string, unknown>)
          : {};

      playbackContext.adPlaybackContext = {
        ...existingAdPlaybackContext,
        pyv: true
      };

      payload.playbackContext = playbackContext;
    }

    if (payload.contentCheckOk === undefined) payload.contentCheckOk = true;
    if (payload.racyCheckOk === undefined) payload.racyCheckOk = true;

    return payload;
  }

  private buildCandidateHeaders(
    originalHeaders: HeadersInit | undefined,
    candidate: PlayerClientProfile
  ): Headers {
    const headers = new Headers(originalHeaders || undefined);

    headers.set("content-type", "application/json");
    headers.set(
      "x-youtube-client-name",
      String(candidate.innertubeContextClientName)
    );
    headers.set("x-youtube-client-version", candidate.clientVersion);
    headers.delete("content-length");

    return headers;
  }

  public async fetchCleanAlternateResponse(
    originalPayload: unknown,
    expectedVideoId: string,
    requestContextOrBudget?: OriginalPlayerRequestContext | number,
    timeBudgetMs = 1200
  ): Promise<AlternateSubstitutionResult | null> {
    if (!originalPayload || typeof originalPayload !== "object" || !expectedVideoId) {
      return null;
    }

    let requestContext: OriginalPlayerRequestContext;
    if (typeof requestContextOrBudget === "number") {
      timeBudgetMs = requestContextOrBudget;
      requestContext = { url: "/youtubei/v1/player?prettyPrint=false" };
    } else {
      requestContext =
        requestContextOrBudget ?? { url: "/youtubei/v1/player?prettyPrint=false" };
    }

    const candidates = this.clientPool.getCandidates().slice(0, 2);
    if (candidates.length === 0) return null;

    const raceController = new AbortController();
    this.activeControllers.add(raceController);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<null>((resolve) => {
      const finish = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        resolve(null);
      };

      timeoutTimer = setTimeout(() => {
        raceController.abort();
        finish();
      }, timeBudgetMs);

      raceController.signal.addEventListener("abort", finish, { once: true });
    });

    const executeCandidate = async (
      candidate: PlayerClientProfile
    ): Promise<AlternateSubstitutionResult> => {
      const candidateController = new AbortController();
      const onRaceAbort = () => candidateController.abort();
      raceController.signal.addEventListener("abort", onRaceAbort, { once: true });

      const started = Date.now();
      this.clientPool.markAttempt(candidate.id);

      try {
        const payload = this.buildCandidatePayload(
          originalPayload as Record<string, unknown>,
          candidate,
          expectedVideoId
        );

        const headers = this.buildCandidateHeaders(requestContext.headers, candidate);

        const referrer = candidate.requiresEmbedContext
          ? `https://www.youtube.com/embed/${expectedVideoId}?html5=1`
          : requestContext.referrer;

        const response = await this.nativeFetch(requestContext.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: candidateController.signal,
          credentials: requestContext.credentials ?? "same-origin",
          referrer,
          referrerPolicy: requestContext.referrerPolicy
        });

        if (!response.ok) {
          const duration = Date.now() - started;
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
        const duration = Date.now() - started;

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
        const duration = Date.now() - started;
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
      const winner = await Promise.race([
        Promise.any(candidates.map((candidate) => executeCandidate(candidate))),
        timeoutPromise
      ]);

      if (!winner) return null;

      raceController.abort();
      globalPlaybackTiming.setSelectedCandidate(winner.candidateId, expectedVideoId);
      return winner;
    } catch {
      return null;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      raceController.abort();
      this.activeControllers.delete(raceController);
    }
  }
}

export const globalAlternatePlayer = new AlternatePlayerManager();
