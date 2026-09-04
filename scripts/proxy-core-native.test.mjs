import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativePath = path.join(repositoryRoot, "native", "multivibe-proxy-core.node");
assert.ok(fs.existsSync(nativePath), `native addon is missing: ${nativePath}`);

const require = createRequire(import.meta.url);
const native = require(nativePath);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "rust", "proxy-core", "testdata", "payload-inspection-cases.json"),
    "utf8",
  ),
);

test("exports the raw-JSON payload inspection function", () => {
  assert.equal(typeof native.inspectPayloadContextJson, "function");
});

test("matches every shared TypeScript and Rust migration fixture", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(
      native.inspectPayloadContextJson(Buffer.from(JSON.stringify(fixture.payload))),
      fixture.expected,
      fixture.name,
    );
  }
});

test("rejects invalid JSON as an argument error", () => {
  assert.throws(
    () => native.inspectPayloadContextJson(Buffer.from("{")),
    /Invalid JSON payload/u,
  );
});
