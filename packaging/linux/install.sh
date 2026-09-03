#!/bin/sh

set -eu
umask 077

PROGRAM_NAME="MultiVibe Host installer"
SERVICE_NAME="multivibe-host.service"
UPDATE_SERVICE_NAME="multivibe-host-update.service"
UPDATE_TIMER_NAME="multivibe-host-update.timer"
SERVICE_MARKER="# Managed by the MultiVibe Host installer"
LAUNCHER_MARKER="# Managed by the MultiVibe Host installer"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [--foreground] [--automatic-update]

Install MultiVibe Host for the current user. When a usable systemd user
manager is present, the default mode installs and starts a user service.
Use --foreground on private environment or another host without a systemd user manager;
the installer will start MultiVibe Host in the current terminal after the
installation has completed.
EOF
}

validate_absolute_path() {
  candidate=$1
  description=$2
  case "$candidate" in
    /*) ;;
    *) fail "$description must be an absolute path" ;;
  esac
  case "$candidate" in
    /|*'/../'*|*/..|*'/./'*|*/.|*[![:print:]]*) fail "$description is not a clean path" ;;
  esac
}

ensure_directory() {
  directory=$1
  description=$2
  if [ -L "$directory" ]; then
    fail "$description must not be a symbolic link"
  fi
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then
    fail "$description is not a directory"
  fi
  mkdir -p "$directory"
  if [ -L "$directory" ] || [ ! -d "$directory" ]; then
    fail "$description could not be created safely"
  fi
}

is_managed_file() {
  file=$1
  marker=$2
  [ -f "$file" ] && [ ! -L "$file" ] && IFS= read -r first_line < "$file" && [ "$first_line" = "$marker" ]
}

is_managed_launcher() {
  file=$1
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  {
    IFS= read -r first_line
    IFS= read -r second_line
  } < "$file" || return 1
  [ "$first_line" = "#!/bin/sh" ] && [ "$second_line" = "$LAUNCHER_MARKER" ]
}

MODE=service
while [ "$#" -gt 0 ]; do
  case "$1" in
    --foreground) MODE=foreground ;;
    --automatic-update) ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || fail "this installer supports Linux only"
[ "$(uname -m)" = "x86_64" ] || fail "this installer supports Linux amd64 only"
[ -n "${HOME:-}" ] || fail "HOME is unavailable"
validate_absolute_path "$HOME" "HOME"

SCRIPT_DIRECTORY=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || fail "the release directory is unavailable"
SOURCE_ROOT=$SCRIPT_DIRECTORY
SOURCE_HOST="$SOURCE_ROOT/bin/multivibe-host"
SOURCE_AGENT="$SOURCE_ROOT/bin/multivibe-provider-agent"
SOURCE_UPDATER="$SOURCE_ROOT/bin/multivibe-host-updater"
SOURCE_NODE="$SOURCE_ROOT/bin/node"
SOURCE_VERIFIER="$SOURCE_ROOT/verify-provider-host.mjs"
SOURCE_MANIFEST="$SOURCE_ROOT/manifest.json"

for required in "$SOURCE_HOST" "$SOURCE_AGENT" "$SOURCE_UPDATER" "$SOURCE_NODE"; do
  [ -f "$required" ] && [ ! -L "$required" ] && [ -x "$required" ] || fail "the extracted release is incomplete"
done
[ -f "$SOURCE_VERIFIER" ] && [ ! -L "$SOURCE_VERIFIER" ] || fail "the release verifier is unavailable"
[ -f "$SOURCE_MANIFEST" ] && [ ! -L "$SOURCE_MANIFEST" ] || fail "the extracted release manifest is unavailable"

printf 'Checking the release bundle and NVIDIA host...\n'
"$SOURCE_NODE" "$SOURCE_VERIFIER" --directory "$SOURCE_ROOT" --require-runtime || fail "the release verifier rejected the bundle or this host"

