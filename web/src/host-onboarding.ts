const HOST_ONBOARDING_COMPLETED_KEY = "multivibeHostOnboardingCompleted";

export function hasCompletedHostOnboarding(
  storage: Pick<Storage, "getItem">,
): boolean {
  return storage.getItem(HOST_ONBOARDING_COMPLETED_KEY) === "true";
}

export function completeHostOnboarding(
  storage: Pick<Storage, "setItem">,
): void {
  storage.setItem(HOST_ONBOARDING_COMPLETED_KEY, "true");
}

export function shouldShowHostOnboarding(options: {
  baseLoaded: boolean;
  completed: boolean;
  hostApplication: boolean;
  sanitized: boolean;
}): boolean {
  return options.baseLoaded &&
    options.hostApplication &&
    !options.completed &&
    !options.sanitized;
}
