import type { PageAdapter } from "./base";
import { PlaybackStateMachine } from "../state-machine";
import type { BlockerEvent } from "../../types/events";

export class WatchAdapter implements PageAdapter {
  public readonly pageType = "watch";
  private stateMachine: PlaybackStateMachine | null = null;
  private currentPlayerElement: HTMLElement | null = null;
  private observer: MutationObserver | null = null;

  constructor(
    private readonly rootElement: Document | HTMLElement = document,
    private readonly onEvent?: (event: BlockerEvent) => void
  ) {}

  public mount(): void {
    this.bindPlayer();

    // Observe document for dynamic player insertion/replacement
    this.observer = new MutationObserver(() => {
      const el = this.rootElement.querySelector<HTMLElement>("#movie_player");
      if (el && el !== this.currentPlayerElement) {
        this.bindPlayer();
      }
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
          this.bindPlayer();
        },
        { once: true }
      );
    }
  }

  private bindPlayer(): void {
    const el = this.rootElement.querySelector<HTMLElement>("#movie_player");
    if (!el) {
      return;
    }

    if (this.currentPlayerElement === el && this.stateMachine) {
      return;
    }

    this.stateMachine?.destroy();
    this.currentPlayerElement = el;
    this.stateMachine = new PlaybackStateMachine(el, this.onEvent);
    this.stateMachine.attachObserver();
  }

  public update(): void {
    this.bindPlayer();
    this.stateMachine?.update();
  }

  public resetForNavigation(): void {
    this.stateMachine?.resetForNavigation();
  }

  public unmount(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.stateMachine?.destroy();
    this.stateMachine = null;
    this.currentPlayerElement = null;
  }
}
