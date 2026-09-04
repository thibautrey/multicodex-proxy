#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const schemaVersion = "multivibe-host-update-v1";
const canonicalRepository = "thibautrey/multivibe";
const canonicalImage = "ghcr.io/thibautrey/multivibe-host";
const semanticVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function parseArguments(values) {
  const options = {};
  const allowed = new Set([
    "--version", "--commit", "--channel", "--release-dir", "--container-metadata", "--output",
    "--trusted-key-id", "--trusted-public-key-base64",
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("update feed arguments must be --name value pairs");
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
    if (options[key]) throw new Error(`duplicate argument: ${key}`);
    options[key] = value;
  }
  for (const required of [
    "--version", "--commit", "--channel", "--release-dir", "--container-metadata", "--output",
    "--trusted-key-id", "--trusted-public-key-base64",
  ]) {
    if (!options[required]) throw new Error(`missing argument: ${required}`);
  }
  if (!semanticVersion.test(options["--version"])) throw new Error("version must use canonical semantic versioning");
  if (!commitPattern.test(options["--commit"])) throw new Error("commit must be lowercase 40-hex");
  if (!["stable", "beta"].includes(options["--channel"])) throw new Error("channel must be stable or beta");
  if ((options["--channel"] === "stable") === options["--version"].includes("-")) throw new Error("stable releases must not be prereleases and beta releases must be prereleases");
  if (!/^[0-9a-f]{16}$/u.test(options["--trusted-key-id"])) throw new Error("trusted key id must be lowercase 16-hex");
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(options["--trusted-public-key-base64"])) throw new Error("trusted public key must be base64-encoded Ed25519 raw bytes");
  return options;
}

function parseChecksums(contents) {
  const checksums = new Map();
  for (const line of contents.trim().split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match || checksums.has(match[2])) throw new Error("SHA256SUMS contains an invalid or duplicate record");
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function releaseURL(version, name) {
  return `https://github.com/${canonicalRepository}/releases/download/v${version}/${name}`;
}

async function regularFileSize(file, maximum = 6 * 1024 * 1024 * 1024) {
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error(`invalid release file: ${path.basename(file)}`);
  return info.size;
}

async function archiveTarget(directory, checksums, version, platform, architecture, extension) {
  const name = `multivibe-host_${version}_${platform}_${architecture}.${extension}`;
  const digest = checksums.get(name);
  if (!digestPattern.test(digest ?? "")) throw new Error(`missing archive checksum: ${name}`);
  const file = path.join(directory, name);
  try {
    const size = await regularFileSize(file);
    return { kind: "archive", url: releaseURL(version, name), size, sha256: digest };
  } catch (error) {
    if (!(["linux", "windows"].includes(platform)) || error?.code !== "ENOENT") throw error;
  }

  const parts = [];
  for (let index = 1; index <= 999; index += 1) {
    const partName = `${name}.part-${String(index).padStart(3, "0")}`;
    const partDigest = checksums.get(partName);
    if (!partDigest) break;
    const size = await regularFileSize(path.join(directory, partName), 2 * 1024 * 1024 * 1024);
    parts.push({ url: releaseURL(version, partName), size, sha256: partDigest });
  }
  if (parts.length < 2) throw new Error("multipart provider-host release is incomplete");
  return {
    kind: "archive",
    size: parts.reduce((total, part) => total + part.size, 0),
    sha256: digest,
    parts,
  };
}

function rawPublicKey(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  if (raw.length !== 32) throw new Error("update signing public key is invalid");
  return raw;
}

function keyIdentity(publicKey) {
  return createHash("sha256").update(rawPublicKey(publicKey)).digest("hex").slice(0, 16);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const version = options["--version"];
  const sourceCommit = options["--commit"];
  const directory = path.resolve(options["--release-dir"]);
  const checksums = parseChecksums(await readFile(path.join(directory, "SHA256SUMS"), "utf8"));
  const container = JSON.parse(await readFile(path.resolve(options["--container-metadata"]), "utf8"));
  if (container.releaseType !== "multivibe-provider-host-container-v1" || container.version !== version ||
      container.sourceCommit !== sourceCommit || container.image !== canonicalImage ||
      !/^sha256:[0-9a-f]{64}$/u.test(container.digest ?? "") || container.immutableReference !== `${canonicalImage}@${container.digest}`) {
    throw new Error("container release metadata does not match the update feed");
  }

  const privateKeyBase64 = process.env.MULTIVIBE_UPDATE_SIGNING_KEY_BASE64 ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(privateKeyBase64)) throw new Error("MULTIVIBE_UPDATE_SIGNING_KEY_BASE64 is unavailable");
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("update signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const signingKeyID = keyIdentity(publicKey);
  const signingPublicKey = rawPublicKey(publicKey).toString("base64");
  if (signingKeyID !== options["--trusted-key-id"] || signingPublicKey !== options["--trusted-public-key-base64"]) {
    throw new Error("the update signing key does not match the updater trust root");
  }
  const published = new Date();
  const expires = new Date(published.getTime() + 180 * 24 * 60 * 60 * 1000);
  const signed = {
    schema_version: schemaVersion,
    channel: options["--channel"],
    version,
    source_commit: sourceCommit,
    published_at: published.toISOString(),
    expires_at: expires.toISOString(),
    minimum_version: "0.2.0",
    rollout_percent: 100,
    critical: false,
    targets: {
      "darwin-arm64": await archiveTarget(directory, checksums, version, "darwin", "arm64", "dmg"),
      "darwin-amd64": await archiveTarget(directory, checksums, version, "darwin", "amd64", "dmg"),
      "linux-amd64": await archiveTarget(directory, checksums, version, "linux", "amd64", "tar.gz"),
      "windows-amd64": await archiveTarget(directory, checksums, version, "windows", "amd64", "zip"),
      "docker-linux-amd64": {
        kind: "container",
        image: canonicalImage,
        digest: container.digest,
        immutable_reference: container.immutableReference,
      },
    },
  };
  const signedBytes = Buffer.from(JSON.stringify(signed));
  const signature = sign(null, signedBytes, privateKey);
  const envelope = {
    signed: signedBytes.toString("base64url"),
    signatures: [{
      key_id: signingKeyID,
      algorithm: "ed25519",
      signature: signature.toString("base64url"),
    }],
  };
  await writeFile(path.resolve(options["--output"]), `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  process.stdout.write(`${JSON.stringify({ version, targets: Object.keys(signed.targets), keyId: envelope.signatures[0].key_id })}\n`);
}

main().catch((error) => {
  console.error(`provider-host update feed failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
