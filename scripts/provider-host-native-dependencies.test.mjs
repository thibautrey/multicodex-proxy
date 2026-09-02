import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneProductionNativeDependencies } from "./provider-host-native-dependencies.mjs";

const reviewedPrebuilds = [
  "darwin-arm64.node",
  "darwin-x64.node",
  "linux-arm64.node",
  "linux-x64.node",
  "linuxmusl-arm64.node",
  "linuxmusl-x64.node",
  "win32-arm64.node",
  "win32-x64.node",
];

async function withFixture(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "multivibe-native-dependencies-"));
  const prebuilds = path.join(root, "node_modules", "better-sqlite3", "prebuilds");
  try {
    await mkdir(prebuilds, { recursive: true });
    for (const name of reviewedPrebuilds) await writeFile(path.join(prebuilds, name), name);
    await callback(root, prebuilds);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("production packaging retains only the reviewed target native prebuild", async () => {
  await withFixture(async (root, prebuilds) => {
    await pruneProductionNativeDependencies(root, "linux-amd64");
    assert.deepEqual(await readdir(prebuilds), ["linux-x64.node"]);
  });
  await withFixture(async (root, prebuilds) => {
    await pruneProductionNativeDependencies(root, "darwin-arm64");
    assert.deepEqual(await readdir(prebuilds), ["darwin-arm64.node"]);
  });
});

test("production native prebuild pruning rejects changed or unsafe inventories", async () => {
  await withFixture(async (root, prebuilds) => {
    await writeFile(path.join(prebuilds, "unreviewed.node"), "unreviewed");
    await assert.rejects(
      pruneProductionNativeDependencies(root, "linux-amd64"),
      /inventory changed without review/u,
    );
  });
  await withFixture(async (root, prebuilds) => {
    await rm(path.join(prebuilds, "linux-x64.node"));
    await symlink("darwin-arm64.node", path.join(prebuilds, "linux-x64.node"));
    await assert.rejects(
      pruneProductionNativeDependencies(root, "linux-amd64"),
      /non-regular file/u,
    );
  });
  await withFixture(async (root) => {
    const packageDirectory = path.join(root, "node_modules", "better-sqlite3");
    const outside = path.join(root, "outside");
    await rm(packageDirectory, { recursive: true });
    await mkdir(outside);
    await symlink(outside, packageDirectory);
    await assert.rejects(
      pruneProductionNativeDependencies(root, "linux-amd64"),
      /prebuild directory is invalid/u,
    );
  });
  await withFixture(async (root) => {
    await assert.rejects(
      pruneProductionNativeDependencies(root, "linux-arm64"),
      /target is unsupported/u,
    );
  });
});
