import assert from "node:assert/strict";
import test from "node:test";
import {
  createAliasScenarioDraft,
  isGuidedScenarioComplete,
  withScenarioModels,
} from "../web/src/alias-policy-presets.js";

test("redirect preset maps one requested model name to one destination", () => {
  const draft = createAliasScenarioDraft("redirect");
  const alias = withScenarioModels({ ...draft, id: "gpt-5.4" }, "redirect", "gpt-5.6-luna", "");

  assert.equal(alias.rules[0].id, "redirect");
  assert.equal(alias.rules[0].onNoCapacity, "reject");
  assert.deepEqual(alias.rules[0].candidates, [{ model: "gpt-5.6-luna", quality: 50 }]);
  assert.equal(isGuidedScenarioComplete("redirect", alias.id, "gpt-5.6-luna", ""), true);
});

test("fallback preset preserves primary then fallback order", () => {
  const draft = createAliasScenarioDraft("fallback");
  const alias = withScenarioModels(draft, "fallback", "gpt-5.6-sol", "gpt-5.6-luna");

  assert.equal(alias.rules[0].onNoCapacity, "queue");
  assert.deepEqual(
    alias.rules[0].candidates.map((candidate) => candidate.model),
    ["gpt-5.6-sol", "gpt-5.6-luna"],
  );
  assert.equal(isGuidedScenarioComplete("fallback", "reliable-code", "same", "same"), false);
});

test("local-cloud preset restricts each model to its intended location", () => {
  const draft = createAliasScenarioDraft("local-cloud");
  const alias = withScenarioModels(draft, "local-cloud", "local-model", "gpt-5.6-terra");

  assert.deepEqual(alias.rules[0].constraints?.allowedLocations, ["local", "cloud"]);
  assert.deepEqual(alias.rules[0].candidates, [
    { model: "local-model", quality: 50, location: "local" },
    { model: "gpt-5.6-terra", quality: 50, location: "cloud" },
  ]);
  assert.equal(isGuidedScenarioComplete("local-cloud", "smart-code", "local-model", "gpt-5.6-terra"), true);
});
