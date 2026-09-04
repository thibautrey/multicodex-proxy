import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";
import test from "node:test";

import { extractPreflightedTarArchive, preflightTarArchive } from "./provider-host-tar-preflight.mjs";
import { validateProviderModelCatalogAssessments } from "./verify-provider-host.mjs";

const verifier = fileURLToPath(new URL("./verify-provider-host.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const extractedCeiling = 6 * 1024 * 1024 * 1024;

async function inTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "multivibe-host-negative-fixture-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runVerifier(archive) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, archive], {
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

function crc32(value) {
  let result = 0xffffffff;
  for (const byte of value) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      result = (result >>> 1) ^ ((result & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (~result) >>> 0;
}

test("verifier child progress cannot contaminate its JSON stdout", async () => {
  const moduleUrl = pathToFileURL(verifier).href;
  const noisyChild = "process.stdout.write('Processing child output\\n')";
  const probe = [
    `import { runVerificationCommand } from ${JSON.stringify(moduleUrl)};`,
    `await runVerificationCommand(process.execPath, ["--eval", ${JSON.stringify(noisyChild)}]);`,
    `console.log(JSON.stringify({ verified: true }));`,
  ].join("\n");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", probe], {
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
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"verified":true}\n');
  assert.equal(result.stderr, "Processing child output\n");
});

function zipArchive(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "ascii");
    const source = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(source) : source);
    const compressedSize = entry.compressedSize ?? payload.length;
    const uncompressedSize = entry.uncompressedSize ?? source.length;
    const checksum = entry.crc32 ?? crc32(source);
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    const localRecord = Buffer.concat([local, name, payload]);
    locals.push(localRecord);
    centrals.push(Buffer.concat([central, name]));
    localOffset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function writeTarText(header, offset, length, value) {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.length > length) throw new Error("test tar field is too long");
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarText(header, offset, length, `${encoded}\0`);
}

function writeTarBase256(header, offset, length, value) {
  let remaining = BigInt(value);
  for (let index = offset + length - 1; index >= offset; index -= 1) {
    header[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("test tar base-256 value is too large");
  header[offset] |= 0x80;
}

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  let headerName = entry.name;
  let prefix = "";
  if (Buffer.byteLength(headerName, "ascii") > 100) {
    const split = headerName.lastIndexOf("/");
    if (split < 1 || Buffer.byteLength(headerName.slice(0, split), "ascii") > 155 ||
      Buffer.byteLength(headerName.slice(split + 1), "ascii") > 100) {
      throw new Error("test tar path cannot be represented as ustar");
    }
    prefix = headerName.slice(0, split);
    headerName = headerName.slice(split + 1);
  }
  writeTarText(header, 0, 100, headerName);
  writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  const size = entry.size ?? entry.data?.length ?? 0;
  if (entry.base256Size) writeTarBase256(header, 124, 12, size);
  else writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? "0").charCodeAt(0);
  if (entry.linkName) writeTarText(header, 157, 100, entry.linkName);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  if (prefix) writeTarText(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tarRaw(entries) {
  const records = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    records.push(tarHeader(entry), data);
    records.push(Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  records.push(Buffer.alloc(1024));
  return Buffer.concat(records);
}

function tarGzip(entries) {
  return gzipSync(tarRaw(entries));
}

function paxRecord(key, value) {
  let length = Buffer.byteLength(`${key}=${value}\n`) + 2;
  while (true) {
    const record = `${length} ${key}=${value}\n`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record, "utf8");
    length = actual;
  }
}

async function zstdCompress(content) {
  return await new Promise((resolve, reject) => {
    const child = spawn("zstd", ["--quiet", "--compress", "--stdout"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`zstd fixture compression failed with ${signal ?? `exit ${code}`}: ${stderr}`));
    });
    child.stdin.end(content);
  });
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function completeLinuxBundleTar(mutateFiles = () => {}) {
  const root = "multivibe-host_0.0.1_linux_amd64";
  const dependencyData = readFileSync(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"));
  const dependencyMetadata = JSON.parse(dependencyData);
  const catalogData = readFileSync(path.join(repositoryRoot, "packaging", "provider-model-catalog.json"));
  const catalog = JSON.parse(catalogData);
  const assessmentRelative = catalog.models[0].license.assessment_path;
  const assessment = readFileSync(path.join(repositoryRoot, "docs", assessmentRelative));
  const packaged = (...parts) => readFileSync(path.join(repositoryRoot, "packaging", ...parts));
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  elf.writeUInt16LE(0x3e, 18);
  const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const files = new Map([
    ["LICENSE", { data: Buffer.from("Apache License 2.0\n"), mode: 0o644 }],
    ["NOTICE", { data: Buffer.from("MultiVibe Copyright 2026 Pleiades Solutions\n"), mode: 0o644 }],
    ["README.md", { data: Buffer.from("# MultiVibe Host\n"), mode: 0o644 }],
    ["install.sh", { data: Buffer.from("#!/bin/sh\nexit 0\n"), mode: 0o755 }],
    ["uninstall.sh", { data: Buffer.from("#!/bin/sh\nexit 0\n"), mode: 0o755 }],
    ["THIRD_PARTY/node-LICENSE", { data: Buffer.from("Node.js license\n"), mode: 0o644 }],
    ["THIRD_PARTY/ollama-LICENSE", { data: Buffer.from("Ollama MIT license\n"), mode: 0o644 }],
    ["THIRD_PARTY/provider-host-dependencies.json", { data: dependencyData, mode: 0o644 }],
    [`THIRD_PARTY/${assessmentRelative}`, { data: assessment, mode: 0o644 }],
    ["app/dist/anthropic/compat.test.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/dist/anthropic-compat.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/dist/instrument.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/dist/server.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/modules/security/multivibe.module.json", { data: Buffer.from("{}\n"), mode: 0o644 }],
    ["app/modules/security/dist/index.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["bin/multivibe-host", { data: elf, mode: 0o755 }],
    ["bin/multivibe-host-menu", { data: elf, mode: 0o755 }],
    ["bin/multivibe-provider-agent", { data: elf, mode: 0o755 }],
    ["bin/multivibe-runtime-benchmark", { data: elf, mode: 0o755 }],
    ["bin/node", { data: elf, mode: 0o755 }],
    ["resources/provider/provider-host-dependencies.json", { data: dependencyData, mode: 0o644 }],
    ["resources/provider/multivibe-host.png", {
      data: readFileSync(path.join(repositoryRoot, "web", "public", "assets", "brand", "favicon-32x32.png")),
      mode: 0o644,
    }],
    ["resources/provider/provider-model-catalog.json", { data: catalogData, mode: 0o644 }],
    ["resources/provider/provider-runtime-profiles.json", { data: packaged("provider-runtime-profiles.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-profiles.schema.json", { data: packaged("schemas", "provider-runtime-profiles.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-profile-overrides.schema.json", { data: packaged("schemas", "provider-runtime-profile-overrides.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-benchmark-spec.schema.json", { data: packaged("schemas", "provider-runtime-benchmark-spec.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-benchmark-result.schema.json", { data: packaged("schemas", "provider-runtime-benchmark-result.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-benchmark-store.schema.json", { data: packaged("schemas", "provider-runtime-benchmark-store.schema.json"), mode: 0o644 }],
    ["resources/provider/examples/runtime-profile-overrides.json", { data: packaged("examples", "runtime-profile-overrides.json"), mode: 0o644 }],
    ["resources/provider/examples/runtime-benchmark-spec.json", { data: packaged("examples", "runtime-benchmark-spec.json"), mode: 0o644 }],
    ["runtime/ollama/.multivibe-bundle.json", { data: json({
      schema_version: "managed-ollama-bundle-v1",
      version: "0.33.2",
      platform: "linux-amd64",
      archive_sha256: dependencyMetadata.ollama.artifacts["linux-amd64"].sha256,
    }), mode: 0o644 }],
    ["runtime/ollama/bin/ollama", { data: elf, mode: 0o755 }],
    ["verify-provider-host.mjs", { data: Buffer.from("// verifier fixture\n"), mode: 0o644 }],
  ]);
  mutateFiles(files);
  const manifestFiles = [...files].map(([filePath, file]) => ({
    path: filePath,
    size: file.data.length,
    mode: file.mode,
    sha256: sha256Buffer(file.data),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = json({
    schemaVersion: 1,
    product: "multivibe-host",
    version: "0.0.1",
    sourceCommit: "6".repeat(40),
    platform: "linux",
    architecture: "amd64",
    sourceTreeDirty: false,
    releaseReady: true,
    macOSSignature: null,
    node: dependencyMetadata.node,
    managedRuntime: dependencyMetadata.ollama,
    files: manifestFiles,
  });
  const directories = new Set();
  for (const filePath of files.keys()) {
    let directory = path.posix.dirname(filePath);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const entries = [{ name: `${root}/`, type: "5", mode: 0o755 }];
  for (const directory of [...directories].sort((left, right) =>
    left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    entries.push({ name: `${root}/${directory}/`, type: "5", mode: 0o755 });
  }
  for (const [filePath, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    entries.push({ name: `${root}/${filePath}`, data: file.data, mode: file.mode });
  }
  entries.push({ name: `${root}/manifest.json`, data: manifest, mode: 0o644 });
  return tarGzip(entries);
}

function completeWindowsBundleZip(mutateFiles = () => {}) {
  const root = "multivibe-host_0.0.1_windows_amd64";
  const dependencyData = readFileSync(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"));
  const dependencyMetadata = JSON.parse(dependencyData);
  const catalogData = readFileSync(path.join(repositoryRoot, "packaging", "provider-model-catalog.json"));
  const catalog = JSON.parse(catalogData);
  const assessmentRelative = catalog.models[0].license.assessment_path;
  const assessment = readFileSync(path.join(repositoryRoot, "docs", assessmentRelative));
  const packaged = (...parts) => readFileSync(path.join(repositoryRoot, "packaging", ...parts));
  const pe = Buffer.alloc(128);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\0\0", 64, "ascii");
  pe.writeUInt16LE(0x8664, 68);
  pe.writeUInt16LE(0x20b, 88);
  const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const files = new Map([
    ["LICENSE", { data: Buffer.from("Apache License 2.0\n"), mode: 0o644 }],
    ["NOTICE", { data: Buffer.from("MultiVibe Copyright 2026 Pleiades Solutions\n"), mode: 0o644 }],
    ["README.md", { data: Buffer.from("# MultiVibe Host\n"), mode: 0o644 }],
    ["install.ps1", { data: Buffer.from("Write-Output ready\n"), mode: 0o644 }],
    ["uninstall.ps1", { data: Buffer.from("Write-Output ready\n"), mode: 0o644 }],
    ["THIRD_PARTY/node-LICENSE", { data: Buffer.from("Node.js license\n"), mode: 0o644 }],
    ["THIRD_PARTY/ollama-LICENSE", { data: Buffer.from("Ollama MIT license\n"), mode: 0o644 }],
    ["THIRD_PARTY/provider-host-dependencies.json", { data: dependencyData, mode: 0o644 }],
    [`THIRD_PARTY/${assessmentRelative}`, { data: assessment, mode: 0o644 }],
    ["app/package.json", { data: Buffer.from("{}\n"), mode: 0o644 }],
    ["app/package-lock.json", { data: Buffer.from("{}\n"), mode: 0o644 }],
    ["app/dist/anthropic/compat.test.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/dist/anthropic-compat.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/dist/instrument.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/dist/server.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["app/modules/security/multivibe.module.json", { data: Buffer.from("{}\n"), mode: 0o644 }],
    ["app/modules/security/dist/index.js", { data: Buffer.from("export {};\n"), mode: 0o644 }],
    ["bin/multivibe-host.exe", { data: pe, mode: 0o644 }],
    ["bin/multivibe-host-menu.exe", { data: pe, mode: 0o644 }],
    ["bin/multivibe-host-updater.exe", { data: pe, mode: 0o644 }],
    ["bin/multivibe-provider-agent.exe", { data: pe, mode: 0o644 }],
    ["bin/multivibe-runtime-benchmark.exe", { data: pe, mode: 0o644 }],
    ["bin/node.exe", { data: pe, mode: 0o644 }],
    ["resources/provider/provider-host-dependencies.json", { data: dependencyData, mode: 0o644 }],
    ["resources/provider/multivibe-host.ico", {
      data: readFileSync(path.join(repositoryRoot, "web", "public", "assets", "brand", "favicon.ico")),
      mode: 0o644,
    }],
    ["resources/provider/provider-model-catalog.json", { data: catalogData, mode: 0o644 }],
    ["resources/provider/provider-runtime-profiles.json", { data: packaged("provider-runtime-profiles.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-profiles.schema.json", { data: packaged("schemas", "provider-runtime-profiles.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-profile-overrides.schema.json", { data: packaged("schemas", "provider-runtime-profile-overrides.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-benchmark-spec.schema.json", { data: packaged("schemas", "provider-runtime-benchmark-spec.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-benchmark-result.schema.json", { data: packaged("schemas", "provider-runtime-benchmark-result.schema.json"), mode: 0o644 }],
    ["resources/provider/schemas/provider-runtime-benchmark-store.schema.json", { data: packaged("schemas", "provider-runtime-benchmark-store.schema.json"), mode: 0o644 }],
    ["resources/provider/examples/runtime-profile-overrides.json", { data: packaged("examples", "runtime-profile-overrides.json"), mode: 0o644 }],
    ["resources/provider/examples/runtime-benchmark-spec.json", { data: packaged("examples", "runtime-benchmark-spec.json"), mode: 0o644 }],
    ["runtime/ollama/.multivibe-bundle.json", { data: json({
      schema_version: "managed-ollama-bundle-v1",
      version: "0.33.2",
      platform: "windows-amd64",
      archive_sha256: dependencyMetadata.ollama.artifacts["windows-amd64"].sha256,
    }), mode: 0o644 }],
    ["runtime/ollama/lib/ollama/llama-quantize.exe", { data: pe, mode: 0o644 }],
    ["runtime/ollama/lib/ollama/llama-server.exe", { data: pe, mode: 0o644 }],
    ["runtime/ollama/ollama.exe", { data: pe, mode: 0o644 }],
    ["verify-provider-host.mjs", { data: Buffer.from("// verifier fixture\n"), mode: 0o644 }],
  ]);
  mutateFiles(files);
  const manifestFiles = [...files].map(([filePath, file]) => ({
    path: filePath,
    size: file.data.length,
    mode: file.mode,
    sha256: sha256Buffer(file.data),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = json({
    schemaVersion: 1,
    product: "multivibe-host",
    version: "0.0.1",
    sourceCommit: "6".repeat(40),
    platform: "windows",
    architecture: "amd64",
    sourceTreeDirty: false,
    releaseReady: true,
    macOSSignature: null,
    node: dependencyMetadata.node,
    managedRuntime: dependencyMetadata.ollama,
    files: manifestFiles,
  });
  const directories = new Set();
  for (const filePath of files.keys()) {
    let directory = path.posix.dirname(filePath);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const entries = [{ name: `${root}/` }];
  for (const directory of [...directories].sort((left, right) =>
    left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    entries.push({ name: `${root}/${directory}/` });
  }
  for (const [filePath, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    entries.push({ name: `${root}/${filePath}`, data: file.data, mode: file.mode });
  }
  entries.push({ name: `${root}/manifest.json`, data: manifest, mode: 0o644 });
  return zipArchive(entries);
}

async function expectArchiveFailure(extension, content, expected) {
  await inTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, `fixture${extension}`);
    await writeFile(archive, content, { mode: 0o600 });
    const result = await runVerifier(archive);
    assert.notEqual(result.code, 0, `unexpected verification success: ${result.stdout}`);
    assert.equal(result.signal, null);
    assert.match(result.stderr, expected);
  });
}

test("ZIP preflight rejects traversal, links, duplicates and declared zip bombs", async () => {
  const directory = { name: "root/" };
  await expectArchiveFailure(".zip", zipArchive([directory, { name: "root/../escape" }]), /unsafe path/u);
  await expectArchiveFailure(".zip", zipArchive([directory, {
    name: "root/link", mode: 0o120777, data: Buffer.from("target", "ascii"),
  }]), /link or special entry/u);
  await expectArchiveFailure(".zip", zipArchive([directory, { name: "root/a" }, { name: "root/a" }]), /duplicate paths/u);
  await expectArchiveFailure(".zip", zipArchive([directory,
    { name: "root/a", method: 8, compressedSize: 0, uncompressedSize: 0xe0000000 },
    { name: "root/b", method: 8, compressedSize: 0, uncompressedSize: 0xe0000000 },
  ]), /extracted-size ceiling/u);
  await expectArchiveFailure(".zip", zipArchive([directory, {
    name: "root/lying-deflate", method: 8, data: Buffer.alloc(256 * 1024), uncompressedSize: 1,
  }]), /extracted-size ceiling/u);
});

test("ZIP preflight bounds cumulative path metadata", async () => {
  const entries = [{ name: "root/" }];
  for (let index = 0; index < 10000; index += 1) {
    entries.push({ name: `root/${String(index).padStart(4, "0")}-${"a".repeat(430)}` });
  }
  await expectArchiveFailure(".zip", zipArchive(entries), /metadata exceeds the ceiling/u);
});

test("tar preflight rejects traversal, links, special entries, duplicates and declared bombs", async () => {
  await expectArchiveFailure(".tar.gz", tarGzip([{ name: "root/../escape" }]), /unsafe path/u);
  await expectArchiveFailure(".tar.gz", tarGzip([{
    name: "root/link", type: "2", linkName: "target",
  }]), /link or special entry/u);
  await expectArchiveFailure(".tar.gz", tarGzip([{ name: "root/device", type: "3" }]), /link or special entry/u);
  await expectArchiveFailure(".tar.gz", tarGzip([{ name: "root/a" }, { name: "root/a" }]), /duplicate paths/u);
  await expectArchiveFailure(".tar.gz", tarGzip([{
    name: "root/bomb", size: extractedCeiling + 1, base256Size: true,
  }]), /extracted-size ceiling/u);
  await expectArchiveFailure(".tar.gz", tarGzip([{
    name: "PaxHeaders/root", type: "x", size: 8 * 1024 * 1024 + 1,
  }]), /metadata exceeds the ceiling/u);
});

test("dependency tar preflight rejects links, special entries, sparse metadata, collisions and both size ceilings", async () => {
  await inTemporaryDirectory(async (directory) => {
    const writeFixture = async (name, entries) => {
      const archive = path.join(directory, name);
      await writeFile(archive, tarGzip(entries), { mode: 0o600 });
      return archive;
    };
    const linked = await writeFixture("linked.tar.gz", [
      { name: "root/", type: "5", mode: 0o755 },
      { name: "root/lib/", type: "5", mode: 0o755 },
      { name: "root/lib/runtime", data: Buffer.from("runtime", "ascii") },
      { name: "root/runtime", type: "2", linkName: "lib/runtime" },
    ]);
    await assert.rejects(preflightTarArchive(linked, "tar-gzip", 1024), /contains a symlink/u);
    const report = await preflightTarArchive(linked, "tar-gzip", {
      maximumFileBytes: 1024,
      maximumExtractedBytes: 1024,
      linkHandling: "ignore",
    });
    assert.equal(report.entries, 4);
    assert.equal(report.extractedBytes, 7);

    const escaping = await writeFixture("escaping.tar.gz", [
      { name: "root/", type: "5" },
      { name: "root/link", type: "2", linkName: "../../outside" },
    ]);
    await assert.rejects(preflightTarArchive(escaping, "tar-gzip", {
      maximumFileBytes: 1024,
      maximumExtractedBytes: 1024,
      linkHandling: "ignore",
    }), /link escapes|link target is unsafe/u);

    const throughLink = await writeFixture("through-link.tar.gz", [
      { name: "root/", type: "5" },
      { name: "root/target", data: Buffer.from("target", "ascii") },
      { name: "root/link", type: "2", linkName: "target" },
      { name: "root/link/payload", data: Buffer.from("escape", "ascii") },
    ]);
    await assert.rejects(preflightTarArchive(throughLink, "tar-gzip", 1024), /writes through a non-directory/u);

    for (const [name, type] of [["hardlink", "1"], ["character-device", "3"], ["block-device", "4"], ["fifo", "6"], ["sparse", "S"]]) {
      const special = await writeFixture(`${name}.tar.gz`, [{ name: "root/target" }, {
        name: `root/${name}`,
        type,
        linkName: type === "1" ? "root/target" : undefined,
      }]);
      await assert.rejects(preflightTarArchive(special, "tar-gzip", 1024), /hardlink|special|metadata type/u);
    }

    const sparsePax = await writeFixture("sparse-pax.tar.gz", [{
      name: "PaxHeaders/sparse",
      type: "x",
      data: paxRecord("GNU.sparse.realsize", "4096"),
    }, { name: "root/sparse" }]);
    await assert.rejects(preflightTarArchive(sparsePax, "tar-gzip", 1024), /PAX sparse metadata is unsupported/u);

    const unsafeMetadata = await writeFixture("unsafe-metadata.tar.gz", [{
      name: "../PaxHeaders/escape",
      type: "x",
      data: paxRecord("path", "root/file"),
    }, { name: "root/file" }]);
    await assert.rejects(preflightTarArchive(unsafeMetadata, "tar-gzip", 1024), /metadata path is unsafe/u);

    const duplicate = await writeFixture("duplicate.tar.gz", [{ name: "root/a" }, { name: "root/A" }]);
    await assert.rejects(preflightTarArchive(duplicate, "tar-gzip", 1024), /duplicate paths/u);

    const prefixCollision = await writeFixture("prefix-collision.tar.gz", [
      { name: "Root/a" },
      { name: "root/b" },
    ]);
    await assert.rejects(preflightTarArchive(prefixCollision, "tar-gzip", 1024), /case-folded path collision/u);

    const individualBomb = await writeFixture("individual-bomb.tar.gz", [{
      name: "root/bomb", size: 513, base256Size: true,
    }]);
    await assert.rejects(preflightTarArchive(individualBomb, "tar-gzip", {
      maximumFileBytes: 512,
      maximumExtractedBytes: 1024,
    }), /individual-size ceiling/u);

    const aggregateBomb = await writeFixture("aggregate-bomb.tar.gz", [
      { name: "root/a", data: Buffer.alloc(600) },
      { name: "root/b", data: Buffer.alloc(600) },
    ]);
    await assert.rejects(preflightTarArchive(aggregateBomb, "tar-gzip", {
      maximumFileBytes: 700,
      maximumExtractedBytes: 1024,
    }), /extracted-size ceiling/u);
  });
});

test("Node dependency extraction selects only node and LICENSE and writes nothing for a rejected archive", async () => {
  await inTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, "node.tar.gz");
    await writeFile(archive, tarGzip([
      { name: "node-v1/", type: "5", mode: 0o755 },
      { name: "node-v1/bin/", type: "5", mode: 0o755 },
      { name: "node-v1/bin/node", data: Buffer.from("node-binary", "ascii"), mode: 0o755 },
      { name: "node-v1/LICENSE", data: Buffer.from("node-license", "ascii") },
      { name: "node-v1/lib/npm.js", data: Buffer.from("npm", "ascii") },
      { name: "node-v1/bin/npm", type: "2", linkName: "../lib/npm.js" },
    ]), { mode: 0o600 });
    const extraction = path.join(directory, "node-extracted");
    await mkdir(extraction, { mode: 0o700 });
    const report = await extractPreflightedTarArchive(archive, extraction, "tar-gzip", {
      profile: "node-runtime",
      maximumFileBytes: 1024,
      maximumExtractedBytes: 4096,
    });
    assert.deepEqual(report.extractedFiles, ["node-v1/LICENSE", "node-v1/bin/node"]);
    assert.equal((await readFile(path.join(extraction, "node-v1/bin/node"), "utf8")), "node-binary");
    assert.equal((await readFile(path.join(extraction, "node-v1/LICENSE"), "utf8")), "node-license");
    assert.deepEqual(await readdir(path.join(extraction, "node-v1/bin")), ["node"]);

    const rejected = path.join(directory, "node-hardlink.tar.gz");
    await writeFile(rejected, tarGzip([
      { name: "node-v1/bin/node", data: Buffer.from("node", "ascii") },
      { name: "node-v1/LICENSE", data: Buffer.from("license", "ascii") },
      { name: "node-v1/bad", type: "1", linkName: "node-v1/bin/node" },
    ]), { mode: 0o600 });
    const untouched = path.join(directory, "untouched");
    await mkdir(untouched, { mode: 0o700 });
    await assert.rejects(extractPreflightedTarArchive(rejected, untouched, "tar-gzip", {
      profile: "node-runtime",
      maximumFileBytes: 1024,
      maximumExtractedBytes: 4096,
    }), /hardlink/u);
    assert.deepEqual(await readdir(untouched), []);
  });
});

test("Ollama zstd extraction materializes safe aliases as regular files and rejects hostile zstd entries", async () => {
  await inTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, "ollama.tar.zst");
    await writeFile(archive, await zstdCompress(tarRaw([
      { name: "bin/", type: "5", mode: 0o755 },
      { name: "bin/ollama", data: Buffer.from("binary", "ascii"), mode: 0o755 },
      { name: "lib/", type: "5", mode: 0o755 },
      { name: "lib/runtime.1", data: Buffer.from("library", "ascii") },
      { name: "lib/runtime.0", type: "2", linkName: "runtime.1" },
      { name: "lib/runtime", type: "2", linkName: "runtime.0" },
    ])), { mode: 0o600 });
    const extraction = path.join(directory, "ollama-extracted");
    await mkdir(extraction, { mode: 0o700 });
    const report = await extractPreflightedTarArchive(archive, extraction, "tar-zstd", {
      profile: "ollama-runtime",
      maximumFileBytes: 1024,
      maximumExtractedBytes: 4096,
    });
    assert.equal(report.extractedBytes, 13);
    for (const alias of ["lib/runtime.0", "lib/runtime"]) {
      assert.equal((await readFile(path.join(extraction, alias), "utf8")), "library");
      const info = await lstat(path.join(extraction, alias));
      assert.equal(info.isFile(), true);
      assert.equal(info.isSymbolicLink(), false);
    }

    const hostile = path.join(directory, "ollama-hostile.tar.zst");
    await writeFile(hostile, await zstdCompress(tarRaw([{ name: "bin/ollama", data: Buffer.from("ok") }, {
      name: "bin/fifo", type: "6",
    }])), { mode: 0o600 });
    const hostileDestination = path.join(directory, "ollama-hostile");
    await mkdir(hostileDestination, { mode: 0o700 });
    await assert.rejects(extractPreflightedTarArchive(hostile, hostileDestination, "tar-zstd", {
      profile: "ollama-runtime",
      maximumFileBytes: 1024,
      maximumExtractedBytes: 4096,
    }), /special or unsupported/u);
    assert.deepEqual(await readdir(hostileDestination), []);
  });
});

test("embedded catalog assessment digest must match the declared review file", async () => {
  await inTemporaryDirectory(async (root) => {
    const catalogDirectory = path.join(root, "resources", "provider");
    const assessmentDirectory = path.join(root, "THIRD_PARTY", "provider-model-license-assessments");
    await mkdir(catalogDirectory, { recursive: true });
    await mkdir(assessmentDirectory, { recursive: true });
    const assessment = Buffer.from("reviewed license assessment\n", "utf8");
    const assessmentPath = path.join(assessmentDirectory, "test-model.md");
    await writeFile(assessmentPath, assessment, { mode: 0o644 });
    const digest = createHash("sha256").update(assessment).digest("hex");
    const catalog = {
      schema_version: "provider-model-catalog-v1",
      models: [{
        canonical_model_id: "hf:example/test-model",
        ollama_model: "test-model:latest",
        ollama_manifest_path: "registry.ollama.ai/library/test-model/latest",
        content_digest: `sha256:${"a".repeat(64)}`,
        download_bytes_hex: "0x1000",
        gpu_utilization_percent: 50,
        vram_estimates: [{ context_tokens: 2048, estimated_vram_bytes_hex: "0x1000" }],
        license: {
          license_id: "Apache-2.0",
          hosted_inference_allowed: true,
          assessment_path: "provider-model-license-assessments/test-model.md",
          assessment_digest: digest,
        },
      }],
    };
    await writeFile(path.join(catalogDirectory, "provider-model-catalog.json"), `${JSON.stringify(catalog)}\n`, { mode: 0o644 });
    await validateProviderModelCatalogAssessments(root, "linux");
    await writeFile(assessmentPath, "review changed after approval\n", { mode: 0o644 });
    await assert.rejects(validateProviderModelCatalogAssessments(root, "linux"), /assessment digest mismatch/u);
  });
});

test("signed archive rejects empty profiles and placeholder schemas or examples", async () => {
  const invalidResources = {
    "empty-profiles": ["resources/provider/provider-runtime-profiles.json", (original) => {
      const catalog = JSON.parse(original.toString("utf8"));
      catalog.profiles = [];
      return Buffer.from(`${JSON.stringify(catalog)}\n`, "utf8");
    }],
    "placeholder-schema": ["resources/provider/schemas/provider-runtime-benchmark-result.schema.json",
      () => Buffer.from('{"$schema":"https://json-schema.org/draft/2020-12/schema"}\n', "utf8")],
    "placeholder-example": ["resources/provider/examples/runtime-benchmark-spec.json",
      () => Buffer.from('{"schema_version":"provider-runtime-benchmark-spec-v1","enabled":false}\n', "utf8")],
  };
  for (const [name, [resourcePath, mutate]] of Object.entries(invalidResources)) {
    await inTemporaryDirectory(async (directory) => {
      const archive = path.join(directory, `${name}.tar.gz`);
      const payload = completeLinuxBundleTar((files) => {
        const original = files.get(resourcePath);
        files.set(resourcePath, { ...original, data: mutate(original.data) });
      });
      await writeFile(archive, payload, { mode: 0o600 });
      const result = await runVerifier(archive);
      assert.notEqual(result.code, 0, `${name} was accepted: ${result.stdout}`);
      assert.match(result.stderr, /provider runtime/u);
    });
  }
});

test("complete Linux release fixture passes archive and signed-manifest verification", async () => {
  await inTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, "multivibe-host_0.0.1_linux_amd64.tar.gz");
    await writeFile(archive, completeLinuxBundleTar(), { mode: 0o600 });
    const result = await runVerifier(archive);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.verified, true);
    assert.equal(output.releaseReady, true);
    assert.equal(output.platform, "linux");
    assert.equal(output.runtimeChecked, false);
  });
});

test("complete Windows amd64 release fixture passes archive and PE verification", async () => {
  await inTemporaryDirectory(async (directory) => {
    const archive = path.join(directory, "multivibe-host_0.0.1_windows_amd64.zip");
    await writeFile(archive, completeWindowsBundleZip(), { mode: 0o600 });
    const result = await runVerifier(archive);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.verified, true);
    assert.equal(output.releaseReady, true);
    assert.equal(output.platform, "windows");
    assert.equal(output.architecture, "amd64");
    assert.equal(output.runtimeChecked, false);
  });
});