LOCAL_ROOT="$HOME/.local"
LIBRARY_DIRECTORY="$LOCAL_ROOT/lib"
INSTALL_ROOT="$LIBRARY_DIRECTORY/multivibe-host"
BIN_DIRECTORY="$LOCAL_ROOT/bin"
LAUNCHER="$BIN_DIRECTORY/multivibe-host"
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
validate_absolute_path "$CONFIG_HOME" "XDG_CONFIG_HOME"
DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
validate_absolute_path "$DATA_HOME" "XDG_DATA_HOME"
DATA_DIRECTORY="$DATA_HOME/multivibe"
SYSTEMD_DIRECTORY="$CONFIG_HOME/systemd/user"
UNIT_FILE="$SYSTEMD_DIRECTORY/$SERVICE_NAME"
UPDATE_SERVICE_FILE="$SYSTEMD_DIRECTORY/$UPDATE_SERVICE_NAME"
UPDATE_TIMER_FILE="$SYSTEMD_DIRECTORY/$UPDATE_TIMER_NAME"

for configuration_directory in "$CONFIG_HOME" "$CONFIG_HOME/systemd" "$SYSTEMD_DIRECTORY"; do
  if [ -L "$configuration_directory" ]; then
    fail "the systemd configuration path must not contain symbolic links"
  fi
  if [ -e "$configuration_directory" ] && [ ! -d "$configuration_directory" ]; then
    fail "the systemd configuration path contains a non-directory entry"
  fi
done

ensure_directory "$LOCAL_ROOT" "the per-user installation directory"
ensure_directory "$LIBRARY_DIRECTORY" "the per-user library directory"
ensure_directory "$BIN_DIRECTORY" "the per-user binary directory"

if [ -L "$INSTALL_ROOT" ]; then
  fail "the installation destination must not be a symbolic link"
