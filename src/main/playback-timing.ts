/**
 * Local Playback Timing Diagnostics.
 *
 * Precisely measures YouTube player initialization, player response processing,
 * media fetching, and HTMLVideoElement playback events to distinguish:
 * 1. Client-side delay (player response returned -> idle gap -> media request begins)
 * 2. Server/media backoff (media requested immediately -> 403 / throttling / delayed chunk)
 *
 * Strict requirements:
 * - Local in-memory only.
 * - NEVER expose or save URLs containing tokens, auth params, or signatures.
 */

import type { PrerollInfo } from "./preroll-detector";

export type TimingMilestone =
  | "PLAYER_REQUEST_STARTED"
  | "PLAYER_RESPONSE_RECEIVED"
  | "PLAYER_RESPONSE_HAS_ADS"
  | "PLAYER_RESPONSE_RETURNED_TO_YOUTUBE"
  | "CONTENT_MEDIA_REQUEST_STARTED"
  | "CONTENT_MEDIA_FIRST_RESPONSE"
  | "VIDEO_METADATA_LOADED"
  | "VIDEO_CANPLAY"
  | "VIDEO_PLAYING";

export enum DelayCause {
  NONE = "NONE",
  PLAYER_SIDE_WAIT = "PLAYER_SIDE_WAIT",
  SERVER_PREROLL_BACKOFF = "SERVER_PREROLL_BACKOFF",
  UNKNOWN = "UNKNOWN"
}

export interface CandidateTimingEntry {
  candidateId: string;
  clientName: string;
  durationMs: number;
  status: "VALID" | "INVALID" | "ABORTED" | "FAILED" | "TIMEOUT";
  error?: string;
}

export interface PlaybackSessionDiagnostics {
  videoId: string;
  startTime: number;
  timestamps: Partial<Record<TimingMilestone, number>>;
  prerollInfo: PrerollInfo;
  candidateRace: CandidateTimingEntry[];
  selectedCandidate?: string;
  suspectedCause: DelayCause;
  avoidedPrerollWaitMs: number;
  completed: boolean;
  logged: boolean;
}

export class PlaybackTimingManager {
  private currentSession: PlaybackSessionDiagnostics | null = null;
  private sessionHistory: PlaybackSessionDiagnostics[] = [];
  private readonly maxHistory = 30;
  private debugLogging = false;

  constructor(debugLogging = false) {
    this.debugLogging = debugLogging;
  }

  public setDebugLogging(enabled: boolean): void {
    this.debugLogging = enabled;
  }

  public isDebugLogging(): boolean {
    return this.debugLogging;
  }

  /**
   * Begins or resumes tracking for a video playback session.
   * If a new videoId is provided, the previous active session is finalized.
   */
  public startSession(videoId: string): PlaybackSessionDiagnostics {
    if (this.currentSession && this.currentSession.videoId !== videoId) {
      this.finalizeSession();
    }

    if (!this.currentSession) {
      this.currentSession = {
        videoId,
        startTime: Date.now(),
        timestamps: {},
        prerollInfo: { hasPreroll: false, adCount: 0, estimatedDurationMs: 0 },
        candidateRace: [],
        suspectedCause: DelayCause.NONE,
        avoidedPrerollWaitMs: 0,
        completed: false,
        logged: false
      };
    }

    return this.currentSession;
  }

  public getCurrentSession(): PlaybackSessionDiagnostics | null {
    return this.currentSession;
  }

  /**
   * Records a timestamped milestone.
   */
  public recordMilestone(
    milestone: TimingMilestone,
    videoId?: string,
    time = Date.now()
  ): void {
    if (!this.currentSession || (videoId && this.currentSession.videoId !== videoId)) {
      if (videoId) {
        this.startSession(videoId);
      } else {
        return;
      }
    }

    const session = this.currentSession!;
    if (session.timestamps[milestone] === undefined) {
      session.timestamps[milestone] = time;
    }

    if (milestone === "VIDEO_PLAYING") {
      session.completed = true;
      this.evaluateAndLog();
    }
  }

  /**
   * Sets preroll metadata extracted from the original unsanitized response.
   */
  public setPrerollInfo(info: PrerollInfo, videoId?: string): void {
    if (videoId && (!this.currentSession || this.currentSession.videoId !== videoId)) {
      this.startSession(videoId);
    }
    if (this.currentSession) {
      this.currentSession.prerollInfo = { ...info };
      if (info.hasPreroll) {
        this.recordMilestone("PLAYER_RESPONSE_HAS_ADS");
      }
    }
  }

  /**
   * Records race candidate execution status.
   */
  public recordCandidateResult(entry: CandidateTimingEntry, videoId?: string): void {
    if (videoId && (!this.currentSession || this.currentSession.videoId !== videoId)) {
      this.startSession(videoId);
    }
    if (this.currentSession) {
      this.currentSession.candidateRace.push(entry);
    }
  }

  public setSelectedCandidate(candidateId: string, videoId?: string): void {
    if (videoId && (!this.currentSession || this.currentSession.videoId !== videoId)) {
      this.startSession(videoId);
    }
    if (this.currentSession) {
      this.currentSession.selectedCandidate = candidateId;
    }
  }

