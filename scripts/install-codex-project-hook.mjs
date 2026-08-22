#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function writeAtomic(filePath, value, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(temporaryPath, value, { encoding: "utf8", mode });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, mode);
}

async function main() {
  const url = argument("--url") || process.env.MULTICODEX_URL;
  const token = process.env.MULTICODEX_PROJECT_TOKEN;
  const targetCodexHome =
    argument("--codex-home") ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");
  if (!url) throw new Error("Pass --url http://multicodex:1455 or set MULTICODEX_URL");
  if (!token) throw new Error("Set MULTICODEX_PROJECT_TOKEN before running the installer");

  const sourceScript = fileURLToPath(new URL("./codex-project-hook.mjs", import.meta.url));
  const hooksDirectory = path.join(targetCodexHome, "hooks");
  const targetScript = path.join(hooksDirectory, "multicodex-project-hook.mjs");
  const projectConfigPath = path.join(targetCodexHome, "multicodex-project.json");
  const hooksPath = path.join(targetCodexHome, "hooks.json");
  await fs.mkdir(hooksDirectory, { recursive: true });
  await fs.copyFile(sourceScript, targetScript);
  await fs.chmod(targetScript, 0o755);
  await writeAtomic(
    projectConfigPath,
    `${JSON.stringify({ url: String(url).replace(/\/+$/, ""), token }, null, 2)}\n`,
    0o600,
  );

  let manifest = { description: "User-level Codex hooks", hooks: {} };
  try {
    manifest = JSON.parse(await fs.readFile(hooksPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${hooksPath} must contain a JSON object`);
  }
  if (!manifest.hooks || typeof manifest.hooks !== "object" || Array.isArray(manifest.hooks)) {
    manifest.hooks = {};
  }
  const sessionStart = Array.isArray(manifest.hooks.SessionStart)
    ? manifest.hooks.SessionStart
    : [];
  const command = `MULTICODEX_PROJECT_CONFIG=${shellQuote(projectConfigPath)} ${shellQuote(process.execPath)} ${shellQuote(targetScript)}`;
  const alreadyInstalled = sessionStart.some((group) =>
    Array.isArray(group?.hooks) &&
    group.hooks.some((handler) => String(handler?.command || "").includes("multicodex-project-hook.mjs")),
  );
  if (!alreadyInstalled) {
    sessionStart.push({
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command,
          timeout: 2,
          statusMessage: "Identifying Codex project",
        },
      ],
    });
  }
  manifest.hooks.SessionStart = sessionStart;
  await writeAtomic(hooksPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  process.stdout.write(
    [
      `Installed MultiCodex project attribution hook in ${hooksPath}`,
      "Approval required: open Codex on this execution host, run /hooks,",
      "review the SessionStart hook, and press t to trust it.",
      "Codex skips new or changed hooks until they are trusted. Start or resume a session afterwards.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