fi
if [ -e "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] || fail "the installation destination is not a directory"
  [ -f "$INSTALL_ROOT/manifest.json" ] && [ ! -L "$INSTALL_ROOT/manifest.json" ] || fail "the existing installation is not managed by MultiVibe Host"
  [ -x "$INSTALL_ROOT/bin/node" ] && [ -f "$INSTALL_ROOT/verify-provider-host.mjs" ] || fail "the existing installation is not managed by MultiVibe Host"
  "$INSTALL_ROOT/bin/node" "$INSTALL_ROOT/verify-provider-host.mjs" --directory "$INSTALL_ROOT" >/dev/null || fail "the existing installation failed integrity verification"
fi

if [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
  is_managed_launcher "$LAUNCHER" || fail "$LAUNCHER already exists and is not managed by MultiVibe Host"
fi

if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then
  is_managed_file "$UNIT_FILE" "$SERVICE_MARKER" || fail "$UNIT_FILE already exists and is not managed by MultiVibe Host"
fi
for update_unit in "$UPDATE_SERVICE_FILE" "$UPDATE_TIMER_FILE"; do
  if [ -e "$update_unit" ] || [ -L "$update_unit" ]; then
    is_managed_file "$update_unit" "$SERVICE_MARKER" || fail "$update_unit already exists and is not managed by MultiVibe Host"
  fi
done

SYSTEMD_AVAILABLE=false
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  SYSTEMD_AVAILABLE=true
fi

SERVICE_WAS_RUNNING=false
SERVICE_WAS_ENABLED=false
UPDATE_TIMER_WAS_ACTIVE=false
UPDATE_TIMER_WAS_ENABLED=false
if [ "$SYSTEMD_AVAILABLE" = true ] && systemctl --user is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
  SERVICE_WAS_RUNNING=true
fi
if [ "$SYSTEMD_AVAILABLE" = true ] && systemctl --user is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
  SERVICE_WAS_ENABLED=true
fi
if [ "$SYSTEMD_AVAILABLE" = true ] && systemctl --user is-active --quiet "$UPDATE_TIMER_NAME" >/dev/null 2>&1; then
  UPDATE_TIMER_WAS_ACTIVE=true
fi
if [ "$SYSTEMD_AVAILABLE" = true ] && systemctl --user is-enabled --quiet "$UPDATE_TIMER_NAME" >/dev/null 2>&1; then
  UPDATE_TIMER_WAS_ENABLED=true
fi

STAGING_DIRECTORY=$(mktemp -d "$LIBRARY_DIRECTORY/.multivibe-host.install.XXXXXX") || fail "the application staging directory could not be created"
case "$STAGING_DIRECTORY/" in
  "$SOURCE_ROOT/"*) rm -rf "$STAGING_DIRECTORY"; fail "the release must not contain the installation staging directory" ;;
esac
BACKUP_DIRECTORY=""
LAUNCHER_BACKUP=""
UNIT_BACKUP=""
UPDATE_SERVICE_BACKUP=""
UPDATE_TIMER_BACKUP=""
LAUNCHER_STAGING=""
UNIT_STAGING=""
UPDATE_SERVICE_STAGING=""
UPDATE_TIMER_STAGING=""
INSTALL_COMMITTED=false
LAUNCHER_COMMITTED=false
UNIT_CHANGED=false
UPDATE_SERVICE_CHANGED=false
UPDATE_TIMER_CHANGED=false
INSTALL_SUCCEEDED=false

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "$INSTALL_SUCCEEDED" != true ]; then
    if [ "$SYSTEMD_AVAILABLE" = true ]; then
      systemctl --user disable --now "$UPDATE_TIMER_NAME" >/dev/null 2>&1 || true
    fi
    if [ "$UPDATE_TIMER_CHANGED" = true ]; then
      rm -f "$UPDATE_TIMER_FILE"
      if [ -n "$UPDATE_TIMER_BACKUP" ] && [ -f "$UPDATE_TIMER_BACKUP" ]; then
        mv "$UPDATE_TIMER_BACKUP" "$UPDATE_TIMER_FILE" || true
        UPDATE_TIMER_BACKUP=""
      fi
    fi
    if [ "$UPDATE_SERVICE_CHANGED" = true ]; then
      rm -f "$UPDATE_SERVICE_FILE"
      if [ -n "$UPDATE_SERVICE_BACKUP" ] && [ -f "$UPDATE_SERVICE_BACKUP" ]; then
        mv "$UPDATE_SERVICE_BACKUP" "$UPDATE_SERVICE_FILE" || true
        UPDATE_SERVICE_BACKUP=""
      fi
    fi
    if [ "$UNIT_CHANGED" = true ]; then
      if [ "$SYSTEMD_AVAILABLE" = true ]; then
        systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
      fi
      rm -f "$UNIT_FILE"
      if [ -n "$UNIT_BACKUP" ] && [ -f "$UNIT_BACKUP" ]; then
        mv "$UNIT_BACKUP" "$UNIT_FILE" || true
        UNIT_BACKUP=""
      fi
    fi
    if [ "$LAUNCHER_COMMITTED" = true ]; then
      rm -f "$LAUNCHER"
    fi
    if [ -n "$LAUNCHER_BACKUP" ] && [ -f "$LAUNCHER_BACKUP" ]; then
      mv "$LAUNCHER_BACKUP" "$LAUNCHER" || true
      LAUNCHER_BACKUP=""
    fi
    if [ "$INSTALL_COMMITTED" = true ]; then
      rm -rf "$INSTALL_ROOT"
    fi
    if [ -n "$BACKUP_DIRECTORY" ] && [ -d "$BACKUP_DIRECTORY" ]; then
      mv "$BACKUP_DIRECTORY" "$INSTALL_ROOT" || true
      BACKUP_DIRECTORY=""
    fi
    if [ "$SYSTEMD_AVAILABLE" = true ]; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      if [ "$UPDATE_TIMER_WAS_ENABLED" = true ]; then
        systemctl --user enable "$UPDATE_TIMER_NAME" >/dev/null 2>&1 || true
      fi
      if [ "$UPDATE_TIMER_WAS_ACTIVE" = true ]; then
        systemctl --user start "$UPDATE_TIMER_NAME" >/dev/null 2>&1 || true
      fi
      if [ "$SERVICE_WAS_ENABLED" = true ]; then
        systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || true
      fi
      if [ "$SERVICE_WAS_RUNNING" = true ]; then
        systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || true
      fi
    fi
  fi
  if [ -n "$STAGING_DIRECTORY" ] && [ -d "$STAGING_DIRECTORY" ]; then
    rm -rf "$STAGING_DIRECTORY"
  fi
  if [ -n "$BACKUP_DIRECTORY" ] && [ -d "$BACKUP_DIRECTORY" ]; then
    rm -rf "$BACKUP_DIRECTORY"
  fi
  if [ -n "$LAUNCHER_STAGING" ] && [ -f "$LAUNCHER_STAGING" ]; then
    rm -f "$LAUNCHER_STAGING"
  fi
  if [ -n "$UNIT_STAGING" ] && [ -f "$UNIT_STAGING" ]; then
    rm -f "$UNIT_STAGING"
  fi
  if [ -n "$UPDATE_SERVICE_STAGING" ] && [ -f "$UPDATE_SERVICE_STAGING" ]; then
    rm -f "$UPDATE_SERVICE_STAGING"
  fi
  if [ -n "$UPDATE_TIMER_STAGING" ] && [ -f "$UPDATE_TIMER_STAGING" ]; then
    rm -f "$UPDATE_TIMER_STAGING"
  fi
  if [ -n "$LAUNCHER_BACKUP" ] && [ -f "$LAUNCHER_BACKUP" ]; then
    rm -f "$LAUNCHER_BACKUP"
  fi
  if [ -n "$UNIT_BACKUP" ] && [ -f "$UNIT_BACKUP" ]; then
    rm -f "$UNIT_BACKUP"
  fi
  if [ -n "$UPDATE_SERVICE_BACKUP" ] && [ -f "$UPDATE_SERVICE_BACKUP" ]; then
    rm -f "$UPDATE_SERVICE_BACKUP"
  fi
  if [ -n "$UPDATE_TIMER_BACKUP" ] && [ -f "$UPDATE_TIMER_BACKUP" ]; then
    rm -f "$UPDATE_TIMER_BACKUP"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cp -a "$SOURCE_ROOT/." "$STAGING_DIRECTORY/"
