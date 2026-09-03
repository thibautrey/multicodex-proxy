import assert from "node:assert/strict";
import test from "node:test";
import {
  completeHostOnboarding,
  hasCompletedHostOnboarding,
  shouldShowHostOnboarding,
} from "../src/host-onboarding";

test("host onboarding is incomplete until it is explicitly completed", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(hasCompletedHostOnboarding(storage), false);
  completeHostOnboarding(storage);
  assert.equal(hasCompletedHostOnboarding(storage), true);
});

test("host onboarding only opens for an unfinished Host dashboard", () => {
  const firstHostRun = {
    baseLoaded: true,
    completed: false,
    hostApplication: true,
    sanitized: false,
  };

  assert.equal(shouldShowHostOnboarding(firstHostRun), true);
  assert.equal(shouldShowHostOnboarding({ ...firstHostRun, baseLoaded: false }), false);
  assert.equal(shouldShowHostOnboarding({ ...firstHostRun, completed: true }), false);
  assert.equal(shouldShowHostOnboarding({ ...firstHostRun, hostApplication: false }), false);
  assert.equal(shouldShowHostOnboarding({ ...firstHostRun, sanitized: true }), false);
});
