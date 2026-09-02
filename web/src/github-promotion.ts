export const GITHUB_REPOSITORY_URL = "https://github.com/thibautrey/multivibe";
export const GITHUB_STARS_URL = `${GITHUB_REPOSITORY_URL}/stargazers`;
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPOSITORY_URL}/issues/new`;
export const GITHUB_PROMOTION_DELAY_MS = 3 * 24 * 60 * 60 * 1_000;

const FIRST_SEEN_STORAGE_KEY = "githubPromotionFirstSeenAt";
const DISMISSED_STORAGE_KEY = "githubPromotionDismissed";

export function readGitHubPromotionState(storage: Pick<Storage, "getItem" | "setItem">, now = Date.now()) {
  const stored = Number(storage.getItem(FIRST_SEEN_STORAGE_KEY));
  const valid = Number.isFinite(stored) && stored > 0;
  const firstSeenAt = valid ? stored : now;
  if (!valid) storage.setItem(FIRST_SEEN_STORAGE_KEY, String(firstSeenAt));
  return {
    dismissed: storage.getItem(DISMISSED_STORAGE_KEY) === "true",
    showAt: firstSeenAt + GITHUB_PROMOTION_DELAY_MS,
  };
}

export function dismissGitHubPromotion(storage: Pick<Storage, "setItem">) {
  storage.setItem(DISMISSED_STORAGE_KEY, "true");
}
