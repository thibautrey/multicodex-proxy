#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maximumGitHubReleaseAssetBytes = 1_900 * 1024 * 1024;

async function command(program, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: [options.input === undefined ? "inherit" : "pipe", options.capture ? "pipe" : "inherit", "inherit"],
      shell: false,
    });
    let output = "";
    let exceeded = false;
    if (options.capture) child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > (options.captureLimit ?? 1024 * 1024)) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (exceeded) reject(new Error(`${program} produced excessive output`));
      else if (code === 0) resolve(output.trim());
      else reject(new Error(`${program} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function splitReleaseAsset(file, directory) {
  const source = await open(file, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const parts = [];
  let sourceOffset = 0;
  try {
    while (sourceOffset < (await source.stat()).size) {
      const name = `${path.basename(file)}.part-${String(parts.length + 1).padStart(3, "0")}`;
      const destination = path.join(directory, name);
      const output = await open(destination, "wx", 0o444);
      let partBytes = 0;
      try {
        while (partBytes < maximumGitHubReleaseAssetBytes) {
          const requested = Math.min(buffer.length, maximumGitHubReleaseAssetBytes - partBytes);
          const { bytesRead } = await source.read(buffer, 0, requested, sourceOffset);
          if (bytesRead === 0) break;
          await output.write(buffer, 0, bytesRead, partBytes);
          sourceOffset += bytesRead;
          partBytes += bytesRead;
        }
      } finally {
        await output.close();
      }
      if (partBytes === 0) throw new Error("release asset splitting produced an empty part");
      parts.push(name);
    }
  } finally {
    await source.close();
  }
  if (parts.length < 2) throw new Error("release asset splitting was requested unnecessarily");
  await rm(file);
  return parts;
}

async function main() {
  const args = process.argv.slice(2);
  const keyIndex = args.indexOf("--gpg-key");
  if (keyIndex < 0 || keyIndex !== args.lastIndexOf("--gpg-key") || !args[keyIndex + 1] ||
    !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/u.test(args[keyIndex + 1])) {
    throw new Error("usage: sign-provider-host-release.mjs --gpg-key <fingerprint> <release-directory>");
  }
  const key = args[keyIndex + 1].toUpperCase();
  args.splice(keyIndex, 2);
  if (args.length !== 1) throw new Error("exactly one release directory is required");
  const directory = path.resolve(args[0]);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("release directory is invalid");
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const entries = directoryEntries
    .filter((entry) => entry.isFile() && /^multivibe-host_[0-9A-Za-z._-]+\.(?:zip|tar\.gz)$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== 2 || !entries.some((name) => name.includes("darwin_arm64")) ||
    !entries.some((name) => name.includes("linux_amd64"))) {
    throw new Error("release directory must contain exactly one macOS and one Linux provider-host archive");
  }
  const reports = [];
  for (const name of entries) {
    const output = await command(process.execPath, [path.join(repositoryRoot, "scripts", "verify-provider-host.mjs"), path.join(directory, name)], {
      capture: true,
      captureLimit: 64 * 1024,
    });
    const report = JSON.parse(output);
    if (report.verified !== true || report.releaseReady !== true || report.sourceTreeDirty !== false || report.runtimeChecked !== false) {
      throw new Error(`release archive is not eligible for signing: ${name}`);
    }
    const extension = report.platform === "darwin" ? "zip" : "tar.gz";
    const expected = `multivibe-host_${report.version}_${report.platform}_${report.architecture}.${extension}`;
    if (name !== expected) throw new Error(`release archive filename is inconsistent: ${name}`);
    reports.push(report);
  }
  if (new Set(reports.map((report) => report.version)).size !== 1 ||
    new Set(reports.map((report) => report.sourceCommit)).size !== 1) {
    throw new Error("macOS and Linux archives must come from the same version and source commit");
  }
  const releaseArchives = [];
  for (const name of entries) {
    const file = path.join(directory, name);
    const info = await stat(file);
    if (info.size <= maximumGitHubReleaseAssetBytes) {
      releaseArchives.push(name);
      continue;
    }
    if (!name.endsWith("_linux_amd64.tar.gz")) throw new Error(`release asset exceeds GitHub's size limit: ${name}`);
    releaseArchives.push(...await splitReleaseAsset(file, directory));
  }
  const multipartGuide = path.join(directory, "LINUX-MULTIPART.txt");
  if (releaseArchives.some((name) => name.includes("_linux_amd64.tar.gz.part-"))) {
    const linuxBase = entries.find((name) => name.endsWith("_linux_amd64.tar.gz"));
    await writeFile(multipartGuide,
      `The Linux archive exceeds GitHub's per-file limit. Reconstruct it before verification and installation:\n\ncat ${linuxBase}.part-* > ${linuxBase}\nshasum -a 256 -c SHA256SUMS\n\nDo not extract or execute it unless the signed checksum succeeds.\n`,
      { flag: "wx", mode: 0o444 });
    releaseArchives.push(path.basename(multipartGuide));
  }
  const sboms = reports.map((report) =>
    `multivibe-host_${report.version}_${report.platform}_${report.architecture}.cdx.json`).sort();
  const regularFiles = new Set(directoryEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const name of sboms) {
    if (!regularFiles.has(name)) throw new Error(`release directory is missing its CycloneDX SBOM: ${name}`);
    const file = path.join(directory, name);
    const info = await stat(file);
    if (!info.isFile() || info.size < 1 || info.size > 32 * 1024 * 1024) throw new Error(`invalid release SBOM: ${name}`);
    const document = JSON.parse(await readFile(file, "utf8"));
    if (document.bomFormat !== "CycloneDX" || typeof document.specVersion !== "string" ||
      !/^1\.[4-9]$/u.test(document.specVersion) || document.version !== 1 || !Array.isArray(document.components)) {
      throw new Error(`release SBOM is not a supported CycloneDX document: ${name}`);
    }
  }
  const fingerprints = (await command("gpg", ["--batch", "--with-colons", "--fingerprint", key], {
    capture: true,
  })).split("\n").filter((line) => line.startsWith("fpr:")).map((line) => line.split(":")[9]?.toUpperCase());
  if (!fingerprints.includes(key)) throw new Error("the requested GPG fingerprint is unavailable");

  const sums = path.join(directory, "SHA256SUMS");
  const signature = `${sums}.asc`;
  const publicKey = path.join(directory, "multivibe-release-key.asc");
  const sigstoreBundle = `${sums}.sigstore.json`;
  for (const destination of [sums, signature, publicKey, ...(process.env.GITHUB_ACTIONS === "true" ? [sigstoreBundle] : [])]) {
    try {
      await lstat(destination);
      throw new Error(`release signing output already exists: ${path.basename(destination)}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const checksumRecords = [];
  const signedArtifacts = [...releaseArchives, ...sboms].sort();
  for (const name of signedArtifacts) {
    const file = path.join(directory, name);
    const info = await stat(file);
    if (!info.isFile() || info.size < 1 || info.size > 6 * 1024 * 1024 * 1024) throw new Error(`invalid release artifact: ${name}`);
    const digest = await sha256(file);
    if (entries.includes(name)) {
      const report = reports.find((candidate) => candidate.archive === file);
      if (!report || report.archiveSha256 !== digest) throw new Error(`release archive changed during verification: ${name}`);
    }
    checksumRecords.push({ name, digest });
  }
  for (const report of reports) {
    const originalName = path.basename(report.archive);
    if (!releaseArchives.includes(originalName)) checksumRecords.push({ name: originalName, digest: report.archiveSha256 });
  }
  const lines = checksumRecords.sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, digest }) => `${digest}  ${name}`);
  await writeFile(sums, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o444 });
  const passphrase = process.env.MULTIVIBE_GPG_PASSPHRASE;
  const signingArguments = ["--batch"];
  if (passphrase !== undefined) signingArguments.push("--pinentry-mode", "loopback", "--passphrase-fd", "0");
  signingArguments.push("--armor", "--local-user", key, "--detach-sign", "--output", signature, sums);
  await command("gpg", signingArguments, passphrase === undefined ? {} : { input: `${passphrase}\n` });
  await command("gpg", ["--verify", signature, sums]);
  const armoredKey = await command("gpg", ["--batch", "--armor", "--export", key], { capture: true });
  if (!armoredKey.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") ||
    !armoredKey.endsWith("-----END PGP PUBLIC KEY BLOCK-----")) {
    throw new Error("GPG public-key export is invalid");
  }
  await writeFile(publicKey, `${armoredKey}\n`, { flag: "wx", mode: 0o444 });
  if (process.env.GITHUB_ACTIONS === "true") {
    const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? "";
    if (!/^thibautrey\/multivibe\/\.github\/workflows\/[A-Za-z0-9._/-]+@refs\/tags\/v[0-9A-Za-z.-]+$/u.test(workflowRef)) {
      throw new Error("Sigstore signing requires a tagged MultiVibe release workflow identity");
    }
    const identity = `https://github.com/${workflowRef}`;
    await command("cosign", ["sign-blob", "--yes", "--bundle", sigstoreBundle, sums]);
    await command("cosign", ["verify-blob", "--bundle", sigstoreBundle,
      "--certificate-identity", identity,
      "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", sums]);
  }
  console.log(JSON.stringify({ signed: signedArtifacts, checksums: sums, gpgSignature: signature }));
}

main().catch((error) => {
  console.error(`provider-host signing failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
