import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createContainerReleaseMetadata,
  renderContainerReleaseNotes,
  validateContainerReleaseMetadata,
} from "./provider-host-container-release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repositoryRoot, relative), "utf8");

test("the Host runtime image preserves the verified bundle layout and drops privileges", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    read("packaging/container/Dockerfile"),
    read("packaging/container/entrypoint.sh"),
  ]);
  assert.match(dockerfile, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/mu);
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

test("the root README offers truthful latest-release paths for every Host format", async () => {
  const readme = await read("README.md");
  assert.match(readme, /## ⬇️ Download MultiVibe Host/u);
  assert.match(readme, /Signed and notarized `\.dmg` for Apple Silicon and Intel/u);
  assert.match(readme, /Linux `x86_64` with an NVIDIA GPU, compute capability 7\.0\+/u);
  assert.match(readme, /Docker \/ Unraid[\s\S]*GitHub Container Registry/u);
  assert.match(readme, /https:\/\/github\.com\/thibautrey\/multivibe\/releases\/latest/u);
  assert.match(readme, /docker pull ghcr\.io\/thibautrey\/multivibe-host:latest/u);
  assert.match(readme, /no tagged Host release with[\s\S]*Docker publishing has completed yet/u);
  assert.doesNotMatch(readme, /thibautrey\/multicodex-proxy/u);
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
  assert.match(workflow, /docker manifest inspect "\$image:\$version"/u);
  assert.match(workflow, /already exists; refusing to overwrite it/u);
  assert.match(workflow, /Could not prove that \$image:\$version is unused; refusing to publish/u);
  assert.match(workflow, /docker push "\$image:\$version"/u);
  assert.match(workflow, /docker push "\$image:latest"/u);
  assert.match(workflow, /docker buildx imagetools inspect "\$image:\$version"/u);
  assert.match(workflow, /latest_digest.*!= "\$digest"/u);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.publish\.outputs\.digest \}\}/u);
  assert.match(workflow, /push-to-registry: true/u);
  assert.match(workflow, /name: provider-host-container-release/u);
  assert.match(workflow, /container-release\/container-release\.json/u);
  assert.match(workflow, /--notes "\$container_notes"/u);
});

test("container release metadata binds the GitHub release to one immutable image", () => {
  const image = "ghcr.io/thibautrey/multivibe-host";
  const version = "0.3.0-rc.1";
  const digest = `sha256:${"a".repeat(64)}`;
  const commit = "b".repeat(40);
  const metadata = createContainerReleaseMetadata(image, version, digest, commit);
  assert.deepEqual(metadata.platform, { os: "linux", architecture: "amd64", accelerator: "nvidia" });
  assert.equal(metadata.versionTag, `${image}:${version}`);
  assert.equal(metadata.immutableReference, `${image}@${digest}`);
  assert.equal(validateContainerReleaseMetadata(metadata, version, commit), metadata);
  const notes = renderContainerReleaseNotes(metadata);
  assert.match(notes, new RegExp(`docker pull ${image}:${version}`, "u"));
  assert.match(notes, new RegExp(`${image}@sha256:${"a".repeat(64)}`, "u"));
  assert.match(notes, /latest.*not immutable/u);
});

test("container release metadata rejects mismatched or noncanonical identities", () => {
  const image = "ghcr.io/thibautrey/multivibe-host";
  const digest = `sha256:${"a".repeat(64)}`;
  const commit = "b".repeat(40);
  assert.throws(() => createContainerReleaseMetadata("docker.io/multivibe-host", "0.3.0", digest, commit), /canonical GHCR/u);
  assert.throws(() => createContainerReleaseMetadata(image, "v0.3.0", digest, commit), /semantic versioning/u);
  assert.throws(() => createContainerReleaseMetadata(image, "0.3.0", "sha256:short", commit), /SHA-256/u);
  const metadata = createContainerReleaseMetadata(image, "0.3.0", digest, commit);
  assert.throws(() => validateContainerReleaseMetadata({ ...metadata, rollingTag: `${image}:stable` }, "0.3.0", commit), /release identity/u);
  assert.throws(() => validateContainerReleaseMetadata(metadata, "0.3.1", commit), /release identity/u);
});
