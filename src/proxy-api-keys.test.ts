import assert from "node:assert/strict";
import test from "node:test";
import {
  identifyProxyApplication,
  parseProxyApiKeys,
} from "./proxy-api-keys.js";

test("parses legacy and per-application proxy API keys", () => {
  assert.deepEqual(
    parseProxyApiKeys("legacy", '{"mobile":"mobile-key","web":"web-key"}'),
    [
      { application: "default", key: "legacy" },
      { application: "mobile", key: "mobile-key" },
      { application: "web", key: "web-key" },
    ],
  );
});

test("identifies applications from bearer and x-api-key headers", () => {
  const keys = parseProxyApiKeys("", '{"mobile":"mobile-key"}');
  assert.equal(
    identifyProxyApplication({ authorization: "Bearer mobile-key" }, keys),
    "mobile",
  );
  assert.equal(
    identifyProxyApplication({ "x-api-key": "mobile-key" }, keys),
    "mobile",
  );
  assert.equal(
    identifyProxyApplication({ authorization: "Bearer unknown" }, keys),
    undefined,
  );
});

test("rejects malformed, empty, or duplicate keys", () => {
  assert.throws(() => parseProxyApiKeys("", "not-json"), /JSON object/);
  assert.throws(() => parseProxyApiKeys("", '{"mobile":""}'), /non-empty/);
  assert.throws(
    () => parseProxyApiKeys("legacy", '{"mobile":"legacy"}'),
    /must be unique/,
  );
});
