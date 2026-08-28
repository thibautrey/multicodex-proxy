import assert from "node:assert/strict";
import test from "node:test";
import { chooseAccount } from "./quota.js";
import type { Account } from "./types.js";

function account(
  id: string,
  primaryUsedPercent: number | undefined,
  secondaryUsedPercent: number | undefined,
): Account {
  return {
    id,
    accessToken: `token-${id}`,
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      primary:
        primaryUsedPercent === undefined
          ? undefined
          : { usedPercent: primaryUsedPercent },
      secondary:
        secondaryUsedPercent === undefined
          ? undefined
          : { usedPercent: secondaryUsedPercent },
    },
  };
}

test("does not treat a missing quota window as untouched usage", () => {
  const withoutFiveHourQuota = account("without-five-hour", undefined, 0);
  const untouchedOnBothWindows = account("with-five-hour", 0, 0);

  assert.equal(
    chooseAccount([withoutFiveHourQuota, untouchedOnBothWindows])?.id,
    "with-five-hour",
  );
});

test("does not treat a missing usage snapshot as untouched usage", () => {
  const unknownUsage: Account = {
    id: "unknown-usage",
    accessToken: "token-unknown",
    enabled: true,
  };
  const untouchedOnBothWindows = account("known-untouched", 0, 0);

  assert.equal(
    chooseAccount([unknownUsage, untouchedOnBothWindows])?.id,
    "known-untouched",
  );
});

test("balances equal weekly usage between accounts with different quota windows", () => {
  const withFiveHourQuota = account("with-five-hour-balanced", 0, 0);
  const withoutFiveHourQuota = account("without-five-hour-balanced", undefined, 0);

  const selected = [
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
  ];

  assert.deepEqual(selected, [
    "with-five-hour-balanced",
    "without-five-hour-balanced",
    "with-five-hour-balanced",
    "without-five-hour-balanced",
  ]);
});

test("stops using a five-hour account near its limit when a weekly-only account exists", () => {
  const withFiveHourQuota = account("with-five-hour-near-limit", 90, 0);
  const withoutFiveHourQuota = account("without-five-hour-near-limit", undefined, 0);

  assert.equal(
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    "without-five-hour-near-limit",
  );
});

test("keeps a five-hour account in rotation below the near-limit threshold", () => {
  const withFiveHourQuota = account("with-five-hour-below-limit", 89, 0);
  const withoutFiveHourQuota = account("without-five-hour-below-limit", undefined, 0);

  const first = chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id;
  const second = chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id;

  assert.notEqual(first, second);
});