"$STAGING_DIRECTORY/bin/node" "$STAGING_DIRECTORY/verify-provider-host.mjs" --directory "$STAGING_DIRECTORY" --require-runtime >/dev/null || fail "the staged application failed verification"

if [ "$SERVICE_WAS_RUNNING" = true ]; then
  systemctl --user stop "$SERVICE_NAME" || fail "the existing user service could not be stopped"
fi

if [ -e "$INSTALL_ROOT" ]; then
  BACKUP_DIRECTORY="$LIBRARY_DIRECTORY/.multivibe-host.previous.$$"
  [ ! -e "$BACKUP_DIRECTORY" ] && [ ! -L "$BACKUP_DIRECTORY" ] || fail "the rollback destination already exists"
  mv "$INSTALL_ROOT" "$BACKUP_DIRECTORY"
fi
mv "$STAGING_DIRECTORY" "$INSTALL_ROOT"
STAGING_DIRECTORY=""
INSTALL_COMMITTED=true

LAUNCHER_STAGING=$(mktemp "$BIN_DIRECTORY/.multivibe-host.XXXXXX") || fail "the command launcher could not be staged"
cat > "$LAUNCHER_STAGING" <<'EOF'
#!/bin/sh
# Managed by the MultiVibe Host installer
set -eu
: "${HOME:?HOME is unavailable}"
exec "$HOME/.local/lib/multivibe-host/bin/multivibe-host" "$@"
EOF
chmod 0755 "$LAUNCHER_STAGING"
if [ -e "$LAUNCHER" ]; then
  LAUNCHER_BACKUP="$BIN_DIRECTORY/.multivibe-host.previous.$$"
  [ ! -e "$LAUNCHER_BACKUP" ] && [ ! -L "$LAUNCHER_BACKUP" ] || fail "the launcher rollback destination already exists"
  mv "$LAUNCHER" "$LAUNCHER_BACKUP"
fi
mv "$LAUNCHER_STAGING" "$LAUNCHER"
LAUNCHER_STAGING=""
LAUNCHER_COMMITTED=true

"$INSTALL_ROOT/bin/multivibe-host" init

