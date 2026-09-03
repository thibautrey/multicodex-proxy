import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, createPublicKey } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-provider-host-update-feed.mjs", import.meta.url));

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }

async function run(arguments_, environment) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], {
      env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("builds an Ed25519-signed stable update feed for every Host target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "multivibe-update-feed-test-"));
  const version = "1.2.3";
  const commit = "a".repeat(40);
  const checksums = [];
  for (const name of [
    `multivibe-host_${version}_darwin_arm64.dmg`,
    `multivibe-host_${version}_darwin_amd64.dmg`,
    `multivibe-host_${version}_linux_amd64.tar.gz`,
  ]) {
    const data = Buffer.from(`fixture:${name}`);
    await writeFile(path.join(directory, name), data);
    checksums.push(`${sha256(data)}  ${name}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  const digest = `sha256:${"b".repeat(64)}`;
  const containerPath = path.join(directory, "container.json");
  await writeFile(containerPath, JSON.stringify({
    releaseType: "multivibe-provider-host-container-v1", image: "ghcr.io/thibautrey/multivibe-host",
    version, sourceCommit: commit, digest, immutableReference: `ghcr.io/thibautrey/multivibe-host@${digest}`,
  }));
  const { privateKey } = generateKeyPairSync("ed25519");
  const encodedPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicRaw = publicDer.subarray(publicDer.length - 32);
  const keyId = sha256(publicRaw).slice(0, 16);
  const output = path.join(directory, "feed.json");
  const result = await run([
    "--version", version, "--commit", commit, "--channel", "stable", "--release-dir", directory,
    "--container-metadata", containerPath, "--output", output,
    "--trusted-key-id", keyId, "--trusted-public-key-base64", publicRaw.toString("base64"),
  ], { MULTIVIBE_UPDATE_SIGNING_KEY_BASE64: encodedPrivateKey });
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(await readFile(output, "utf8"));
  assert.equal(envelope.signatures[0].algorithm, "ed25519");
  const signed = JSON.parse(Buffer.from(envelope.signed, "base64url").toString("utf8"));
  assert.equal(signed.version, version);
  assert.equal(signed.channel, "stable");
  assert.deepEqual(Object.keys(signed.targets), ["darwin-arm64", "darwin-amd64", "linux-amd64", "docker-linux-amd64"]);
  assert.equal((await stat(output)).mode & 0o777, 0o444);

  const mismatch = await run([
    "--version", version, "--commit", commit, "--channel", "stable", "--release-dir", directory,
    "--container-metadata", containerPath, "--output", path.join(directory, "mismatched-feed.json"),
    "--trusted-key-id", keyId, "--trusted-public-key-base64", `${"A".repeat(43)}=`,
  ], { MULTIVIBE_UPDATE_SIGNING_KEY_BASE64: encodedPrivateKey });
  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.stderr, /does not match the updater trust root/u);
});
