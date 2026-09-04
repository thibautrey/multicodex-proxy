import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("native packages include the updater and platform schedulers", async () => {
  const [packager, linux, macos, windows, verifier, uninstall] = await Promise.all([
    read("scripts/package-provider-host.mjs"), read("packaging/linux/install.sh"),
    read("packaging/macos/install.sh"), read("packaging/windows/install.ps1"),
    read("scripts/verify-provider-host.mjs"), read("packaging/linux/uninstall.sh"),
  ]);
  assert.match(packager, /buildGo\(path\.join\(repositoryRoot, "host-updater"\)/u);
  assert.match(packager, /buildRustEdge\(edgeDestination\)/u);
  assert.match(packager, /path\.join\(contents, "Helpers", "multivibe-v1-edge"\)/u);
  assert.match(packager, /buildGo\(\s*path\.join\(repositoryRoot, "host-menu"\)/u);
  assert.match(packager, /CGO_ENABLED: selectedTarget\.goos === "linux" \? "1" : "0"/u);
  assert.match(packager, /favicon-32x32\.png/u);
  assert.match(packager, /path\.join\(contents, "Resources", "update", "install\.sh"\)/u);
  assert.match(packager, /install-docker-updater\.sh/u);
  assert.match(
    packager,
    /await command\("codesign", \["--verify", "--strict", "--verbose=2", node\]\)/u,
  );
  assert.match(
    packager,
    /await command\(node, \["--eval", betterSQLiteSmokeTest\]/u,
  );
  assert.doesNotMatch(
    packager,
    /\.\.\.native,\s*path\.join\(contents, "Frameworks", "node"\)/u,
  );
  assert.match(linux, /multivibe-host-update\.timer/u);
  assert.match(linux, /multivibe-host-updater" auto/u);
  assert.match(linux, /cat > "\$UPDATE_SERVICE_STAGING" <<EOF/u);
  assert.doesNotMatch(linux, /cat > "\$UPDATE_SERVICE_STAGING" <<'EOF'/u);
  assert.match(linux, /body\.version!==process\.argv\[1\]/u);
  assert.match(linux, /SOURCE_MENU/u);
  assert.match(linux, /multivibe-host-menu\.desktop/u);
  assert.match(linux, /X-GNOME-Autostart-enabled=true/u);
  assert.match(linux, /x-scheme-handler\/multivibe/u);
  assert.match(macos, /cloud\.multivibe\.host\.update/u);
  assert.match(macos, /Contents\/Helpers\/multivibe-host-updater/u);
  assert.match(macos, /UPDATE_SERVICE_KEPT_LOADED/u);
  assert.match(macos, /body\.version!==process\.argv\[1\]/u);
  assert.match(verifier, /multivibe-host-updater/u);
  assert.match(verifier, /multivibe-v1-edge/u);
  assert.match(verifier, /multivibe-host-menu/u);
  assert.match(uninstall, /multivibe-host-menu\.desktop/u);
  assert.match(packager, /windows-amd64.*zip/su);
  assert.match(packager, /install\.ps1/u);
  assert.match(packager, /uninstall\.ps1/u);
  assert.match(packager, /multivibe-host\.ico/u);
  assert.match(windows, /Register-ScheduledTask/u);
  assert.match(windows, /Restore-ManagedTaskSnapshot/u);
  assert.match(windows, /Stop-ScheduledTask/u);
  assert.match(windows, /Get-Process -Name \$name/u);
  assert.match(windows, /Test-PathWithin \$processPath \$VersionsRoot/u);
  assert.match(windows, /"node", "ollama", "llama-server"/u);
  assert.match(packager, /Expand-Archive|Compress-Archive/u);
  const windowsUninstall = await read("packaging/windows/uninstall.ps1");
  assert.match(windowsUninstall, /"node", "ollama", "llama-server"/u);
  assert.match(windowsUninstall, /Test-PathWithin \$processPath \$VersionsRoot/u);
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
