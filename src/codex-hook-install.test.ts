import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexHookInstallCommand,
  normalizeInstallBaseUrl,
} from "./codex-hook-install.js";

test("normalizes an HTTP(S) dashboard URL for hook installation", () => {
  assert.equal(
    normalizeInstallBaseUrl(" https://multivibe.example.test/proxy/?ignored=1#section "),
    "https://multivibe.example.test/proxy",
  );
  assert.throws(() => normalizeInstallBaseUrl("file:///tmp/proxy"), /http or https/);
  assert.throws(() => normalizeInstallBaseUrl("https://user:secret@example.test"), /credentials/);
});

test("builds one pasteable command with a shell-quoted URL and token", () => {
  const command = buildCodexHookInstallCommand(
    "http://192.0.2.149:1455/",
    "token-with-'quote",
  );

  assert.match(command, /^\(multivibe_installer=/);
  assert.match(command, /curl -fsSL 'http:\/\/192\.168\.1\.149:1455\/install-codex-project-hook\.sh'/);
  assert.match(command, /MULTIVIBE_URL='http:\/\/192\.168\.1\.149:1455'/);
  assert.match(command, /MULTIVIBE_PROJECT_TOKEN='token-with-'"'"'quote' sh\)$/);
  assert.equal(command.includes("\n"), false);
});

test("refuses to generate a command when project registration is disabled", () => {
  assert.throws(
    () => buildCodexHookInstallCommand("https://multivibe.example.test", ""),
    /registration is disabled/,
  );
});

