import type { BlockerEvent, PlayerResponseSource } from "../types/events";
import { installFetchInterceptor } from "./fetch-interceptor";
import { installInitialPlayerResponseHook } from "./initial-response";
import { installXhrInterceptor } from "./xhr-interceptor";
import { BRIDGE_EVENT_MAIN_TO_ISOLATED } from "../config/youtube";
import { globalPrerollShield } from "./preroll-shield";

export type EventDispatcher = (event: BlockerEvent) => void;

/**
 * Default Main-World player response interception source.
 * Operates in the page's MAIN execution world at document_start.
 */
export class MainWorldPlayerResponseSource implements PlayerResponseSource {
  private teardownFetch?: () => void;
  private teardownInitial?: () => void;
  private teardownXhr?: () => void;
  private isRunning = false;

  constructor(
    private readonly targetWindow: Window = window,
    private readonly onEvent?: EventDispatcher
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const dispatch = (event: BlockerEvent) => {
      // Visual protection must happen synchronously in MAIN world before the
      // cross-world event handoff. This avoids document_start listener races.
      globalPrerollShield.handleEvent(event);

      this.onEvent?.(event);
      try {
        // Dispatch custom event across boundary to isolated world content script
        const domEvent = new CustomEvent(BRIDGE_EVENT_MAIN_TO_ISOLATED, {
          detail: event
        });
        this.targetWindow.dispatchEvent(domEvent);
      } catch {
        // Ignore boundary dispatch errors
      }
    };

    this.teardownInitial = installInitialPlayerResponseHook(this.targetWindow, dispatch);
    this.teardownFetch = installFetchInterceptor(this.targetWindow, dispatch);
    this.teardownXhr = installXhrInterceptor(this.targetWindow, dispatch);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.teardownFetch?.();
    this.teardownInitial?.();
    this.teardownXhr?.();
  }
}