if [ "$MODE" = foreground ]; then
  if [ "$SYSTEMD_AVAILABLE" = true ]; then
    systemctl --user disable --now "$UPDATE_TIMER_NAME" >/dev/null 2>&1 || true
  fi
  if [ -e "$UPDATE_TIMER_FILE" ]; then
    UPDATE_TIMER_BACKUP="$SYSTEMD_DIRECTORY/.multivibe-host-update.timer.previous.$$"
    [ ! -e "$UPDATE_TIMER_BACKUP" ] && [ ! -L "$UPDATE_TIMER_BACKUP" ] || fail "the update timer rollback destination already exists"
    mv "$UPDATE_TIMER_FILE" "$UPDATE_TIMER_BACKUP"
    UPDATE_TIMER_CHANGED=true
  fi
  if [ -e "$UPDATE_SERVICE_FILE" ]; then
    UPDATE_SERVICE_BACKUP="$SYSTEMD_DIRECTORY/.multivibe-host-update.service.previous.$$"
    [ ! -e "$UPDATE_SERVICE_BACKUP" ] && [ ! -L "$UPDATE_SERVICE_BACKUP" ] || fail "the update service rollback destination already exists"
    mv "$UPDATE_SERVICE_FILE" "$UPDATE_SERVICE_BACKUP"
    UPDATE_SERVICE_CHANGED=true
  fi
  if [ -e "$UNIT_FILE" ]; then
    if [ "$SYSTEMD_AVAILABLE" = true ]; then
      systemctl --user disable --now "$SERVICE_NAME" || fail "the existing user service could not be disabled"
    fi
    UNIT_BACKUP="$SYSTEMD_DIRECTORY/.multivibe-host.service.previous.$$"
    [ ! -e "$UNIT_BACKUP" ] && [ ! -L "$UNIT_BACKUP" ] || fail "the service rollback destination already exists"
    mv "$UNIT_FILE" "$UNIT_BACKUP"
    UNIT_CHANGED=true
    if [ "$SYSTEMD_AVAILABLE" = true ]; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
  fi
else
  if [ "$SYSTEMD_AVAILABLE" = true ]; then
    ensure_directory "$CONFIG_HOME" "the per-user configuration directory"
    ensure_directory "$CONFIG_HOME/systemd" "the systemd configuration directory"
    ensure_directory "$SYSTEMD_DIRECTORY" "the systemd user unit directory"
    UNIT_STAGING=$(mktemp "$SYSTEMD_DIRECTORY/.multivibe-host.service.XXXXXX") || fail "the systemd user unit could not be staged"
    cat > "$UNIT_STAGING" <<'EOF'
# Managed by the MultiVibe Host installer
[Unit]
Description=MultiVibe Host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/lib/multivibe-host/bin/multivibe-host run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
    chmod 0600 "$UNIT_STAGING"
    if [ -e "$UNIT_FILE" ]; then
      UNIT_BACKUP="$SYSTEMD_DIRECTORY/.multivibe-host.service.previous.$$"
      [ ! -e "$UNIT_BACKUP" ] && [ ! -L "$UNIT_BACKUP" ] || fail "the service rollback destination already exists"
      mv "$UNIT_FILE" "$UNIT_BACKUP"
      UNIT_CHANGED=true
    fi
    mv "$UNIT_STAGING" "$UNIT_FILE"
    UNIT_STAGING=""
    UNIT_CHANGED=true

    UPDATE_SERVICE_STAGING=$(mktemp "$SYSTEMD_DIRECTORY/.multivibe-host-update.service.XXXXXX") || fail "the update service could not be staged"
    cat > "$UPDATE_SERVICE_STAGING" <<EOF
# Managed by the MultiVibe Host installer
[Unit]
Description=Check and install verified MultiVibe Host updates
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart="$INSTALL_ROOT/bin/multivibe-host-updater" auto
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$LIBRARY_DIRECTORY" "$BIN_DIRECTORY" "$DATA_DIRECTORY" "$SYSTEMD_DIRECTORY"
TimeoutStartSec=45min
EOF
    chmod 0600 "$UPDATE_SERVICE_STAGING"
    if [ -e "$UPDATE_SERVICE_FILE" ]; then
      UPDATE_SERVICE_BACKUP="$SYSTEMD_DIRECTORY/.multivibe-host-update.service.previous.$$"
      [ ! -e "$UPDATE_SERVICE_BACKUP" ] && [ ! -L "$UPDATE_SERVICE_BACKUP" ] || fail "the update service rollback destination already exists"
      mv "$UPDATE_SERVICE_FILE" "$UPDATE_SERVICE_BACKUP"
      UPDATE_SERVICE_CHANGED=true
    fi
    mv "$UPDATE_SERVICE_STAGING" "$UPDATE_SERVICE_FILE"
    UPDATE_SERVICE_STAGING=""
    UPDATE_SERVICE_CHANGED=true

    UPDATE_TIMER_STAGING=$(mktemp "$SYSTEMD_DIRECTORY/.multivibe-host-update.timer.XXXXXX") || fail "the update timer could not be staged"
    cat > "$UPDATE_TIMER_STAGING" <<'EOF'
