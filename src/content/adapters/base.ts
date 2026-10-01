export interface PageAdapter {
  readonly pageType: "watch" | "shorts" | "other";
  mount(): void;
  unmount(): void;
  update(): void;
  resetForNavigation?(): void;
}
