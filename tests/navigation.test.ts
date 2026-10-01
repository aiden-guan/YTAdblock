import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NavigationManager } from "../src/content/fallback";
import type { BlockerEvent } from "../src/types/events";

describe("NavigationManager & SPA Lifecycle", () => {
  let emittedEvents: BlockerEvent[];
  let container: HTMLElement;

  beforeEach(() => {
    emittedEvents = [];
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts WatchAdapter on watch pages and switches to ShortsAdapter on shorts pages", () => {
    // Mock location
    Object.defineProperty(window, "location", {
      value: {
        href: "https://www.youtube.com/watch?v=abc",
        pathname: "/watch",
        origin: "https://www.youtube.com"
      },
      writable: true
    });

    const nav = new NavigationManager(container, (ev) => emittedEvents.push(ev));
    nav.init();

    expect(nav.getCurrentAdapter()?.pageType).toBe("watch");

    // Navigate to Shorts
    window.location.pathname = "/shorts/xyz";
    window.location.href = "https://www.youtube.com/shorts/xyz";
    window.dispatchEvent(new Event("yt-navigate-finish"));

    expect(nav.getCurrentAdapter()?.pageType).toBe("shorts");

    // Navigate back to watch
    window.location.pathname = "/watch";
    window.location.href = "https://www.youtube.com/watch?v=def";
    window.dispatchEvent(new Event("yt-navigate-finish"));

    expect(nav.getCurrentAdapter()?.pageType).toBe("watch");

    nav.destroy();
  });

  it("is idempotent and handles multiple navigation events without duplicating observers", () => {
    Object.defineProperty(window, "location", {
      value: {
        href: "https://www.youtube.com/watch?v=abc",
        pathname: "/watch",
        origin: "https://www.youtube.com"
      },
      writable: true
    });

    const nav = new NavigationManager(container);
    nav.init();

    const adapter1 = nav.getCurrentAdapter();
    expect(adapter1?.pageType).toBe("watch");

    // Fire repeated YouTube navigation events
    window.dispatchEvent(new Event("yt-navigate-start"));
    window.dispatchEvent(new Event("yt-navigate-finish"));
    window.dispatchEvent(new Event("yt-page-data-updated"));

    // Adapter remains the same instance
    expect(nav.getCurrentAdapter()).toBe(adapter1);

    nav.destroy();
    expect(nav.getCurrentAdapter()).toBeNull();
  });

  it("resets transient ad state when yt-navigate-start fires", () => {
    Object.defineProperty(window, "location", {
      value: {
        href: "https://www.youtube.com/watch?v=abc",
        pathname: "/watch",
        origin: "https://www.youtube.com"
      },
      writable: true
    });

    const nav = new NavigationManager(container);
    nav.init();

    const adapter = nav.getCurrentAdapter();
    const resetSpy = vi.fn();
    if (adapter) {
      adapter.resetForNavigation = resetSpy;
    }

    window.dispatchEvent(new Event("yt-navigate-start"));
    expect(resetSpy).toHaveBeenCalled();

    nav.destroy();
  });
});
