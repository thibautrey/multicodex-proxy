import assert from "node:assert/strict";
import test from "node:test";
import { GITHUB_PROMOTION_DELAY_MS, dismissGitHubPromotion, readGitHubPromotionState } from "../src/github-promotion";

function storage(entries: Record<string, string> = {}) {
  return { getItem: (key: string) => entries[key] ?? null, setItem: (key: string, value: string) => { entries[key] = value; }, entries };
}

test("starts the delay on the first visit", () => {
  const store = storage();
  const now = 1_800_000_000_000;
  assert.equal(readGitHubPromotionState(store, now).showAt, now + GITHUB_PROMOTION_DELAY_MS);
  assert.equal(store.entries.githubPromotionFirstSeenAt, String(now));
});

test("keeps the original visit date and persists dismissal", () => {
  const firstSeenAt = 1_800_000_000_000;
  const store = storage({ githubPromotionFirstSeenAt: String(firstSeenAt) });
  assert.equal(readGitHubPromotionState(store, firstSeenAt + GITHUB_PROMOTION_DELAY_MS).showAt, firstSeenAt + GITHUB_PROMOTION_DELAY_MS);
  dismissGitHubPromotion(store);
  assert.equal(readGitHubPromotionState(store).dismissed, true);
});
