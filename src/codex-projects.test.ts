import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexProjectRegistry,
  extractCodexSessionId,
  normalizeCodexSessionRegistration,
  sanitizeGitRemote,
} from "./codex-projects.js";
import { TRACE_HEADERS_FORWARD_HEADER } from "./trace-headers.js";

test("sanitizes git remotes without persisting credentials", () => {
  assert.equal(
    sanitizeGitRemote("https://token:secret@github.com/acme/project.git"),
    "github.com/acme/project",
  );
  assert.equal(
    sanitizeGitRemote("git@github.com:acme/project.git"),
    "github.com/acme/project",
  );
});

test("uses the canonical remote for a stable project id across worktrees", () => {
  const first = normalizeCodexSessionRegistration({
    sessionId: "thread-one",
    cwd: "/worktrees/one",
    projectRoot: "/worktrees/one",
    remote: "git@github.com:acme/project.git",
    host: "host-a",
  });
  const second = normalizeCodexSessionRegistration({
    sessionId: "thread-two",
    cwd: "/worktrees/two",
    projectRoot: "/worktrees/two",
    remote: "https://github.com/acme/project.git",
    host: "host-b",
  });
  assert.equal(first.project.id, second.project.id);
});

test("extracts the Codex session id from direct and forwarded headers", () => {
  assert.equal(extractCodexSessionId({ "thread-id": "thread-direct" }), "thread-direct");
  assert.equal(
    extractCodexSessionId({
      [TRACE_HEADERS_FORWARD_HEADER]: JSON.stringify({
        "thread-id": "thread-forwarded",
      }),
    }),
    "thread-forwarded",
  );
  assert.equal(
    extractCodexSessionId({
      "x-codex-turn-metadata": JSON.stringify({ session_id: "thread-metadata" }),
    }),
    "thread-metadata",
  );
});

test("persists registrations and resolves project attribution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-projects-"));
  const filePath = path.join(directory, "projects.json");
  const registry = new CodexProjectRegistry(filePath);
  await registry.init();
  const registration = await registry.register({
    sessionId: "thread-123",
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
    projectName: "project",
    remote: "git@github.com:acme/project.git",
    branch: "main",
    host: "builder",
    source: "startup",
  });

  assert.deepEqual(registry.resolve("thread-123"), {
    projectId: registration.project.id,
    projectName: "project",
    projectRemote: "github.com/acme/project",
    projectRoot: "/workspace/project",
    projectHost: "builder",
  });

  const reloaded = new CodexProjectRegistry(filePath);
  await reloaded.init();
  assert.equal(reloaded.resolve("thread-123")?.projectId, registration.project.id);
  assert.equal(reloaded.listProjects()[0]?.sessionCount, 1);
});
