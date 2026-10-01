import { NAVIGATION_EVENTS } from "../config/youtube";
import type { BlockerEvent } from "../types/events";
import type { PageAdapter } from "./adapters/base";
import { WatchAdapter } from "./adapters/watch";
import { ShortsAdapter } from "./adapters/shorts";
import { AntiAdblockInterruptionDetector } from "./interruption-detector";

export class NavigationManager {
  private currentAdapter: PageAdapter | null = null;
  private lastUrl = "";
  private interruptionDetector: AntiAdblockInterruptionDetector;
  private observer: MutationObserver | null = null;
  private urlCheckTimer: ReturnType<typeof setInterval> | null = null;
  private boundListeners: Array<{ name: string; handler: EventListener }> = [];

  constructor(
    private readonly rootElement: Document | HTMLElement = document,
    private readonly onEvent?: (event: BlockerEvent) => void
  ) {
    this.interruptionDetector = new AntiAdblockInterruptionDetector(rootElement, onEvent);
  }

  public init(): void {
    if (typeof window === "undefined") return;

    this.lastUrl = window.location.href;
    this.routePage();

    // 1. Listen for YouTube SPA lifecycle events
    for (const evt of NAVIGATION_EVENTS) {
      const handler = () => this.handleNavigationEvent(evt);
      window.addEventListener(evt, handler);
      this.boundListeners.push({ name: evt, handler });
    }

    // 2. Fallback URL polling check for silent pushState
    this.urlCheckTimer = setInterval(() => {
      if (typeof window !== "undefined" && window.location.href !== this.lastUrl) {
        this.lastUrl = window.location.href;
        this.routePage();
      }
    }, 1000);

    // 3. Document-level observer for dialog interruptions
    this.observer = new MutationObserver(() => {
      this.interruptionDetector.attemptRecovery();
    });

    const target = this.rootElement instanceof Document
      ? (this.rootElement.documentElement || this.rootElement)
      : this.rootElement;

    if (target) {
      this.observer.observe(target, {
        childList: true,
        subtree: true
      });
    }

    if (this.rootElement instanceof Document && this.rootElement.readyState === "loading") {
      this.rootElement.addEventListener(
        "DOMContentLoaded",
        () => {
          this.routePage();
          this.interruptionDetector.attemptRecovery();
        },
        { once: true }
      );
    }
  }

  private handleNavigationEvent(eventName: string): void {
    if (typeof window !== "undefined") {
      this.lastUrl = window.location.href;
    }

    if (eventName === "yt-navigate-start") {
      // Clean up transient ad state immediately on departure
      this.currentAdapter?.resetForNavigation?.();
      this.currentAdapter?.update();
    } else {
      this.routePage();
      this.interruptionDetector.attemptRecovery();
    }
  }

  public routePage(): void {
    const pathname = typeof window !== "undefined" ? window.location.pathname : "";
    const isShorts = pathname.startsWith("/shorts");
    const targetType = isShorts ? "shorts" : "watch";

    if (this.currentAdapter && this.currentAdapter.pageType === targetType) {
      // Same adapter: trigger update/rebind
      this.currentAdapter.update();
      return;
    }

    // Switch adapter cleanly
    this.currentAdapter?.unmount();

    if (isShorts) {
      this.currentAdapter = new ShortsAdapter(this.rootElement, this.onEvent);
    } else {
      this.currentAdapter = new WatchAdapter(this.rootElement, this.onEvent);
    }

    this.currentAdapter.mount();
  }

  public getCurrentAdapter(): PageAdapter | null {
    return this.currentAdapter;
  }

  public destroy(): void {
    if (this.urlCheckTimer) {
      clearInterval(this.urlCheckTimer);
      this.urlCheckTimer = null;
    }

    for (const { name, handler } of this.boundListeners) {
      window.removeEventListener(name, handler);
    }
    this.boundListeners = [];

    this.observer?.disconnect();
    this.observer = null;

    this.currentAdapter?.unmount();
    this.currentAdapter = null;
  }
}

// Auto-initialize when executing in content script context
(function initFallbackScript() {
  if (typeof window === "undefined") return;

  const guardKey = Symbol.for("ytclean.fallback.installed");
  const win = window as any;
  if (win[guardKey]) {
    return;
  }
  win[guardKey] = true;

  const emitEvent = (event: BlockerEvent) => {
    try {
      window.dispatchEvent(
        new CustomEvent("ytclean:fallback-event", { detail: event })
      );
    } catch {
      // Ignore boundary errors
    }
  };

  const navManager = new NavigationManager(document, emitEvent);
  navManager.init();
})();
