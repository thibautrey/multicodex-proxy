import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("source archive is deterministic and bound to the tag", () => {
  const root = mkdtempSync(join(tmpdir(), "multivibe-source-release-"));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tag = "source-v0.0.0-test";
  execFileSync("git", ["tag", tag, sha]);
  try {
    for (const dir of ["a", "b"]) execFileSync(process.execPath, ["scripts/build-source-release.mjs", tag, sha, join(root, dir)]);
    assert.equal(readFileSync(join(root, "a/SHA256SUMS"), "utf8"), readFileSync(join(root, "b/SHA256SUMS"), "utf8"));
    const names = execFileSync("tar", ["-tzf", join(root, "a", `multivibe-${tag}-source.tar.gz`)], { encoding: "utf8" });
    assert.match(names, new RegExp(`multivibe-${tag}/LICENSE`));
    assert.match(names, new RegExp(`multivibe-${tag}/NOTICE`));
    const notice = execFileSync("git", ["show", `${sha}:NOTICE`], { encoding: "utf8" });
    assert.doesNotMatch(notice, /\bTHIRD_PARTY\b/, "NOTICE must not claim a nonexistent inventory");
    const claimedPaths = [...notice.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert.deepEqual(claimedPaths, ["LICENSE"], "every repository path claim must be explicit and reviewed");
    const archived = new Set(names.trim().split("\n"));
    for (const claimedPath of claimedPaths) {
      assert.ok(archived.has(`multivibe-${tag}/${claimedPath}`), `NOTICE path claim is absent: ${claimedPath}`);
    }
  } finally { execFileSync("git", ["tag", "-d", tag]); }
});
