import { SKIP_SELECTORS, AD_CONTAINER_SELECTORS } from "../config/youtube";

export interface AdSignal {
  name:
    | "AD_SHOWING_CLASS"
    | "SKIP_BUTTON_VISIBLE"
    | "AD_CONTAINER_VISIBLE"
    | "AD_TEXT_PRESENT"
    | "AD_MODULE_CHILDREN";
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
      weight: 3,
      detail: "Player is in YouTube's explicit ad-showing/ad-interrupting state"
    });
  }

  for (const selector of SKIP_SELECTORS) {
    const btn = playerElement.querySelector<HTMLElement>(selector);
    if (btn && isElementVisible(btn)) {
      skipButton = btn;
      signals.push({
        name: "SKIP_BUTTON_VISIBLE",
        weight: 2,
        detail: `Visible skip button detected with selector: ${selector}`
      });
      break;
    }
  }

  for (const selector of AD_CONTAINER_SELECTORS) {
    const container = playerElement.querySelector<HTMLElement>(selector);
    if (container && isElementVisible(container)) {
      signals.push({
        name: "AD_CONTAINER_VISIBLE",
        weight: 1,
        detail: `Visible ad container: ${selector}`
      });
      break;
    }
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

  // YouTube itself adding ad-showing/ad-interrupting is a strong, explicit signal.
  // Waiting for a second DOM signal creates a visible delay and is unnecessary.
  const isConfirmedAd =
    hasAdShowingClass ||
    (skipButton !== null && score >= 3) ||
    score >= 4;

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
