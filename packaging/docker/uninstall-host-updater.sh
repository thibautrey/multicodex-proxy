#!/bin/sh

set -eu

PROGRAM_NAME="MultiVibe Host Docker updater uninstaller"

SERVICE_MARKER="# Managed by the MultiVibe Host Docker updater installer"
SERVICE_NAME="multivibe-host-docker-update.service"
TIMER_NAME="multivibe-host-docker-update.timer"
SYSTEMD_DIRECTORY="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
INSTALL_DIRECTORY="$HOME/.local/lib/multivibe-host-docker-updater"
UPDATER="$INSTALL_DIRECTORY/multivibe-host-updater"
MANAGED_MARKER="$INSTALL_DIRECTORY/managed-by-multivibe-host-updater"
SERVICE_FILE="$SYSTEMD_DIRECTORY/$SERVICE_NAME"
TIMER_FILE="$SYSTEMD_DIRECTORY/$TIMER_NAME"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

case "${HOME:-}" in
  /*) ;;
  *) fail "HOME must be an absolute path" ;;
esac
case "$HOME" in
  /|*'/../'*|*/..|*'/./'*|*/.|*[![:print:]]*) fail "HOME must be a clean non-root path" ;;
esac

for unit in "$SERVICE_FILE" "$TIMER_FILE"; do
  if [ -e "$unit" ] || [ -L "$unit" ]; then
    [ -f "$unit" ] && [ ! -L "$unit" ] && IFS= read -r marker < "$unit" && [ "$marker" = "$SERVICE_MARKER" ] || {
      printf 'MultiVibe Host Docker updater uninstaller: %s is not managed by MultiVibe\n' "$unit" >&2
      exit 1
    }
  fi
done
systemctl --user disable --now "$TIMER_NAME" >/dev/null 2>&1 || true
rm -f "$SERVICE_FILE" "$TIMER_FILE"
systemctl --user daemon-reload >/dev/null 2>&1 || true
if [ -e "$INSTALL_DIRECTORY" ] || [ -L "$INSTALL_DIRECTORY" ]; then
  [ -d "$INSTALL_DIRECTORY" ] && [ ! -L "$INSTALL_DIRECTORY" ] || fail "the updater installation directory is unsafe"
  [ -f "$MANAGED_MARKER" ] && [ ! -L "$MANAGED_MARKER" ] && IFS= read -r marker < "$MANAGED_MARKER" && [ "$marker" = "$SERVICE_MARKER" ] || fail "the updater installation is not managed by MultiVibe"
  [ ! -e "$UPDATER" ] || { [ -f "$UPDATER" ] && [ ! -L "$UPDATER" ] || fail "the updater binary is unsafe"; }
  rm -f "$UPDATER" "$MANAGED_MARKER"
  rmdir "$INSTALL_DIRECTORY" || fail "the updater installation contains unexpected files"
fi
printf 'The MultiVibe Host Docker update timer was removed. Container data and images were preserved.\n'
