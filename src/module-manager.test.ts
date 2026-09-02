import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModuleManager, normalizePublicGitHubUrl } from "./module-manager.js";

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

test("clears restart requirements and loads enabled plugins on startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-modules-"));
  const moduleRoot = path.join(root, "checkouts", "com.example.restart");
  await fs.mkdir(path.join(moduleRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(moduleRoot, "multivibe.module.json"), JSON.stringify({
    id: "com.example.restart",
    name: "Restart test",
    version: "1.0.0",
    apiVersion: 1,
    description: "Test plugin",
    entrypoint: "dist/index.js",
    hooks: [],
    repository: "https://github.com/example/restart.git",
  }));
  await fs.writeFile(path.join(moduleRoot, "dist", "index.js"), "export default {};\n");
  await fs.writeFile(path.join(root, "modules-lock.json"), JSON.stringify([{
    id: "com.example.restart",
    origin: "https://github.com/example/restart.git",
    commit: "abc123",
    enabled: true,
    settings: {},
    source: "external",
    restartRequired: true,
  }]));

  try {
    const manager = new ModuleManager(root);
    await manager.initialize();
    const [plugin] = manager.list();
    assert.equal(plugin.restartRequired, undefined);
    assert.equal(plugin.loaded, true);
    assert.equal(plugin.healthy, true);
    const persisted = JSON.parse(await fs.readFile(path.join(root, "modules-lock.json"), "utf8"));
    assert.equal(persisted[0].restartRequired, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
