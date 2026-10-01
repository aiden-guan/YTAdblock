import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WatchAdapter } from "../src/content/adapters/watch";
import { ShortsAdapter } from "../src/content/adapters/shorts";
import { NavigationManager } from "../src/content/fallback";
import type { BlockerEvent } from "../src/types/events";

describe("document_start execution timing (document.body is initially null)", () => {
  let emittedEvents: BlockerEvent[];

  beforeEach(() => {
    emittedEvents = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("WatchAdapter attaches observer even when body is null at document_start and binds player on later insertion", async () => {
    // Create a mock document where body is initially null
    const fakeDoc = document.implementation.createHTMLDocument("test");
    // Detach body to simulate document_start state before parser creates <body>
    const savedBody = fakeDoc.body;
    fakeDoc.documentElement.removeChild(savedBody);
    expect(fakeDoc.body).toBeNull();

    const adapter = new WatchAdapter(fakeDoc, (ev) => emittedEvents.push(ev));
    // Must not throw or skip observer attach
    expect(() => adapter.mount()).not.toThrow();

    // Now simulate browser parser inserting body and movie_player
    fakeDoc.documentElement.appendChild(savedBody);
    const player = fakeDoc.createElement("div");
    player.id = "movie_player";
    const video = fakeDoc.createElement("video");
    player.appendChild(video);
    savedBody.appendChild(player);

    // Trigger update to verify binding
    adapter.update();
    expect(fakeDoc.querySelector("#movie_player")).toBe(player);

    adapter.unmount();
  });

  it("NavigationManager initializes cleanly at document_start without throwing", () => {
    const fakeDoc = document.implementation.createHTMLDocument("test");
    const savedBody = fakeDoc.body;
    fakeDoc.documentElement.removeChild(savedBody);
    expect(fakeDoc.body).toBeNull();

    const nav = new NavigationManager(fakeDoc);
    expect(() => nav.init()).not.toThrow();
    nav.destroy();
  });
});
