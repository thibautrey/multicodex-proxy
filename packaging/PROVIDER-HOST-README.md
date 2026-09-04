# MultiVibe Host

This archive contains the auditable MultiVibe Core, the provider host launcher,
the local provider agent, pinned Node.js and Ollama runtimes, the approved local
model catalog and the bundled Security module. It supports Apple Silicon and
Intel Macs, plus Linux and Windows amd64 hosts with a working NVIDIA GPU of
compute capability 7.0 or newer. No system Node.js, Ollama, package manager or
administrator access is required after downloading the matching archive.

The archive also includes the optional `multivibe-runtime-benchmark` CLI, the
reviewed runtime-profile catalog, closed JSON schemas and disabled examples.
The CLI is separate from the provider HTTP service, accepts no prompt text and
requires an explicit `--run` plus both reviewed catalogs against a numeric
loopback Ollama endpoint. It rejects runtime-version or model digest/size
substitution before generation. See
`provider-agent/RUNTIME_BENCHMARKS.md` in the source tree for the complete
measurement and safety contract.

The included installer verifies every extracted file's path, mode, size and
SHA-256 against `manifest.json`, rejects symbolic links and undeclared files,
runs `doctor` before changing the machine, and verifies the application code
signature on macOS. It stages the application on the destination filesystem and
commits it with a rename. The host application binds to loopback, generates
private local credentials on first start and keeps every state file under the
operator-selected data directory. Provider sharing, automatic downloads and
Cloud enrollment remain off until the operator gives explicit consent in the
local application.

An archive cannot authenticate the verifier contained inside itself. Before
extracting or executing any downloaded release file, verify its GitHub build
provenance with a separately installed GitHub CLI:

```sh
gh attestation verify /path/to/multivibe-host_VERSION_PLATFORM_ARCHIVE \
  --repo thibautrey/multivibe
```

Do not continue if that command fails. Official releases also publish signed
checksums and a Sigstore bundle, but a public key downloaded from the same
unverified release page is not by itself a trust root. Internal manifest and
platform-signature checks are defense in depth after this external gate.

The bundled Ollama tree is immutable release input. On first use, MultiVibe can
verify and atomically adopt it into its managed runtime directory; a network
download is only a verified fallback. Model weights are not bundled and are
downloaded only when the operator has enabled automatic downloads and the local
capacity policy allows them.

This archive deliberately contains no production Cloud demand key. Managed
demand reconciliation remains unavailable unless the operator starts the host
with `MULTIVIBE_PROVIDER_DEMAND_TRUSTED_KEYS` set to an explicitly trusted
Ed25519 public-key map. The RFC interoperability key used by the source tests is
not a production trust root and is never packaged as one.

From a source checkout, inspect a release archive without executing it using:

```sh
node scripts/verify-provider-host.mjs /path/to/provider-host-archive
```

Use `--require-runtime` on a matching supported host to additionally execute
the version checks and `doctor`. The installers always require that runtime
check.

## macOS Apple Silicon and Intel

Download the `.dmg` matching the Mac architecture, open it, then drag
**MultiVibe Host** onto the **Applications** shortcut, just like a standard macOS app.
The disk image and application are both signed with Developer ID and notarized by Apple.

Opening **MultiVibe Host** starts a menu-bar application using the official
MultiVibe icon. It starts the loopback-only host when necessary, reports its
operational state, and opens the protected local web dashboard without putting
the persistent admin credential in the browser URL. When OpenAI quota data is
available, the menu-bar label mirrors the former SwiftBar summary and its native
popover shows aggregate and per-account five-hour, weekly, and monthly remaining
capacity, reset times, and account health. The Host exposes only the fields
needed by this view; account tokens, internal identifiers, and upstream errors
are excluded. Daily, weekly and monthly
earnings remain explicitly unavailable until the separate Cloud workload and
compensation service is active; the application never derives or invents
earnings from local inference-cost estimates.

The installer requires no administrator privileges. It verifies the app's code
signature, installs it at `~/Applications/MultiVibe Host.app`, initializes the
private state directory, and loads
`~/Library/LaunchAgents/cloud.multivibe.host.plist`. Logs are written below
`~/Library/Logs/MultiVibe Host`.

