import assert from "node:assert/strict";
import test from "node:test";
import { applyUnsupportedValueCorrection } from "./index.js";

test("replaces minimal reasoning effort with the closest supported value", () => {
  const payload = {
    model: "gpt-new",
    reasoning: { effort: "minimal", summary: "auto" },
  };
  const error = JSON.stringify({
    error: {
      message:
        "Unsupported value: 'minimal' is not supported with this model. Supported values are: 'low', 'medium', and 'high'.",
      param: "reasoning.effort",
    },
  });

  assert.deepEqual(applyUnsupportedValueCorrection(payload, error), {
    from: "minimal",
    to: "low",
  });
  assert.equal(payload.reasoning.effort, "low");
  assert.equal(payload.reasoning.summary, "auto");
});

test("supports the Chat Completions reasoning_effort field", () => {
  const payload = { reasoning_effort: "xhigh" };
  const error =
    "Unsupported value: 'xhigh'. Supported values are: 'low', 'medium', and 'high'.";

  assert.deepEqual(applyUnsupportedValueCorrection(payload, error), {
    from: "xhigh",
    to: "high",
  });
  assert.equal(payload.reasoning_effort, "high");
});

test("does not alter unrelated payload values", () => {
  const payload = { text: { verbosity: "minimal" } };
  const error =
    "Unsupported value: 'minimal'. Supported values are: 'low', 'medium', and 'high'.";

  assert.equal(applyUnsupportedValueCorrection(payload, error), undefined);
  assert.equal(payload.text.verbosity, "minimal");
});
