import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicGitHubUrl } from "./module-manager.js";

test("normalizes public GitHub HTTPS repository URLs", () => {
  assert.equal(
    normalizePublicGitHubUrl("https://github.com/example/module"),
    "https://github.com/example/module.git",
  );
  assert.equal(
    normalizePublicGitHubUrl("https://github.com/example/module.git"),
    "https://github.com/example/module.git",
  );
});

test("rejects SSH, credentials, non-GitHub hosts, and extra paths", () => {
  for (const value of [
    "git@github.com:example/module.git",
    "https://token@github.com/example/module",
    "https://gitlab.com/example/module",
    "https://github.com/example/module/tree/main",
    "file:///tmp/module",
  ]) {
    assert.throws(() => normalizePublicGitHubUrl(value));
  }
});