# Managed by the MultiVibe Host installer
[Unit]
Description=Schedule verified MultiVibe Host update checks

[Timer]
OnBootSec=5m
OnUnitActiveSec=1h
RandomizedDelaySec=20m
Persistent=true
Unit=multivibe-host-update.service

[Install]
WantedBy=timers.target
EOF
    chmod 0600 "$UPDATE_TIMER_STAGING"
    if [ -e "$UPDATE_TIMER_FILE" ]; then
      UPDATE_TIMER_BACKUP="$SYSTEMD_DIRECTORY/.multivibe-host-update.timer.previous.$$"
      [ ! -e "$UPDATE_TIMER_BACKUP" ] && [ ! -L "$UPDATE_TIMER_BACKUP" ] || fail "the update timer rollback destination already exists"
      mv "$UPDATE_TIMER_FILE" "$UPDATE_TIMER_BACKUP"
      UPDATE_TIMER_CHANGED=true
    fi
    mv "$UPDATE_TIMER_STAGING" "$UPDATE_TIMER_FILE"
    UPDATE_TIMER_STAGING=""
    UPDATE_TIMER_CHANGED=true

    systemctl --user daemon-reload || fail "the systemd user manager could not reload its units"
    systemctl --user enable --now "$SERVICE_NAME" || fail "the MultiVibe Host user service could not be started"
    systemctl --user enable --now "$UPDATE_TIMER_NAME" || fail "the MultiVibe Host update timer could not be started"
    systemctl --user is-active --quiet "$SERVICE_NAME" || fail "the MultiVibe Host user service did not remain active"
    systemctl --user is-active --quiet "$UPDATE_TIMER_NAME" || fail "the MultiVibe Host update timer did not remain active"
  fi
fi

version=$("$INSTALL_ROOT/bin/multivibe-host" version)
if [ "$SYSTEMD_AVAILABLE" = true ] && [ "$MODE" = service ]; then
  health_attempt=0
  health_ready=false
  while [ "$health_attempt" -lt 60 ]; do
    if "$INSTALL_ROOT/bin/node" --eval "fetch('http://127.0.0.1:'+(process.env.MULTIVIBE_HOST_PORT||'1455')+'/health').then(async response=>{const body=await response.json();if(!response.ok||body.version!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))" "$version" >/dev/null 2>&1; then
      health_ready=true
      break
    fi
    health_attempt=$((health_attempt + 1))
    sleep 2
  done
  [ "$health_ready" = true ] || fail "the updated MultiVibe Host did not pass its post-start health check"
fi
INSTALL_SUCCEEDED=true
printf 'MultiVibe Host %s is installed in %s\n' "$version" "$INSTALL_ROOT"

if [ "$MODE" = foreground ]; then
  printf 'Starting MultiVibe Host in the foreground. Press Ctrl-C to stop it.\n'
  if [ -n "$BACKUP_DIRECTORY" ] && [ -d "$BACKUP_DIRECTORY" ]; then
    rm -rf "$BACKUP_DIRECTORY"
  fi
  if [ -n "$LAUNCHER_BACKUP" ] && [ -f "$LAUNCHER_BACKUP" ]; then
    rm -f "$LAUNCHER_BACKUP"
  fi
  if [ -n "$UNIT_BACKUP" ] && [ -f "$UNIT_BACKUP" ]; then
    rm -f "$UNIT_BACKUP"
  fi
  trap - 0 HUP INT TERM
  exec "$INSTALL_ROOT/bin/multivibe-host" run
elif [ "$SYSTEMD_AVAILABLE" = true ]; then
  printf 'The systemd user service and verified update timer are enabled and running.\n'
else
  printf 'No systemd user manager is available; the application was installed but not started.\n'
  printf 'Run %s run, or rerun this installer with --foreground.\n' "$LAUNCHER"
fi
