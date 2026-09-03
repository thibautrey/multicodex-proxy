import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repositoryRoot, relative), "utf8");

test("the Host runtime image preserves the verified bundle layout and drops privileges", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    read("packaging/container/Dockerfile"),
    read("packaging/container/entrypoint.sh"),
  ]);
  assert.match(dockerfile, /COPY --chown=10001:10001 bundle\/ \/opt\/multivibe-host\//u);
  assert.match(dockerfile, /VOLUME \["\/data", "\/models"\]/u);
  assert.match(dockerfile, /MULTIVIBE_HOST_BIND=0\.0\.0\.0/u);
  assert.match(dockerfile, /MULTIVIBE_HOST_MANAGED_DIR=\/models\/runtime/u);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/multivibe-host-container"\]/u);
  assert.match(entrypoint, /APPLICATION_USER_ID=10001/u);
  assert.match(entrypoint, /--bounding-set=-all/u);
  assert.match(entrypoint, /--no-new-privs/u);
  assert.doesNotMatch(entrypoint, /chown\s+(?:-[^\s]+\s+)*-R/u);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+/u);
});

test("the Compose deployment exposes only Core and keeps state and models separate", async () => {
  const compose = await read("docker-compose.host.yml");
  assert.match(compose, /image: ghcr\.io\/thibautrey\/multivibe-host:/u);
  assert.doesNotMatch(compose, /^\s+build:/mu);
  assert.match(compose, /MULTIVIBE_HOST_BIND: 0\.0\.0\.0/u);
  assert.match(compose, /MULTIVIBE_HOST_PUBLIC_URL: \$\{MULTIVIBE_HOST_PUBLIC_URL:\?/u);
  assert.match(compose, /MULTIVIBE_HOST_MANAGED_DIR: \/models\/runtime/u);
  assert.match(compose, /- multivibe-host-data:\/data/u);
  assert.match(compose, /- multivibe-host-models:\/models/u);
  assert.match(compose, /gpus: all/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /cap_drop:\n\s+- ALL/u);
  assert.doesNotMatch(compose, /privileged:\s*true/u);
  assert.doesNotMatch(compose, /ADMIN_TOKEN|PROXY_API_KEY/u);
});

test("the Unraid template is beta, GPU-bounded and does not request credentials", async () => {
  const [profile, template] = await Promise.all([
    read("ca_profile.xml"),
    read("templates/multivibe-host.xml"),
  ]);
  assert.match(profile, /^<CommunityApplications>[\s\S]*<Profile>/u);
  assert.match(template, /^<Container version="2">/u);
  assert.match(template, /<Repository>ghcr\.io\/thibautrey\/multivibe-host:latest<\/Repository>/u);
  assert.match(template, /<Privileged>false<\/Privileged>/u);
  assert.match(template, /<Beta>true<\/Beta>/u);
  assert.match(template, /--runtime=nvidia/u);
  assert.match(template, /Target="\/data"/u);
  assert.match(template, /Target="\/models"/u);
  assert.match(template, /Target="MULTIVIBE_HOST_PUBLIC_URL"/u);
  assert.match(template, /Target="NVIDIA_VISIBLE_DEVICES"/u);
  assert.match(template, /compute capability 7\.0 or newer/u);
  assert.doesNotMatch(template, /ADMIN_TOKEN|PROXY_API_KEY/u);
});

test("the release workflow publishes a tested image from the verified Linux archive", async () => {
  const [workflow, packager] = await Promise.all([
    read(".github/workflows/provider-host-release.yml"),
    read("scripts/package-provider-host.mjs"),
  ]);
  assert.match(packager, /"docker-compose\.host\.yml"\), path\.join\(root, "docker-compose\.host\.yml"\)/u);
  assert.match(workflow, /publish-container:/u);
  assert.match(workflow, /packages: write/u);
  assert.match(workflow, /name: provider-host-linux/u);
  assert.match(workflow, /npm run verify:provider-host -- "\$archive"/u);
  assert.match(workflow, /packaging\/container\/Dockerfile/u);
  assert.match(workflow, /docker run --rm "\$image:\$version" version/u);
  assert.match(workflow, /docker push "\$image:\$version"/u);
  assert.match(workflow, /docker push "\$image:latest"/u);
});
