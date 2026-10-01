import { SKIP_SELECTORS, AD_CONTAINER_SELECTORS } from "../config/youtube";

export interface AdSignal {
  name:
    | "AD_SHOWING_CLASS"
    | "SKIP_BUTTON_VISIBLE"
    | "AD_CONTAINER_VISIBLE"
    | "AD_TEXT_PRESENT"
    | "AD_MODULE_CHILDREN"
    | "ADVERTISER_UI_VISIBLE";
  weight: number;
  detail: string;
}

export interface AdDetectionResult {
  signals: AdSignal[];
  score: number;
  hasAdShowingClass: boolean;
  isConfirmedAd: boolean;
  isPossibleAd: boolean;
  skipButtonElement: HTMLElement | null;
}

export function isElementVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hidden) return false;

  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (style) {
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
  }

  return (
    el.offsetWidth > 0 ||
    el.offsetHeight > 0 ||
    el.getClientRects().length > 0
  );
}

export function detectAdSignals(
  playerElement: HTMLElement | null
): AdDetectionResult {
  const signals: AdSignal[] = [];
  let skipButton: HTMLElement | null = null;

  if (!playerElement) {
    return {
      signals: [],
      score: 0,
      hasAdShowingClass: false,
      isConfirmedAd: false,
      isPossibleAd: false,
      skipButtonElement: null
    };
  }

  const hasAdShowingClass =
    playerElement.classList.contains("ad-showing") ||
    playerElement.classList.contains("ad-interrupting");

  if (hasAdShowingClass) {
    signals.push({
      name: "AD_SHOWING_CLASS",
      weight: 4,
      detail: "Player is in YouTube's explicit ad-showing/ad-interrupting state"
    });
  }

  for (const selector of SKIP_SELECTORS) {
    const btn = playerElement.querySelector<HTMLElement>(selector);
    if (btn && isElementVisible(btn)) {
      skipButton = btn;
      signals.push({
        name: "SKIP_BUTTON_VISIBLE",
        weight: 3,
        detail: `Visible skip control detected with selector: ${selector}`
      });
      break;
    }
  }

  for (const selector of AD_CONTAINER_SELECTORS) {
    const container = playerElement.querySelector<HTMLElement>(selector);
    if (container && isElementVisible(container)) {
      signals.push({
        name: "AD_CONTAINER_VISIBLE",
        weight: 2,
        detail: `Visible ad container: ${selector}`
      });
      break;
    }
  }

  const advertiserUi = playerElement.querySelector<HTMLElement>(
    ".ytp-visit-advertiser-link, .ytp-visit-advertiser-link__text, .ytp-ad-player-overlay-flyout-cta"
  );

  if (advertiserUi && isElementVisible(advertiserUi)) {
    signals.push({
      name: "ADVERTISER_UI_VISIBLE",
      weight: 3,
      detail: "Visible advertiser CTA / visit-advertiser UI detected"
    });
  }

  const adText = playerElement.querySelector<HTMLElement>(
    ".ytp-ad-text, .ytp-ad-duration-remaining"
  );
  if (
    adText &&
    isElementVisible(adText) &&
    (adText.textContent?.trim().length ?? 0) > 0
  ) {
    signals.push({
      name: "AD_TEXT_PRESENT",
      weight: 1,
      detail: `Ad text active: "${adText.textContent?.trim().slice(0, 30)}"`
    });
  }

  const adModule =
    playerElement.querySelector<HTMLElement>(".ytp-ad-module");
  if (adModule && adModule.childElementCount > 0) {
    signals.push({
      name: "AD_MODULE_CHILDREN",
      weight: 1,
      detail: `Ad module has ${adModule.childElementCount} children`
    });
  }

  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);

  /**
   * Strong confirmation paths:
   * - explicit player ad class
   * - current skip control + any independent ad UI
   * - advertiser CTA + another ad UI signal
   *
   * This covers the modern end-card shown in the user's screenshot without
   * treating a generic button or ordinary video overlay as an ad by itself.
   */
  const isConfirmedAd =
    hasAdShowingClass ||
    (skipButton !== null && score >= 5) ||
    (signals.some((s) => s.name === "ADVERTISER_UI_VISIBLE") && score >= 5) ||
    score >= 7;

  const isPossibleAd = !isConfirmedAd && signals.length > 0;

  return {
    signals,
    score,
    hasAdShowingClass,
    isConfirmedAd,
    isPossibleAd,
    skipButtonElement: skipButton
  };
}
