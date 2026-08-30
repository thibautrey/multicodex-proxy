import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_PROJECT_ROOT_FORWARD_HEADER,
  CodexProjectRegistry,
  extractCodexProjectRoot,
  extractCodexSessionId,
  extractLiteLLMProjectAttribution,
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

test("extracts the deterministic Codex project root header", () => {
  assert.equal(
    extractCodexProjectRoot({
      [CODEX_PROJECT_ROOT_FORWARD_HEADER]: "/workspace/project/",
    }),
    "/workspace/project",
  );
  assert.equal(
    extractCodexProjectRoot({
      [TRACE_HEADERS_FORWARD_HEADER]: JSON.stringify({
        [CODEX_PROJECT_ROOT_FORWARD_HEADER]: "/workspace/forwarded/",
      }),
    }),
    "/workspace/forwarded",
  );
  assert.equal(
    extractCodexProjectRoot({ [CODEX_PROJECT_ROOT_FORWARD_HEADER]: "  " }),
    undefined,
  );
});

test("derives stable project attribution from the LiteLLM key alias", () => {
  const direct = extractLiteLLMProjectAttribution({
    "X-LiteLLM-Key-Alias": "project-alpha",
  });
  const forwarded = extractLiteLLMProjectAttribution({
    [TRACE_HEADERS_FORWARD_HEADER]: JSON.stringify({
      "x-litellm-key-alias": "project-alpha",
    }),
  });

  assert.deepEqual(direct, forwarded);
  assert.equal(direct?.projectName, "project-alpha");
  assert.match(direct?.projectId ?? "", /^prj_[a-f0-9]{24}$/);
  assert.equal(
    extractLiteLLMProjectAttribution({ "x-litellm-key-alias": "  " }),
    undefined,
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

test("keeps exact session mapping ahead of project-root fallback", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-projects-"));
  const registry = new CodexProjectRegistry(path.join(directory, "projects.json"));
  await registry.init();
  const registration = await registry.register({
    sessionId: "known-session",
    cwd: "/workspace/known",
    projectRoot: "/workspace/known",
    projectName: "known",
    remote: "git@github.com:acme/known.git",
  });

  const resolved = registry.resolve("known-session", "/workspace/other");
  assert.equal(resolved?.projectId, registration.project.id);
  assert.equal(resolved?.projectRoot, "/workspace/known");
});

test("falls back to a uniquely registered project root for unknown sessions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-projects-"));
  const registry = new CodexProjectRegistry(path.join(directory, "projects.json"));
  await registry.init();
  const registration = await registry.register({
    sessionId: "user-session",
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
    projectName: "project",
    remote: "git@github.com:acme/project.git",
  });

  const resolved = registry.resolve("system-session", "/workspace/project/");
  assert.equal(resolved?.projectId, registration.project.id);
  assert.equal(resolved?.projectName, "project");
  assert.equal(resolved?.projectRoot, "/workspace/project");
});

test("leaves unknown sessions unattributed when the root does not match", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-projects-"));
  const registry = new CodexProjectRegistry(path.join(directory, "projects.json"));
  await registry.init();
  await registry.register({
    sessionId: "known-session",
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
    projectName: "project",
    remote: "git@github.com:acme/project.git",
  });

  assert.equal(
    registry.resolve("system-session", "/workspace/missing"),
    undefined,
  );
});

test("does not guess when a project root is shared by multiple projects", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-projects-"));
  const registry = new CodexProjectRegistry(path.join(directory, "projects.json"));
  await registry.init();
  const first = await registry.register({
    sessionId: "first-session",
    cwd: "/workspace/shared",
    projectRoot: "/workspace/shared",
    projectName: "first",
    remote: "git@github.com:acme/first.git",
  });
  await registry.register({
    sessionId: "second-session",
    cwd: "/workspace/shared",
    projectRoot: "/workspace/shared",
    projectName: "second",
    remote: "git@github.com:acme/second.git",
  });

  assert.equal(
    registry.resolve("system-session", "/workspace/shared"),
    undefined,
  );
  assert.equal(
    registry.resolve("first-session", "/workspace/shared")?.projectId,
    first.project.id,
  );
});

test("attributes a system request with no session mapping from its project root", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-projects-"));
  const registry = new CodexProjectRegistry(path.join(directory, "projects.json"));
  await registry.init();
  const registration = await registry.register({
    sessionId: "user-session",
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
    projectName: "project",
    remote: "git@github.com:acme/project.git",
  });

  const systemAttribution = registry.resolve(undefined, "/workspace/project");
  assert.deepEqual(systemAttribution, {
    projectId: registration.project.id,
    projectName: "project",
    projectRemote: "github.com/acme/project",
    projectRoot: "/workspace/project",
    projectHost: undefined,
  });
});
