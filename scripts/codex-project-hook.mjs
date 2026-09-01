#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const debug = process.env.MULTIVIBE_PROJECT_DEBUG === "1";

function report(error) {
  if (debug) process.stderr.write(`[multivibe-project] ${error instanceof Error ? error.message : String(error)}\n`);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("hook payload is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 500,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function sanitizeRemote(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const scpStyle = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpStyle && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const repositoryPath = scpStyle[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return repositoryPath ? `${scpStyle[1].toLowerCase()}/${repositoryPath}` : undefined;
  }
  try {
    const parsed = new URL(raw);
    const repositoryPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return parsed.hostname && repositoryPath
      ? `${parsed.hostname.toLowerCase()}/${repositoryPath}`
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadConfig() {
  const configPath =
    process.env.MULTIVIBE_PROJECT_CONFIG ||
    path.join(codexHome(), "multivibe-project.json");
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

async function postRegistration(config, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(
      `${String(config.url).replace(/\/+$/, "")}/admin/codex-sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-project-token": String(config.token),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`registration returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const [input, config] = await Promise.all([readStdin(), loadConfig()]);
  const sessionId = String(input.session_id || "").trim();
  const cwd = String(input.cwd || process.cwd()).trim();
  if (!sessionId || !cwd || !config.url || !config.token) return;

  const projectRoot = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const remote = sanitizeRemote(
    git(projectRoot, ["remote", "get-url", "origin"]) ||
      git(projectRoot, ["remote", "get-url", "--all", "origin"]),
  );
  const projectName = remote ? path.posix.basename(remote) : path.basename(projectRoot);

  await postRegistration(config, {
    sessionId,
    cwd,
    projectName,
    projectRoot,
    remote,
    branch: git(projectRoot, ["branch", "--show-current"]) || undefined,
    host: os.hostname(),
    source: input.source,
  });
}

main().catch(report);
