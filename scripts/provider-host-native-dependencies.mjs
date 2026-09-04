import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

const expectedPrebuildByTarget = Object.freeze({
  "darwin-arm64": "darwin-arm64.node",
  "darwin-amd64": "darwin-x64.node",
  "linux-amd64": "linux-x64.node",
  "windows-amd64": "win32-x64.node",
});

const reviewedBetterSQLitePrebuilds = new Set([
  "darwin-arm64.node",
  "darwin-x64.node",
  "linux-arm64.node",
  "linux-x64.node",
  "linuxmusl-arm64.node",
  "linuxmusl-x64.node",
  "win32-arm64.node",
  "win32-x64.node",
]);

export async function pruneProductionNativeDependencies(applicationRoot, targetKey) {
  const expected = expectedPrebuildByTarget[targetKey];
  if (!path.isAbsolute(applicationRoot) || !expected) {
    throw new Error("production native dependency target is unsupported");
  }
  const ancestors = [
    path.join(applicationRoot, "node_modules"),
    path.join(applicationRoot, "node_modules", "better-sqlite3"),
    path.join(applicationRoot, "node_modules", "better-sqlite3", "prebuilds"),
  ];
  for (const directory of ancestors) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("better-sqlite3 prebuild directory is invalid");
    }
  }
  const directory = ancestors.at(-1);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== reviewedBetterSQLitePrebuilds.size ||
    entries.some((entry) => !reviewedBetterSQLitePrebuilds.has(entry.name))) {
    throw new Error("better-sqlite3 prebuild inventory changed without review");
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    const info = await lstat(file);
    if (!entry.isFile() || !info.isFile() || info.isSymbolicLink()) {
      throw new Error("better-sqlite3 prebuild inventory contains a non-regular file");
    }
  }
  if (!entries.some((entry) => entry.name === expected)) {
    throw new Error("better-sqlite3 target prebuild is unavailable");
  }
  for (const entry of entries) {
    if (entry.name !== expected) await rm(path.join(directory, entry.name));
  }
  const remaining = await readdir(directory);
  if (remaining.length !== 1 || remaining[0] !== expected) {
    throw new Error("better-sqlite3 prebuild pruning failed closed");
  }
}
