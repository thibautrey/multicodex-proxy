#!/bin/sh

set -eu

PROGRAM_NAME="MultiVibe Host uninstaller"
LABEL="cloud.multivibe.host"
UPDATE_LABEL="cloud.multivibe.host.update"
BUNDLE_IDENTIFIER="cloud.multivibe.host"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [--purge]

Remove the per-user MultiVibe Host application and LaunchAgent. Application
data, local credentials and logs are preserved unless --purge is given.
EOF
}

validate_home() {
  case "$HOME" in
    /Users/*) ;;
    *) fail "HOME must be an absolute macOS user directory" ;;
  esac
  case "$HOME" in
    *'/../'*|*/..|*'/./'*|*/.|*[![:print:]]*|*'&'*|*'<'*|*'>'*|*'"'*|*"'"*) fail "HOME is not a clean LaunchAgent-safe path" ;;
  esac
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

PURGE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge) PURGE=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || fail "this uninstaller supports macOS only"
[ -n "${HOME:-}" ] || fail "HOME is unavailable"
validate_home

DESTINATION_APPLICATION="$HOME/Applications/MultiVibe Host.app"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
UPDATE_LAUNCH_AGENT="$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist"
DATA_DIRECTORY="$HOME/Library/Application Support/MultiVibe"
LOG_DIRECTORY="$HOME/Library/Logs/MultiVibe Host"
USER_ID=$(id -u)
case "$USER_ID" in
  ''|*[!0-9]*) fail "the current user identifier is invalid" ;;
esac
SERVICE="gui/$USER_ID/$LABEL"
UPDATE_SERVICE="gui/$USER_ID/$UPDATE_LABEL"
MANAGED_INSTALL_PRESENT=false

for managed_parent in "$HOME/Applications" "$HOME/Library" "$HOME/Library/LaunchAgents"; do
  if [ -L "$managed_parent" ]; then
    fail "a managed installation path contains a symbolic link"
  fi
  if [ -e "$managed_parent" ] && [ ! -d "$managed_parent" ]; then
    fail "a managed installation path contains a non-directory entry"
  fi
done

if [ -L "$DESTINATION_APPLICATION" ]; then
  fail "the application destination is a symbolic link; refusing to remove it"
fi
if [ -e "$DESTINATION_APPLICATION" ]; then
  [ -d "$DESTINATION_APPLICATION" ] || fail "the application destination is not a bundle"
  [ "$(plist_value "$DESTINATION_APPLICATION/Contents/Info.plist" CFBundleIdentifier)" = "$BUNDLE_IDENTIFIER" ] || fail "the application is not managed by MultiVibe Host"
  /usr/bin/codesign --verify --deep --strict "$DESTINATION_APPLICATION" >/dev/null 2>&1 || fail "the application signature is invalid; refusing automatic removal"
  MANAGED_INSTALL_PRESENT=true
fi

if [ -L "$LAUNCH_AGENT" ]; then
  fail "the LaunchAgent destination is a symbolic link; refusing to remove it"
fi
if [ -e "$LAUNCH_AGENT" ]; then
  [ -f "$LAUNCH_AGENT" ] || fail "the LaunchAgent destination is not a regular file"
  [ "$(plist_value "$LAUNCH_AGENT" Label)" = "$LABEL" ] || fail "the LaunchAgent is not managed by MultiVibe Host"
  [ "$(plist_value "$LAUNCH_AGENT" ProgramArguments:0)" = "$DESTINATION_APPLICATION/Contents/MacOS/multivibe-host" ] || fail "the LaunchAgent targets another application"
  MANAGED_INSTALL_PRESENT=true
fi
if [ -L "$UPDATE_LAUNCH_AGENT" ]; then
  fail "the update LaunchAgent destination is a symbolic link; refusing to remove it"
fi
if [ -e "$UPDATE_LAUNCH_AGENT" ]; then
  [ -f "$UPDATE_LAUNCH_AGENT" ] || fail "the update LaunchAgent destination is not a regular file"
  [ "$(plist_value "$UPDATE_LAUNCH_AGENT" Label)" = "$UPDATE_LABEL" ] || fail "the update LaunchAgent is not managed by MultiVibe Host"
  [ "$(plist_value "$UPDATE_LAUNCH_AGENT" ProgramArguments:0)" = "$DESTINATION_APPLICATION/Contents/Helpers/multivibe-host-updater" ] || fail "the update LaunchAgent targets another application"
  MANAGED_INSTALL_PRESENT=true
fi
if [ "$PURGE" = true ]; then
  for data_parent in "$HOME/Library/Application Support" "$HOME/Library/Logs"; do
    if [ -L "$data_parent" ]; then
      fail "a purge parent is a symbolic link; refusing to remove data"
    fi
    if [ -e "$data_parent" ] && [ ! -d "$data_parent" ]; then
      fail "a purge parent is not a directory"
    fi
  done
  for directory in "$DATA_DIRECTORY" "$LOG_DIRECTORY"; do
    if [ -L "$directory" ]; then
      fail "a purge destination is a symbolic link; refusing to remove it"
    fi
    if [ -e "$directory" ] && [ ! -d "$directory" ]; then
      fail "a purge destination is not a directory"
    fi
  done
fi

if [ "$MANAGED_INSTALL_PRESENT" = true ]; then
  /bin/launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
  /bin/launchctl bootout "$UPDATE_SERVICE" >/dev/null 2>&1 || true
fi
if [ -f "$LAUNCH_AGENT" ]; then
  rm -f "$LAUNCH_AGENT"
fi
if [ -f "$UPDATE_LAUNCH_AGENT" ]; then
  rm -f "$UPDATE_LAUNCH_AGENT"
fi
if [ -d "$DESTINATION_APPLICATION" ]; then
  rm -rf "$DESTINATION_APPLICATION"
fi

if [ "$PURGE" = true ]; then
  if [ -d "$DATA_DIRECTORY" ]; then
    rm -rf "$DATA_DIRECTORY"
  fi
  if [ -d "$LOG_DIRECTORY" ]; then
    rm -rf "$LOG_DIRECTORY"
  fi
  printf 'MultiVibe Host, its application data and its logs were removed.\n'
else
  printf 'MultiVibe Host was removed. Application data was preserved in %s\n' "$DATA_DIRECTORY"
fi
