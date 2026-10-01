import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaybackTimingManager, DelayCause } from "../src/main/playback-timing";

describe("PlaybackTimingManager", () => {
  let manager: PlaybackTimingManager;

  beforeEach(() => {
    manager = new PlaybackTimingManager(true);
  });

  it("evaluates DelayCause.NONE when no prerolls exist", () => {
    const session = manager.startSession("vid-clean");
    manager.setPrerollInfo({ hasPreroll: false, adCount: 0, estimatedDurationMs: 0 });
    manager.recordMilestone("PLAYER_RESPONSE_RECEIVED", "vid-clean", 1000);
    manager.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", "vid-clean", 1005);
    manager.recordMilestone("CONTENT_MEDIA_REQUEST_STARTED", "vid-clean", 1010);
    manager.recordMilestone("CONTENT_MEDIA_FIRST_RESPONSE", "vid-clean", 1100);
    manager.recordMilestone("VIDEO_PLAYING", "vid-clean", 1200);

    const cause = manager.evaluateDelayCause(session);
    expect(cause).toBe(DelayCause.NONE);
  });

  it("evaluates DelayCause.PLAYER_SIDE_WAIT when player delays requesting media", () => {
    const session = manager.startSession("vid-ad-wait");
    manager.setPrerollInfo({ hasPreroll: true, adCount: 1, estimatedDurationMs: 15000 });
    manager.recordMilestone("PLAYER_RESPONSE_RECEIVED", "vid-ad-wait", 1000);
    manager.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", "vid-ad-wait", 1005);
    // 5 seconds gap before content media is requested:
    manager.recordMilestone("CONTENT_MEDIA_REQUEST_STARTED", "vid-ad-wait", 6005);
    manager.recordMilestone("CONTENT_MEDIA_FIRST_RESPONSE", "vid-ad-wait", 6100);
    manager.recordMilestone("VIDEO_PLAYING", "vid-ad-wait", 6200);

    const cause = manager.evaluateDelayCause(session);
    expect(cause).toBe(DelayCause.PLAYER_SIDE_WAIT);
  });

  it("evaluates DelayCause.SERVER_PREROLL_BACKOFF when media data is withheld/delayed", () => {
    const session = manager.startSession("vid-ad-backoff");
    manager.setPrerollInfo({ hasPreroll: true, adCount: 1, estimatedDurationMs: 15000 });
    manager.recordMilestone("PLAYER_RESPONSE_RECEIVED", "vid-ad-backoff", 1000);
    manager.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", "vid-ad-backoff", 1005);
    // Media requested immediately:
    manager.recordMilestone("CONTENT_MEDIA_REQUEST_STARTED", "vid-ad-backoff", 1015);
    // But first media data delayed by 12 seconds:
    manager.recordMilestone("CONTENT_MEDIA_FIRST_RESPONSE", "vid-ad-backoff", 13015);
    manager.recordMilestone("VIDEO_PLAYING", "vid-ad-backoff", 13100);

    const cause = manager.evaluateDelayCause(session);
    expect(cause).toBe(DelayCause.SERVER_PREROLL_BACKOFF);
  });

  it("formats timing diagnostic output with [YTCLEAN:TIMING]", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    manager.startSession("vid-log-test");
    manager.setPrerollInfo({ hasPreroll: true, adCount: 1, estimatedDurationMs: 15000 });
    manager.recordMilestone("PLAYER_RESPONSE_RECEIVED", "vid-log-test", 1000);
    manager.recordMilestone("PLAYER_RESPONSE_RETURNED_TO_YOUTUBE", "vid-log-test", 1003);
    manager.recordMilestone("CONTENT_MEDIA_REQUEST_STARTED", "vid-log-test", 1008);
    manager.recordMilestone("CONTENT_MEDIA_FIRST_RESPONSE", "vid-log-test", 13050);
    manager.recordMilestone("VIDEO_PLAYING", "vid-log-test", 13150);

    expect(consoleSpy).toHaveBeenCalled();
    const loggedOutput = consoleSpy.mock.calls[0][0];
    expect(loggedOutput).toContain("[YTCLEAN:TIMING]");
    expect(loggedOutput).toContain("playerResponse: 0 ms");
    expect(loggedOutput).toContain("sanitized: +3 ms");
    expect(loggedOutput).toContain("contentRequest: +8 ms");
    expect(loggedOutput).toContain("firstMediaData: +12,050 ms");
    expect(loggedOutput).toContain("suspectedCause: SERVER_PREROLL_BACKOFF");

    consoleSpy.mockRestore();
  });

  it("safely ignores non-media requests and does not expose tokens", () => {
    manager.startSession("vid-token-test");
    manager.monitorMediaRequest("https://www.youtube.com/api/stats/watchtime?ns=yt&docid=123", true);
    expect(manager.getCurrentSession()?.timestamps.CONTENT_MEDIA_REQUEST_STARTED).toBeUndefined();

    manager.monitorMediaRequest("https://rr1---sn-xxx.googlevideo.com/videoplayback?expire=123&signature=secret_token", true);
    expect(manager.getCurrentSession()?.timestamps.CONTENT_MEDIA_REQUEST_STARTED).toBeDefined();
  });
});
