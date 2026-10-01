import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CosmeticController } from "../src/content/cosmetic-controller";
import { COSMETIC_ATTRIBUTE_DISABLED } from "../src/config/youtube";
import type { BlockerEvent } from "../src/types/events";

describe("CosmeticController", () => {
  let container: HTMLElement;
  let emittedEvents: BlockerEvent[];
  let controller: CosmeticController;

  beforeEach(() => {
    emittedEvents = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    controller = new CosmeticController(document, (ev) => emittedEvents.push(ev));
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(COSMETIC_ATTRIBUTE_DISABLED);
  });

  it("identifies promoted ad slots, tags them, and emits COSMETIC_HIDDEN events", () => {
    const adSlot = document.createElement("ytd-ad-slot-renderer");
    const displayAd = document.createElement("ytd-display-ad-renderer");
    const normalItem = document.createElement("div");
    normalItem.className = "normal-video-card";

    container.appendChild(adSlot);
    container.appendChild(displayAd);
    container.appendChild(normalItem);

    controller.init(true);

    expect(adSlot.getAttribute("data-ytclean-cosmetic")).toBe("true");
    expect(displayAd.getAttribute("data-ytclean-cosmetic")).toBe("true");
    expect(normalItem.hasAttribute("data-ytclean-cosmetic")).toBe(false);

    expect(emittedEvents).toEqual([
      { type: "COSMETIC_HIDDEN", selector: "ytd-ad-slot-renderer" },
      { type: "COSMETIC_HIDDEN", selector: "ytd-display-ad-renderer" }
    ]);

    // Subsequent scan does not re-emit
    controller.scanAndTag();
    expect(emittedEvents.length).toBe(2);
  });

  it("dynamically toggles cosmetic disabled attribute on documentElement", () => {
    controller.init(true);
    expect(document.documentElement.hasAttribute(COSMETIC_ATTRIBUTE_DISABLED)).toBe(false);

    // Disable cosmetic filtering
    controller.setEnabled(false);
    expect(document.documentElement.getAttribute(COSMETIC_ATTRIBUTE_DISABLED)).toBe("true");

    // Re-enable cosmetic filtering
    controller.setEnabled(true);
    expect(document.documentElement.hasAttribute(COSMETIC_ATTRIBUTE_DISABLED)).toBe(false);
  });
});