The installer also loads `cloud.multivibe.host.update`, a per-user LaunchAgent
that wakes hourly. The updater stores a randomized next-check time, so public
release metadata is fetched only every 10 to 14 hours. Stable updates are
downloaded while the Host is running, then installed only after active HTTP,
WebSocket, deferred-job, and managed-runtime operations have drained. The old
application remains available until the new service passes `/health` with the
expected version. A failure restores the previous application and LaunchAgents.

## Linux amd64 with NVIDIA

The native status menu requires a Linux desktop session with the GTK 3 runtime
installed. The Host itself remains usable without a graphical session.

From the extracted archive, run:

```sh
./install.sh
```

The application is installed for the current user in
`~/.local/lib/multivibe-host`, with a command launcher at
`~/.local/bin/multivibe-host`. The GTK 3 status menu is launched through
`~/.local/bin/multivibe-host-menu` and registered as a per-user desktop
autostart entry. The same desktop entry handles `multivibe://` Cloud connection
links. It uses the same local dashboard endpoint and account/quota aggregation
as the macOS menu, while GTK supplies the Linux-native rendering.
If a working systemd user manager is available, the installer enables and
starts `multivibe-host.service`. It never attempts to install or repair
systemd.

On private environment and other systems without a systemd user manager, run:

```sh
./install.sh --foreground
```

This installs the same verified application and then replaces the installer
process with MultiVibe Host. Keep the terminal or supervisor attached; use
Ctrl-C to stop it. A default installation without systemd remains stopped and
prints the exact foreground command.

With a user systemd manager the native installer also enables
`multivibe-host-update.timer`. It invokes the separate updater process hourly;
the randomized 10-to-14-hour schedule in the updater avoids synchronized
release checks. The service stages and verifies the complete archive before it
stops MultiVibe, and the installer retains the previous directory and unit
files until the new process reports the exact release version through
`/health`. Foreground installations do not enable an automatic timer because
MultiVibe cannot safely control an unknown external supervisor.

## Windows amd64 with NVIDIA

The Windows native package is a verified ZIP for 64-bit Windows. It requires
PowerShell 5.1 or newer and a working NVIDIA driver with compute capability
7.0 or newer. No administrator privileges are required.

Extract the ZIP to a temporary directory, open PowerShell as the installing
user, and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer verifies the complete bundle and the matching Windows runtime
before it changes the machine. It installs the application under
`%LOCALAPPDATA%\Programs\MultiVibe Host`, keeps private state and logs under
`%LOCALAPPDATA%\MultiVibe`, and registers a per-user Start Menu shortcut,
login entry, `multivibe://` protocol handler, and scheduled update task. The
native Win32 tray menu starts and stops the Host, opens the local dashboard,
shows account and quota status, and exposes the Host update actions.

The scheduled updater checks the signed release feed at a randomized interval,
downloads only a matching Windows ZIP, and extracts it with path, size,
checksum, and reparse-point checks. It stops only MultiVibe processes whose
executable paths belong to the managed installation. The previous version is
retained until the replacement passes its post-start health check and is
restored if installation or health validation fails.

To remove the native installation while preserving state, run from the
matching extracted archive or installed version:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Pass `-Purge` only when the default `%LOCALAPPDATA%\MultiVibe` state directory
should also be deleted. A custom `MULTIVIBE_HOST_DATA_DIR` is never discovered
or removed automatically.

## Linux container, Docker Compose and Unraid

Official tagged releases also publish the verified Linux bundle as
`ghcr.io/thibautrey/multivibe-host:<version>`. The container supports Linux
amd64 with an NVIDIA GPU only. It needs NVIDIA container-runtime access to one
GPU, persistent `/data` and `/models` mounts, and an explicit browser-facing
origin:

```sh
MULTIVIBE_HOST_PUBLIC_URL=http://192.168.1.20:1455 \
  docker compose -f docker-compose.host.yml up -d
```

The matching GitHub release attaches `container-release.json`, which binds the
version, source commit, supported platform and immutable GHCR digest. Its
release notes include both the versioned pull command and digest-pinned image
reference. The rolling `latest` tag is kept for Unraid updates and convenience;
use the versioned tag or immutable digest for reproducible deployments and
rollbacks.

The container deliberately cannot update itself and does not need the Docker
socket. To enable verified automatic updates on a Linux Docker Compose host,
extract the signed Linux archive and run:

