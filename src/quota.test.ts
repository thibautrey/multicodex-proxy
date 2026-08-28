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
