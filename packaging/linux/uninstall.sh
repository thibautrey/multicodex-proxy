#!/bin/sh

set -eu

PROGRAM_NAME="MultiVibe Host uninstaller"
SERVICE_NAME="multivibe-host.service"
SERVICE_MARKER="# Managed by the MultiVibe Host installer"
LAUNCHER_MARKER="# Managed by the MultiVibe Host installer"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [--purge]

Remove the per-user MultiVibe Host application and managed service files.
Application data and local credentials are preserved unless --purge is given.
Stop a foreground MultiVibe Host process with Ctrl-C before uninstalling it.
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

PURGE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge) PURGE=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || fail "this uninstaller supports Linux only"
[ -n "${HOME:-}" ] || fail "HOME is unavailable"
validate_absolute_path "$HOME" "HOME"

LOCAL_ROOT="$HOME/.local"
INSTALL_ROOT="$LOCAL_ROOT/lib/multivibe-host"
LAUNCHER="$LOCAL_ROOT/bin/multivibe-host"
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
validate_absolute_path "$CONFIG_HOME" "XDG_CONFIG_HOME"
UNIT_FILE="$CONFIG_HOME/systemd/user/$SERVICE_NAME"
DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
validate_absolute_path "$DATA_HOME" "XDG_DATA_HOME"
DATA_DIRECTORY="$DATA_HOME/multivibe"

for managed_parent in "$LOCAL_ROOT" "$LOCAL_ROOT/lib" "$LOCAL_ROOT/bin" "$CONFIG_HOME" "$CONFIG_HOME/systemd" "$CONFIG_HOME/systemd/user"; do
  if [ -L "$managed_parent" ]; then
    fail "a managed installation path contains a symbolic link"
  fi
  if [ -e "$managed_parent" ] && [ ! -d "$managed_parent" ]; then
    fail "a managed installation path contains a non-directory entry"
  fi
done

if [ -L "$INSTALL_ROOT" ]; then
  fail "the installation destination is a symbolic link; refusing to remove it"
fi
if [ -e "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] || fail "the installation destination is not a directory"
  [ -f "$INSTALL_ROOT/manifest.json" ] && [ ! -L "$INSTALL_ROOT/manifest.json" ] || fail "the installation is not managed by MultiVibe Host"
  [ -x "$INSTALL_ROOT/bin/node" ] && [ -f "$INSTALL_ROOT/verify-provider-host.mjs" ] || fail "the installation is not managed by MultiVibe Host"
  "$INSTALL_ROOT/bin/node" "$INSTALL_ROOT/verify-provider-host.mjs" --directory "$INSTALL_ROOT" >/dev/null || fail "the installation failed integrity verification; refusing automatic removal"
fi

if [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
  is_managed_launcher "$LAUNCHER" || fail "$LAUNCHER is not managed by MultiVibe Host"
fi
if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then
  is_managed_file "$UNIT_FILE" "$SERVICE_MARKER" || fail "$UNIT_FILE is not managed by MultiVibe Host"
fi
if [ "$PURGE" = true ]; then
  if [ -L "$DATA_HOME" ]; then
    fail "the application data parent is a symbolic link; refusing to purge it"
  fi
  if [ -L "$DATA_DIRECTORY" ]; then
    fail "the application data destination is a symbolic link; refusing to purge it"
  fi
  if [ -e "$DATA_DIRECTORY" ] && [ ! -d "$DATA_DIRECTORY" ]; then
    fail "the application data destination is not a directory"
  fi
fi

SYSTEMD_AVAILABLE=false
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  SYSTEMD_AVAILABLE=true
fi

if [ -e "$UNIT_FILE" ]; then
  if [ "$SYSTEMD_AVAILABLE" = true ]; then
    systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  rm -f "$UNIT_FILE"
  if [ "$SYSTEMD_AVAILABLE" = true ]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
fi

if [ -e "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
fi
if [ -d "$INSTALL_ROOT" ]; then
  rm -rf "$INSTALL_ROOT"
fi

if [ "$PURGE" = true ]; then
  if [ -d "$DATA_DIRECTORY" ]; then
    rm -rf "$DATA_DIRECTORY"
  fi
  printf 'MultiVibe Host and its default application data were removed.\n'
else
  printf 'MultiVibe Host was removed. Application data was preserved in %s\n' "$DATA_DIRECTORY"
fi
