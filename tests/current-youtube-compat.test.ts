import { describe, it, expect } from "vitest";
import { capturePlayerRequestPayload } from "../src/main/fetch-interceptor";
import { validateAlternatePlayerResponse } from "../src/main/alternate-player/response-validator";
import { AlternatePlayerManager } from "../src/main/alternate-player/alternate-player";
import { PlayerClientPool } from "../src/main/alternate-player/client-pool";

describe("current YouTube request compatibility", () => {
  it("captures JSON payload from a Request object without consuming the original body", async () => {
    const request = new Request(
      "https://www.youtube.com/youtubei/v1/player?key=abc&prettyPrint=false",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: "request-object-video",
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20260915.01.00",
              visitorData: "visitor"
            }
          }
        })
      }
    );

    const payload = await capturePlayerRequestPayload(request);

    expect(payload?.videoId).toBe("request-object-video");
    expect(request.bodyUsed).toBe(false);
    expect(await request.clone().json()).toEqual(
      expect.objectContaining({ videoId: "request-object-video" })
    );
  });

  it("prefers init.body when fetch uses url + RequestInit", async () => {
    const payload = await capturePlayerRequestPayload(
      "https://www.youtube.com/youtubei/v1/player",
      {
        method: "POST",
        body: JSON.stringify({
          videoId: "init-body-video",
          context: { client: { clientName: "WEB" } }
        })
      }
    );

    expect(payload?.videoId).toBe("init-body-video");
  });

  it("accepts a clean SABR-only player response", () => {
    const response = {
      playabilityStatus: { status: "OK" },
      videoDetails: {
        videoId: "sabr-video",
        lengthSeconds: "120"
      },
      streamingData: {
        serverAbrStreamingUrl:
          "https://example.googlevideo.com/videoplayback?sabr=1"
      }
    };

    expect(
      validateAlternatePlayerResponse(response, "sabr-video")
    ).toBe(true);
  });

  it("uses a true third-party embed URL for WEB_EMBEDDED_PLAYER context", () => {
    const pool = new PlayerClientPool();
    const manager = new AlternatePlayerManager(pool, async () => {
      throw new Error("not used");
    });

    const candidate = pool.getProfile("web-embedded");
    expect(candidate).toBeDefined();

    const payload = manager.buildCandidatePayload(
      {
        videoId: "embed-video",
        context: {
          client: {
            clientName: "WEB",
            visitorData: "visitor"
          }
        }
      },
      candidate!,
      "embed-video"
    ) as any;

    expect(payload.context.client.clientName).toBe("WEB_EMBEDDED_PLAYER");
    expect(payload.context.client.visitorData).toBe("visitor");
    expect(payload.context.thirdParty.embedUrl).toBe(
      "https://www.reddit.com/"
    );
  });
});
