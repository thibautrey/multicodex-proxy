#!/usr/bin/env node

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const imagePattern = /^ghcr\.io\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/multivibe-host$/u;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function createContainerReleaseMetadata(image, version, digest, sourceCommit) {
  if (!imagePattern.test(image ?? "")) throw new Error("container image must be the canonical GHCR Host image");
  if (!versionPattern.test(version ?? "")) throw new Error("container version must be canonical semantic versioning");
  if (!digestPattern.test(digest ?? "")) throw new Error("container digest must be lowercase SHA-256");
  if (!commitPattern.test(sourceCommit ?? "")) throw new Error("source commit must be lowercase 40-hex");
  return {
    schemaVersion: 1,
    releaseType: "multivibe-provider-host-container-v1",
    image,
    version,
    versionTag: `${image}:${version}`,
    rollingTag: `${image}:latest`,
    digest,
    immutableReference: `${image}@${digest}`,
    sourceCommit,
    sourceArchive: `multivibe-host_${version}_linux_amd64.tar.gz`,
    platform: {
      os: "linux",
      architecture: "amd64",
      accelerator: "nvidia",
    },
  };
}

export function validateContainerReleaseMetadata(metadata, expectedVersion, expectedCommit) {
  if (!exactKeys(metadata, [
    "schemaVersion", "releaseType", "image", "version", "versionTag", "rollingTag", "digest",
    "immutableReference", "sourceCommit", "sourceArchive", "platform",
  ]) || !exactKeys(metadata.platform, ["os", "architecture", "accelerator"])) {
    throw new Error("container release metadata shape is invalid");
  }
  const expected = createContainerReleaseMetadata(metadata.image, expectedVersion, metadata.digest, expectedCommit);
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    throw new Error("container release metadata does not match the release identity");
  }
  return metadata;
}

export function renderContainerReleaseNotes(metadata) {
  validateContainerReleaseMetadata(metadata, metadata.version, metadata.sourceCommit);
  return `## Container image

Pull the versioned Linux amd64 NVIDIA image:

\`\`\`sh
docker pull ${metadata.versionTag}
\`\`\`

Immutable reference: \`${metadata.immutableReference}\`

The \`${metadata.rollingTag}\` tag is provided for Unraid and convenient updates, but it is not immutable. The attached \`container-release.json\` records the exact image digest and source commit and has GitHub build-provenance attestation.
`;
}

async function build([image, version, digest, sourceCommit, outputDirectory]) {
  if (!outputDirectory) throw new Error("container release output directory is required");
  const metadata = createContainerReleaseMetadata(image, version, digest, sourceCommit);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "container-release.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o444 }),
    writeFile(path.join(outputDirectory, "container-release-notes.md"), renderContainerReleaseNotes(metadata), { flag: "wx", mode: 0o444 }),
  ]);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

async function verify([metadataPath, expectedVersion, expectedCommit]) {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  validateContainerReleaseMetadata(metadata, expectedVersion, expectedCommit);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

async function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedDirectly()) {
  const [command, ...arguments_] = process.argv.slice(2);
  const operation = command === "build" ? build : command === "verify" ? verify : null;
  if (!operation) {
    console.error("usage: provider-host-container-release.mjs <build|verify> ...");
    process.exitCode = 1;
  } else {
    operation(arguments_).catch((error) => {
      console.error(`provider-host container release failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 1;
    });
  }
}