  /**
   * Evaluates the suspected delay cause.
   */
  public evaluateDelayCause(session: PlaybackSessionDiagnostics): DelayCause {
    const ts = session.timestamps;
    const respReturned = ts.PLAYER_RESPONSE_RETURNED_TO_YOUTUBE || ts.PLAYER_RESPONSE_RECEIVED;
    const contentRequest = ts.CONTENT_MEDIA_REQUEST_STARTED;
    const firstMediaData = ts.CONTENT_MEDIA_FIRST_RESPONSE;
    const playing = ts.VIDEO_PLAYING;

    if (!session.prerollInfo.hasPreroll) {
      return DelayCause.NONE;
    }

    // 1. Client-side wait check:
    // If response was returned to YouTube, but the player sat idle before requesting content media
    if (respReturned && contentRequest) {
      const waitBeforeRequest = contentRequest - respReturned;
      if (waitBeforeRequest >= 1500) {
        return DelayCause.PLAYER_SIDE_WAIT;
      }
    }

    // 2. Server-side / SABR backoff check:
    // If media was requested promptly, but firstMediaData was withheld/delayed
    if (contentRequest && firstMediaData) {
      const mediaDelay = firstMediaData - contentRequest;
      if (mediaDelay >= 2000) {
        return DelayCause.SERVER_PREROLL_BACKOFF;
      }
    }

    // 3. Fallback check: overall startup delay relative to expected preroll duration
    if (respReturned && playing) {
      const totalStartup = playing - respReturned;
      if (totalStartup > 2500) {
        return DelayCause.SERVER_PREROLL_BACKOFF;
      }
      return DelayCause.NONE;
    }

    return DelayCause.NONE;
  }

  /**
   * Formats timing report and outputs to console if debugging or finalizing.
   */
  public evaluateAndLog(): void {
    if (!this.currentSession || this.currentSession.logged) return;

    const session = this.currentSession;
    session.suspectedCause = this.evaluateDelayCause(session);

    // Calculate avoided wait
    const estimatedPreroll = session.prerollInfo.estimatedDurationMs || 0;
    const baseTime = session.timestamps.PLAYER_RESPONSE_RECEIVED || session.startTime;
    const playingTime = session.timestamps.VIDEO_PLAYING;

    if (session.prerollInfo.hasPreroll && estimatedPreroll > 0 && playingTime) {
      const actualStartup = Math.max(0, playingTime - baseTime);
      session.avoidedPrerollWaitMs = Math.max(0, estimatedPreroll - actualStartup);
    }

    session.logged = true;

    // Output formatted timing diagnostic
    const formatOffset = (t?: number) => {
      if (t === undefined) return "N/A";
      const diff = t - baseTime;
      return diff >= 0 ? `+${diff.toLocaleString()} ms` : `${diff.toLocaleString()} ms`;
    };

    const lines = [
      `[YTCLEAN:TIMING] Video: ${session.videoId}`,
      `playerResponse: 0 ms`,
      `sanitized: ${formatOffset(session.timestamps.PLAYER_RESPONSE_RETURNED_TO_YOUTUBE)}`,
      `contentRequest: ${formatOffset(session.timestamps.CONTENT_MEDIA_REQUEST_STARTED)}`,
      `firstMediaData: ${formatOffset(session.timestamps.CONTENT_MEDIA_FIRST_RESPONSE)}`,
      `playing: ${formatOffset(session.timestamps.VIDEO_PLAYING)}`,
      ``,
      `suspectedCause: ${session.suspectedCause}`
    ];

    if (session.prerollInfo.hasPreroll) {
      lines.push(`estimatedPreroll: ${(estimatedPreroll / 1000).toFixed(1)} sec`);
      if (session.avoidedPrerollWaitMs > 0) {
        lines.push(`avoidedPrerollWait: ~${(session.avoidedPrerollWaitMs / 1000).toFixed(1)} sec`);
      }
    }

    if (session.selectedCandidate) {
      lines.push(`selectedCandidate: ${session.selectedCandidate}`);
    }

    console.log(lines.join("\n"));
  }

  /**
   * Safely monitors media requests without ever saving tokens or auth headers.
   */
  public monitorMediaRequest(urlStr: string, isStart: boolean): void {
    // Only target YouTube content media requests
    if (!urlStr.includes("/videoplayback") && !urlStr.includes("googlevideo.com")) {
      return;
    }

    const now = Date.now();
    if (isStart) {
      if (this.currentSession && !this.currentSession.timestamps.CONTENT_MEDIA_REQUEST_STARTED) {
        this.recordMilestone("CONTENT_MEDIA_REQUEST_STARTED", undefined, now);
      }
    } else {
      if (this.currentSession && !this.currentSession.timestamps.CONTENT_MEDIA_FIRST_RESPONSE) {
        this.recordMilestone("CONTENT_MEDIA_FIRST_RESPONSE", undefined, now);
      }
    }
  }

  /**
   * Binds HTMLVideoElement playback event listeners.
   */
  public attachVideoElement(video: HTMLVideoElement, videoId: string): () => void {
    const onLoadedMetadata = () => {
      this.recordMilestone("VIDEO_METADATA_LOADED", videoId);
    };
    const onCanPlay = () => {
      this.recordMilestone("VIDEO_CANPLAY", videoId);
    };
    const onPlaying = () => {
      this.recordMilestone("VIDEO_PLAYING", videoId);
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("canplay", onCanPlay, { once: true });
    video.addEventListener("playing", onPlaying, { once: true });

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
    };
  }

  public finalizeSession(): void {
    if (this.currentSession) {
      if (!this.currentSession.logged) {
        this.evaluateAndLog();
      }
      this.sessionHistory.push(this.currentSession);
      if (this.sessionHistory.length > this.maxHistory) {
        this.sessionHistory.shift();
      }
      this.currentSession = null;
    }
  }

  public getHistory(): PlaybackSessionDiagnostics[] {
    return [...this.sessionHistory];
  }

  public reset(): void {
    this.currentSession = null;
    this.sessionHistory = [];
  }
}

// Global singleton instance for the main world
export const globalPlaybackTiming = new PlaybackTimingManager();
