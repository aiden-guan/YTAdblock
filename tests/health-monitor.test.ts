import { describe, it, expect, vi, beforeEach } from "vitest";
import { HealthMonitor } from "../src/content/health-monitor";
import type { BlockerEvent } from "../src/types/events";

describe("HealthMonitor", () => {
  let emittedEvents: BlockerEvent[];
  let degradedReason: string | null;

  beforeEach(() => {
    emittedEvents = [];
    degradedReason = null;
  });

  it("remains healthy when error count stays below threshold", () => {
    const monitor = new HealthMonitor(
      3,
      30_000,
      (reason) => { degradedReason = reason; },
      (ev) => emittedEvents.push(ev)
    );

    monitor.recordError("SANITIZER", new Error("Minor glitch"));
    monitor.recordError("SANITIZER", new Error("Minor glitch 2"));

    const status = monitor.getStatus();
    expect(status.isDegraded).toBe(false);
    expect(status.recentErrorCount).toBe(2);
    expect(degradedReason).toBeNull();
  });

  it("triggers degradation when 3 errors occur within the window", () => {
    const monitor = new HealthMonitor(
      3,
      30_000,
      (reason) => { degradedReason = reason; },
      (ev) => emittedEvents.push(ev)
    );

    monitor.recordError("SANITIZER", "Error 1");
    monitor.recordError("SANITIZER", "Error 2");
    monitor.recordError("SANITIZER", "Error 3");

    const status = monitor.getStatus();
    expect(status.isDegraded).toBe(true);
    expect(status.recentErrorCount).toBe(3);
    expect(degradedReason).toContain("Disabling response rewriting to preserve playback");

    expect(emittedEvents).toContainEqual(
      expect.objectContaining({ type: "HEALTH_DEGRADED" })
    );
  });

  it("resets health state cleanly", () => {
    const monitor = new HealthMonitor(
      3,
      30_000,
      (reason) => { degradedReason = reason; }
    );

    monitor.recordError("SANITIZER", "Error 1");
    monitor.recordError("SANITIZER", "Error 2");
    monitor.recordError("SANITIZER", "Error 3");
    expect(monitor.getStatus().isDegraded).toBe(true);

    monitor.reset();
    expect(monitor.getStatus().isDegraded).toBe(false);
    expect(monitor.getStatus().recentErrorCount).toBe(0);
  });
});
