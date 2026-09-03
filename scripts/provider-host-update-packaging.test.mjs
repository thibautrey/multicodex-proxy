import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("native packages include the updater and platform schedulers", async () => {
  const [packager, linux, macos, verifier] = await Promise.all([
    read("scripts/package-provider-host.mjs"), read("packaging/linux/install.sh"),
    read("packaging/macos/install.sh"), read("scripts/verify-provider-host.mjs"),
  ]);
  assert.match(packager, /buildGo\(path\.join\(repositoryRoot, "host-updater"\)/u);
  assert.match(packager, /path\.join\(contents, "Resources", "update", "install\.sh"\)/u);
  assert.match(packager, /install-docker-updater\.sh/u);
  assert.match(linux, /multivibe-host-update\.timer/u);
  assert.match(linux, /multivibe-host-updater" auto/u);
  assert.match(linux, /cat > "\$UPDATE_SERVICE_STAGING" <<EOF/u);
  assert.doesNotMatch(linux, /cat > "\$UPDATE_SERVICE_STAGING" <<'EOF'/u);
  assert.match(linux, /body\.version!==process\.argv\[1\]/u);
  assert.match(macos, /cloud\.multivibe\.host\.update/u);
  assert.match(macos, /Contents\/Helpers\/multivibe-host-updater/u);
  assert.match(macos, /UPDATE_SERVICE_KEPT_LOADED/u);
  assert.match(macos, /body\.version!==process\.argv\[1\]/u);
  assert.match(verifier, /multivibe-host-updater/u);
});

test("Docker updates stay outside the container and roll back through Compose", async () => {
  const [dockerfile, installer, updater] = await Promise.all([
    read("packaging/container/Dockerfile"), read("packaging/docker/install-host-updater.sh"), read("host-updater/docker.go"),
  ]);
  assert.match(dockerfile, /MULTIVIBE_HOST_CONTAINER=true/u);
  assert.doesNotMatch(dockerfile, /docker\.sock/u);
  assert.match(installer, /multivibe-host-docker-update\.timer/u);
  assert.match(updater, /ImmutableReference/u);
  assert.match(updater, /the previous image was restored/u);
  assert.match(updater, /RepoDigests/u);
});