```sh
./install-docker-updater.sh \
  --compose-file /absolute/path/docker-compose.host.yml \
  --project-directory /absolute/path/to/the/compose/project
```

The host-side systemd timer authenticates `multivibe-host-update-stable.json`,
pulls the signed immutable image digest, writes a private Compose override,
recreates only `multivibe-host`, waits up to 120 seconds for Docker health, and
restores the previous image reference if the update fails. Remove only this
timer with `./uninstall-docker-updater.sh`; volumes and images are preserved.
The supplied Compose file accepts a complete immutable reference through
`MULTIVIBE_HOST_IMAGE`. Do not mount `/var/run/docker.sock` into MultiVibe or an
updater sidecar.

On Unraid, the template intentionally follows the official `latest` tag so the
Unraid update checker and Community Applications Auto Update plugin can manage
container recreation. The versioned digest in the matching GitHub release
remains the rollback reference.

## Update trust and policy

Every release attaches `multivibe-host-update-stable.json` or, for a
prerelease, `multivibe-host-update-beta.json`. Its payload is signed with a
dedicated Ed25519 key whose public half is compiled into the updater. It binds
one semantic version and source commit to the exact SHA-256 and byte length of
each native archive and to the immutable GHCR digest. Signed publication and
expiry timestamps, a minimum compatible version, a critical-update flag and a
local rollout percentage are checked before any download. GitHub and TLS are
transport and discovery layers; they are not the update trust root.

The default policy is `automatic` on the `stable` channel. In the dashboard's
**Host updates** page it can be changed to `download` or `notify`, and the beta
channel can be selected explicitly. Update state contains no prompt, response,
account, hardware identifier, provider key, or Cloud credential. The rollout
bucket is generated and evaluated locally and is never transmitted.

Container mode binds Core to `0.0.0.0:1455`; the Host refuses that exposed bind
unless `MULTIVIBE_HOST_PUBLIC_URL` is a clean path-free HTTP(S) origin. Core's
OAuth callback is derived from the same value. Provider-agent and managed
Ollama endpoints remain loopback-only and are not published to the Docker
network.

The image starts only long enough as root to protect the two declared mount
roots, then drops to uid/gid `10001:10001`, clears every capability and runs
with `no-new-privileges`. Its root filesystem is read-only in the supplied
Compose and Unraid configurations. `/data` contains private credentials,
identity and application state. `/models/runtime` contains the managed Ollama
runtime; choose `/models/weights` explicitly when creating the local capacity
policy. No policy, download permission, Cloud workload consent or compensation
state is inferred from mounting the directory.

The source repository contains `templates/multivibe-host.xml` for Unraid. It is
marked beta and requires the Unraid Nvidia Driver plugin plus an NVIDIA GPU of
compute capability 7.0 or newer. A source template is not evidence that
Community Applications has accepted or listed the app.

## Uninstalling

Run `./uninstall.sh` from the matching release archive. On Linux it is also
available at `~/.local/lib/multivibe-host/uninstall.sh`. Uninstallation removes
only the managed app, launcher and service definition. User data, downloaded
models and local credentials are preserved by default.

To explicitly delete the default state directory too, use:

```sh
./uninstall.sh --purge
```

`--purge` does not discover or delete a custom data directory. Remove such a
directory manually after checking its contents. Stop a Linux foreground process
with Ctrl-C before running the uninstaller.

The operator owns the machine and can pause or stop MultiVibe Host at any time.
MultiVibe must not inspect unrelated files, applications, processes, network
services or input devices. Hardware information is reduced to the allowlisted
capacity fields shown by `doctor`; stable hardware identifiers are excluded.

No compensation is active in this release. If the marketplace is activated
after its production gates pass, the announced split for eligible, cleared
community-workload revenue is 85% to the host operator and a 15% MultiVibe
service fee, before applicable taxes, reserves, disputes and reversals. The
separate 5% fee applies only to customer purchases or top-ups and is not an
additional deduction from the host operator's 85% share.

The repository source code's Apache-2.0 terms and copyright notice are in
`LICENSE` and `NOTICE`. Node.js, Ollama and reviewed model notices remain
separately listed under `THIRD_PARTY`; access to the hosted multivibe.cloud
service is not included in this archive.

See the public source and full security boundary at
https://github.com/thibautrey/multivibe.
