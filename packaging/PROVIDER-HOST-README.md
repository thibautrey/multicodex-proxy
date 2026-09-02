# MultiVibe Host

This archive contains the auditable MultiVibe Core, the provider host launcher,
the local provider agent, pinned Node.js and Ollama runtimes, the approved local
model catalog and the bundled Security module. It supports only Apple Silicon
on macOS and Linux amd64 hosts with a working NVIDIA GPU of compute capability
7.0 or newer. No system Node.js, Ollama, package manager or administrator access
is required after downloading the matching archive.

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

## macOS Apple Silicon

From the extracted archive, run:

```sh
./install.sh
```

The installer requires no administrator privileges. It verifies the app's code
signature, installs it at `~/Applications/MultiVibe Host.app`, initializes the
private state directory, and loads
`~/Library/LaunchAgents/cloud.multivibe.host.plist`. Logs are written below
`~/Library/Logs/MultiVibe Host`.

## Linux amd64 with NVIDIA

From the extracted archive, run:

```sh
./install.sh
```

The application is installed for the current user in
`~/.local/lib/multivibe-host`, with a command launcher at
`~/.local/bin/multivibe-host`. If a working systemd user manager is available,
the installer enables and starts `multivibe-host.service`. It never attempts to
install or repair systemd.

On private environment and other systems without a systemd user manager, run:

```sh
./install.sh --foreground
```

This installs the same verified application and then replaces the installer
process with MultiVibe Host. Keep the terminal or supervisor attached; use
Ctrl-C to stop it. A default installation without systemd remains stopped and
prints the exact foreground command.

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
