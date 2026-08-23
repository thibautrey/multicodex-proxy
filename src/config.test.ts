import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("rejects invalid numeric configuration instead of disabling limits", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", "import('./src/config.ts')"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "not-a-number" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PORT must be a finite number/);
});
