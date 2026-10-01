import { HEALTH_CONFIG } from "../config/youtube";
import type { BlockerEvent } from "../types/events";

export class HealthMonitor {
  private errorTimestamps: number[] = [];
  private isDegraded = false;

  constructor(
    private readonly maxErrors: number = HEALTH_CONFIG.maxErrorsInWindow,
    private readonly windowMs: number = HEALTH_CONFIG.windowDurationMs,
    private readonly onDegraded?: (reason: string) => void,
    private readonly onEvent?: (event: BlockerEvent) => void
  ) {}

  public recordError(subsystem: string, error: unknown): void {
    const now = Date.now();
    this.errorTimestamps.push(now);

    const message = error instanceof Error ? error.message : String(error);
    this.onEvent?.({
      type: "ERROR",
      subsystem,
      message
    });

    this.checkHealth(now);
  }

  private checkHealth(now: number): void {
    // Purge timestamps outside the rolling window
    this.errorTimestamps = this.errorTimestamps.filter((t) => now - t <= this.windowMs);

    if (!this.isDegraded && this.errorTimestamps.length >= this.maxErrors) {
      this.isDegraded = true;
      const reason = `Encountered ${this.errorTimestamps.length} failures within ${this.windowMs / 1000}s window. Disabling response rewriting to preserve playback.`;

      this.onEvent?.({
        type: "HEALTH_DEGRADED",
        reason
      });

      this.onDegraded?.(reason);
    }
  }

  public getStatus(): { isDegraded: boolean; recentErrorCount: number } {
    const now = Date.now();
    this.errorTimestamps = this.errorTimestamps.filter((t) => now - t <= this.windowMs);
    return {
      isDegraded: this.isDegraded,
      recentErrorCount: this.errorTimestamps.length
    };
  }

  public reset(): void {
    this.errorTimestamps = [];
    this.isDegraded = false;
  }
}
