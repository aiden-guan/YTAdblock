import { describe, it, expect } from "vitest";
import { DiagnosticsManager } from "../src/content/diagnostics";
import { DEFAULT_SETTINGS } from "../src/types/events";

describe("DiagnosticsManager", () => {
  it("tracks cumulative counters accurately across multiple event types", () => {
    const manager = new DiagnosticsManager(DEFAULT_SETTINGS);

    manager.recordEvent({ type: "PLAYER_RESPONSE_SEEN" });
    manager.recordEvent({ type: "PLAYER_RESPONSE_SANITIZED", removed: ["adPlacements"] });
    manager.recordEvent({ type: "AD_POSSIBLE", signals: ["container"] });
    manager.recordEvent({ type: "AD_CONFIRMED", signals: ["ad-showing"] });
    manager.recordEvent({ type: "SKIP_CLICKED" });
    manager.recordEvent({ type: "AD_ACCELERATED" });
    manager.recordEvent({ type: "COSMETIC_HIDDEN", selector: "ytd-ad-slot-renderer" });
    manager.recordEvent({ type: "ANTI_ADBLOCK_DISMISSED" });
    manager.recordEvent({ type: "ERROR", subsystem: "SANITIZER", message: "fail" });
    manager.recordEvent({ type: "ERROR", subsystem: "PLAYER", message: "fail" });

    const counters = manager.getCounters();
    expect(counters.playerResponseSeen).toBe(1);
    expect(counters.playerResponsesSanitized).toBe(1);
    expect(counters.adsPrevented).toBe(1);
    expect(counters.adsFallbackHandled).toBe(2);
    expect(counters.fallbackActivations).toBe(2);
    expect(counters.promotedElementsHidden).toBe(1);
    expect(counters.antiAdblockDismissals).toBe(1);
    expect(counters.confirmedAds).toBe(1);
    expect(counters.falseRecoveryCandidates).toBe(1);
    expect(counters.sanitizerErrors).toBe(1);
    expect(counters.playerErrors).toBe(1);
    expect(counters.errors).toBe(2);
  });

  it("caps event ring buffer at maxBufferSize and evicts oldest items", () => {
    const manager = new DiagnosticsManager(DEFAULT_SETTINGS, 5);

    for (let i = 0; i < 10; i++) {
      manager.recordEvent({ type: "PLAYER_RESPONSE_SANITIZED", removed: [`ad_${i}`] });
    }

    const events = manager.getRecentEvents();
    expect(events.length).toBe(5);
    // Oldest surviving should be ad_5
    expect((events[0].event as any).removed).toEqual(["ad_5"]);
    expect((events[4].event as any).removed).toEqual(["ad_9"]);
  });

  it("generates sanitized export report without personal identifiers", () => {
    const manager = new DiagnosticsManager(DEFAULT_SETTINGS);
    manager.recordEvent({ type: "PLAYER_RESPONSE_SEEN" });

    const report = manager.generateExportReport("1.0.0", false, 0);

    expect(report.extensionVersion).toBe("1.0.0");
    expect(report.counters).toBeDefined();
    expect(report.settings.protectionEnabled).toBe(true);
    expect(report.recentEvents.length).toBe(1);

    // Verify no private data leaked
    const jsonStr = JSON.stringify(report);
    expect(jsonStr).not.toContain("cookie");
    expect(jsonStr).not.toContain("authorization");
    expect(jsonStr).not.toContain("password");
    expect(jsonStr).not.toContain("email");
  });
});
