import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderId } from "../../types.js";
import {
  accountSupportsModelByAvailability,
  createProviderModelAvailability,
  finalizeProviderModelAvailability,
  recordDiscoveredModel,
  type ModelAvailabilityByProvider,
} from "./model-availability.js";

function availabilityFor(
  provider: ProviderId,
  activeAccountIds: string[],
  successfulAccountIds: string[],
  modelAccountIds: Array<[string, string[]]>,
): ModelAvailabilityByProvider {
  const availability = createProviderModelAvailability();
  for (const accountId of activeAccountIds) {
    availability.activeAccountIds.add(accountId);
  }
  for (const accountId of successfulAccountIds) {
    availability.successfulAccountIds.add(accountId);
  }
  for (const [modelKey, accountIds] of modelAccountIds) {
    for (const accountId of accountIds) {
      recordDiscoveredModel(availability, modelKey, accountId);
    }
  }
  finalizeProviderModelAvailability(availability);
  return new Map([[provider, availability]]);
}

test("a complete catalog excludes an account that did not return the model", () => {
  const availability = availabilityFor(
    "openai",
    ["plus-account", "pro-account"],
    ["plus-account", "pro-account"],
    [["gpt-5.6-sol", ["plus-account"]]],
  );

  assert.equal(
    accountSupportsModelByAvailability(
      "plus-account",
      "openai",
      "gpt-5.6-sol",
      availability,
    ),
    true,
  );
  assert.equal(
    accountSupportsModelByAvailability(
      "pro-account",
      "openai",
      "gpt-5.6-sol",
      availability,
    ),
    false,
  );
});

test("a partial catalog keeps an account eligible when discovery failed", () => {
  const availability = availabilityFor(
    "openai",
    ["plus-account", "pro-account"],
    ["plus-account"],
    [["gpt-5.6-sol", ["plus-account"]]],
  );

  assert.equal(
    accountSupportsModelByAvailability(
      "pro-account",
      "openai",
      "gpt-5.6-sol",
      availability,
    ),
    true,
  );
});
