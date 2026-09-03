#!/bin/sh

set -eu
umask 077

PROGRAM_NAME="MultiVibe Host Docker updater installer"
SERVICE_MARKER="# Managed by the MultiVibe Host Docker updater installer"
SERVICE_NAME="multivibe-host-docker-update.service"
TIMER_NAME="multivibe-host-docker-update.timer"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install-docker-updater.sh --compose-file /absolute/path/docker-compose.host.yml --project-directory /absolute/path

Install a per-user systemd timer that pulls only the signed digest published by
MultiVibe, recreates the multivibe-host service, waits for its health check and
restores the previous image reference if the update fails.
EOF
}

validate_absolute() {
  case "$1" in
    /*) ;;
    *) fail "$2 must be an absolute path" ;;
  esac
  case "$1" in
    /|*'/../'*|*/..|*'/./'*|*/.|*[![:print:]]*) fail "$2 must be canonical" ;;
  esac
}

COMPOSE_FILE=""
PROJECT_DIRECTORY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --compose-file) shift; [ "$#" -gt 0 ] || fail "--compose-file requires a value"; COMPOSE_FILE=$1 ;;
    --project-directory) shift; [ "$#" -gt 0 ] || fail "--project-directory requires a value"; PROJECT_DIRECTORY=$1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail "this installer requires Linux amd64"
[ -n "${HOME:-}" ] || fail "HOME is unavailable"
validate_absolute "$HOME" "HOME"
[ -n "$COMPOSE_FILE" ] && [ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail "a regular Compose file is required"
[ -n "$PROJECT_DIRECTORY" ] && [ -d "$PROJECT_DIRECTORY" ] && [ ! -L "$PROJECT_DIRECTORY" ] || fail "a regular project directory is required"
validate_absolute "$COMPOSE_FILE" "the Compose file"
validate_absolute "$PROJECT_DIRECTORY" "the project directory"
command -v docker >/dev/null 2>&1 || fail "docker is unavailable"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"
systemctl --user show-environment >/dev/null 2>&1 || fail "a systemd user manager is required"

SCRIPT_DIRECTORY=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || fail "the release directory is unavailable"
SOURCE_UPDATER="$SCRIPT_DIRECTORY/bin/multivibe-host-updater"
[ -f "$SOURCE_UPDATER" ] && [ ! -L "$SOURCE_UPDATER" ] && [ -x "$SOURCE_UPDATER" ] || fail "the verified Host updater binary is unavailable"

INSTALL_DIRECTORY="$HOME/.local/lib/multivibe-host-docker-updater"
SYSTEMD_DIRECTORY="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DATA_DIRECTORY="${XDG_DATA_HOME:-$HOME/.local/share}/multivibe-docker-updater"
MANAGED_MARKER="$INSTALL_DIRECTORY/managed-by-multivibe-host-updater"
SERVICE_FILE="$SYSTEMD_DIRECTORY/$SERVICE_NAME"
TIMER_FILE="$SYSTEMD_DIRECTORY/$TIMER_NAME"
validate_absolute "$SYSTEMD_DIRECTORY" "the systemd user directory"
validate_absolute "$DATA_DIRECTORY" "the updater data directory"
for directory in "$HOME/.local" "$HOME/.local/lib" "$INSTALL_DIRECTORY" "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_CONFIG_HOME:-$HOME/.config}/systemd" "$SYSTEMD_DIRECTORY" "$DATA_DIRECTORY"; do
  [ ! -L "$directory" ] || fail "a managed updater path is a symbolic link"
  [ ! -e "$directory" ] || [ -d "$directory" ] || fail "a managed updater path is not a directory"
  mkdir -p "$directory"
done
chmod 0700 "$INSTALL_DIRECTORY" "$DATA_DIRECTORY"
if [ -e "$MANAGED_MARKER" ] || [ -L "$MANAGED_MARKER" ]; then
  [ -f "$MANAGED_MARKER" ] && [ ! -L "$MANAGED_MARKER" ] && IFS= read -r marker < "$MANAGED_MARKER" && [ "$marker" = "$SERVICE_MARKER" ] || fail "the Docker updater installation is not managed by MultiVibe"
else
  [ -z "$(ls -A "$INSTALL_DIRECTORY")" ] || fail "the existing Docker updater installation is not managed by MultiVibe"
  printf '%s\n' "$SERVICE_MARKER" > "$MANAGED_MARKER"
  chmod 0400 "$MANAGED_MARKER"
fi
for unit in "$SERVICE_FILE" "$TIMER_FILE"; do
  if [ -e "$unit" ] || [ -L "$unit" ]; then
    [ -f "$unit" ] && [ ! -L "$unit" ] && IFS= read -r marker < "$unit" && [ "$marker" = "$SERVICE_MARKER" ] || fail "$unit is not managed by MultiVibe"
  fi
done

UPDATER="$INSTALL_DIRECTORY/multivibe-host-updater"
STAGED_UPDATER=$(mktemp "$INSTALL_DIRECTORY/.updater.XXXXXX") || fail "the updater could not be staged"
cp "$SOURCE_UPDATER" "$STAGED_UPDATER"
chmod 0555 "$STAGED_UPDATER"
mv "$STAGED_UPDATER" "$UPDATER"

MULTIVIBE_HOST_DATA_DIR="$DATA_DIRECTORY" "$UPDATER" docker-configure --compose-file "$COMPOSE_FILE" --project-directory "$PROJECT_DIRECTORY" >/dev/null || fail "the Docker updater configuration was rejected"

SERVICE_STAGING=$(mktemp "$SYSTEMD_DIRECTORY/.multivibe-host-docker-update.service.XXXXXX") || fail "the updater service could not be staged"
cat > "$SERVICE_STAGING" <<EOF
$SERVICE_MARKER
[Unit]
Description=Install verified MultiVibe Host container updates
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment="MULTIVIBE_HOST_DATA_DIR=$DATA_DIRECTORY"
ExecStart="$UPDATER" docker-auto
NoNewPrivileges=true
PrivateTmp=true
TimeoutStartSec=45min
EOF
chmod 0600 "$SERVICE_STAGING"
mv "$SERVICE_STAGING" "$SERVICE_FILE"

TIMER_STAGING=$(mktemp "$SYSTEMD_DIRECTORY/.multivibe-host-docker-update.timer.XXXXXX") || fail "the updater timer could not be staged"
cat > "$TIMER_STAGING" <<EOF
$SERVICE_MARKER
[Unit]
Description=Schedule verified MultiVibe Host container updates

[Timer]
OnBootSec=5m
OnUnitActiveSec=1h
RandomizedDelaySec=20m
Persistent=true
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF
chmod 0600 "$TIMER_STAGING"
mv "$TIMER_STAGING" "$TIMER_FILE"
systemctl --user daemon-reload || fail "the systemd user manager could not reload"
systemctl --user enable --now "$TIMER_NAME" || fail "the Docker update timer could not be enabled"
systemctl --user is-active --quiet "$TIMER_NAME" || fail "the Docker update timer is not active"
printf 'Verified MultiVibe Host Docker updates are enabled through %s\n' "$TIMER_NAME"
