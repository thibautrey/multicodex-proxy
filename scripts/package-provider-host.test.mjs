import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { archiveBundle } from "./package-provider-host.mjs";

const packager = fileURLToPath(new URL("./package-provider-host.mjs", import.meta.url));

async function runNode(arguments_) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function tarEntries(archive) {
  const contents = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= contents.length) {
    const header = contents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stringField = (start, length) => {
      const field = header.subarray(start, start + length);
      const end = field.indexOf(0);
      return field.subarray(0, end < 0 ? field.length : end).toString("ascii");
    };
    const sizeText = stringField(124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    const name = stringField(0, 100);
    const prefix = stringField(345, 155);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      type: header[156] === 0 ? "0" : String.fromCharCode(header[156]),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("Linux packaging uses ustar paths instead of duplicate GNU long-name metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "multivibe-host-archive-test-"));
  try {
    const baseName = "multivibe-host_0.2.0-runtime-community.1_linux_amd64";
    const root = path.join(directory, baseName);
    const relative = path.join(
      "app",
      "node_modules",
      "@opentelemetry",
      "instrumentation-http",
      "node_modules",
      "@opentelemetry",
      "semantic-conventions",
      "build",
      "esnext",
      "resource",
      "SemanticResourceAttributes.js.map",
    );
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "source map\n");

    const archive = await archiveBundle(
      { root, baseName },
      { output: path.join(directory, "out") },
      { archive: "tar.gz" },
    );
    const entries = tarEntries(await readFile(archive));
    assert.ok(entries.some((entry) => entry.name === `${baseName}/${relative}`));
    assert.ok(entries.every((entry) => !["L", "x", "g"].includes(entry.type)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the packaging CLI remains active when invoked through a symlink", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "multivibe-host-packager-link-test-"));
  try {
    const link = path.join(directory, "package-provider-host.mjs");
    await symlink(packager, link);
    const result = await runNode([link, "--invalid-test-option"]);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /provider-host package failed: unknown argument: --invalid-test-option/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
