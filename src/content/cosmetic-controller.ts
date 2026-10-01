import {
  PROMOTED_SELECTORS,
  COSMETIC_ATTRIBUTE_DISABLED
} from "../config/youtube";
import type { BlockerEvent } from "../types/events";

export class CosmeticController {
  private observer: MutationObserver | null = null;
  private isEnabled = true;

  constructor(
    private readonly rootElement: Document | HTMLElement = document,
    private readonly onEvent?: (event: BlockerEvent) => void
  ) {}

  public init(initialEnabled = true): void {
    this.setEnabled(initialEnabled);
    this.scanAndTag();

    this.observer = new MutationObserver(() => {
      if (this.isEnabled) {
        this.scanAndTag();
      }
    });

    const target =
      this.rootElement instanceof Document
        ? this.rootElement.documentElement || this.rootElement
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
          this.scanAndTag();
        },
        { once: true }
      );
    }
  }

  public scanAndTag(): void {
    if (!this.isEnabled) return;

    for (const selector of PROMOTED_SELECTORS) {
      try {
        const matches = this.rootElement.querySelectorAll<HTMLElement>(selector);
        for (const el of Array.from(matches)) {
          if (!el.hasAttribute("data-ytclean-cosmetic")) {
            el.setAttribute("data-ytclean-cosmetic", "true");
            this.onEvent?.({
              type: "COSMETIC_HIDDEN",
              selector
            });
          }
        }
      } catch {
        // Some complex pseudo-class selectors like :has() may fail in older environments
      }
    }
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;

    const root = this.rootElement as any;
    const docEl: HTMLElement | null =
      root?.documentElement || root?.ownerDocument?.documentElement || null;

    if (docEl) {
      if (enabled) {
        docEl.removeAttribute(COSMETIC_ATTRIBUTE_DISABLED);
        this.scanAndTag();
      } else {
        docEl.setAttribute(COSMETIC_ATTRIBUTE_DISABLED, "true");
      }
    }
  }

  public destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
