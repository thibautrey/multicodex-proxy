#!/bin/sh

set -eu
umask 077

PROGRAM_NAME="MultiVibe Host installer"
LABEL="cloud.multivibe.host"
UPDATE_LABEL="cloud.multivibe.host.update"
BUNDLE_IDENTIFIER="cloud.multivibe.host"
EXPECTED_TEAM_IDENTIFIER="5E2CNR9H47"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [--automatic-update] [--source-application /absolute/path]

Install the signed MultiVibe Host application and LaunchAgent for the current
macOS user. No administrator privileges are required.
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

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

verify_signed_application() {
  application=$1
  description=$2
  /usr/bin/codesign --verify --deep --strict "$application" || fail "$description signature is invalid"
  team_identifier=$(/usr/bin/codesign --display --verbose=4 "$application" 2>&1 | /usr/bin/sed -n 's/^TeamIdentifier=//p') ||
    fail "$description signing identity is unavailable"
  [ "$team_identifier" = "$EXPECTED_TEAM_IDENTIFIER" ] || fail "$description signing team is invalid"
  /usr/sbin/spctl --assess --type execute "$application" || fail "$description Gatekeeper assessment failed"
  /usr/bin/xcrun stapler validate "$application" || fail "$description notarization ticket is invalid"
}

AUTOMATIC_UPDATE=false
SOURCE_APPLICATION_OVERRIDE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --automatic-update) AUTOMATIC_UPDATE=true ;;
    --source-application)
      shift
      [ "$#" -gt 0 ] || fail "--source-application requires a value"
      SOURCE_APPLICATION_OVERRIDE=$1
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || fail "this installer supports macOS only"
case "$(uname -m)" in
  arm64|x86_64) ;;
  *) fail "this installer supports Apple Silicon and Intel Macs only" ;;
esac
[ -n "${HOME:-}" ] || fail "HOME is unavailable"
validate_home

SCRIPT_DIRECTORY=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || fail "the release directory is unavailable"
SOURCE_ROOT=$SCRIPT_DIRECTORY
SOURCE_APPLICATION="$SCRIPT_DIRECTORY/MultiVibe Host.app"
if [ -n "$SOURCE_APPLICATION_OVERRIDE" ]; then
  case "$SOURCE_APPLICATION_OVERRIDE" in
    /*) ;;
    *) fail "the source application must be an absolute path" ;;
  esac
  [ "$(basename "$SOURCE_APPLICATION_OVERRIDE")" = "MultiVibe Host.app" ] || fail "the source application name is invalid"
  SOURCE_APPLICATION=$SOURCE_APPLICATION_OVERRIDE
  SOURCE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$SOURCE_APPLICATION")" && pwd -P) || fail "the source application directory is unavailable"
fi
SOURCE_HOST="$SOURCE_APPLICATION/Contents/MacOS/multivibe-host"
SOURCE_UPDATER="$SOURCE_APPLICATION/Contents/Helpers/multivibe-host-updater"
SOURCE_NODE="$SOURCE_APPLICATION/Contents/Frameworks/node"
SOURCE_VERIFIER="$SOURCE_APPLICATION/Contents/Resources/verify-provider-host.mjs"
[ -d "$SOURCE_APPLICATION" ] && [ ! -L "$SOURCE_APPLICATION" ] || fail "the extracted application bundle is unavailable"
for executable in "$SOURCE_HOST" "$SOURCE_UPDATER" "$SOURCE_NODE"; do
  [ -f "$executable" ] && [ ! -L "$executable" ] && [ -x "$executable" ] || fail "the extracted application bundle is incomplete"
done
[ -f "$SOURCE_VERIFIER" ] && [ ! -L "$SOURCE_VERIFIER" ] || fail "the signed release verifier is unavailable"
[ "$(plist_value "$SOURCE_APPLICATION/Contents/Info.plist" CFBundleIdentifier)" = "$BUNDLE_IDENTIFIER" ] || fail "the application bundle identifier is invalid"

verify_signed_application "$SOURCE_APPLICATION" "the application"
printf 'Checking the signed release bundle and this Mac...\n'
if [ -z "$SOURCE_APPLICATION_OVERRIDE" ]; then
  "$SOURCE_NODE" "$SOURCE_VERIFIER" --directory "$SOURCE_ROOT" --require-runtime || fail "the signed release verifier rejected the bundle or this host"
else
  "$SOURCE_HOST" doctor >/dev/null || fail "the signed update application failed doctor"
fi

APPLICATIONS_DIRECTORY="$HOME/Applications"
DESTINATION_APPLICATION="$APPLICATIONS_DIRECTORY/MultiVibe Host.app"
LAUNCH_AGENTS_DIRECTORY="$HOME/Library/LaunchAgents"
LAUNCH_AGENT="$LAUNCH_AGENTS_DIRECTORY/$LABEL.plist"
UPDATE_LAUNCH_AGENT="$LAUNCH_AGENTS_DIRECTORY/$UPDATE_LABEL.plist"
LOG_DIRECTORY="$HOME/Library/Logs/MultiVibe Host"
USER_ID=$(id -u)
case "$USER_ID" in
  ''|*[!0-9]*) fail "the current user identifier is invalid" ;;
esac
DOMAIN="gui/$USER_ID"
SERVICE="$DOMAIN/$LABEL"
UPDATE_SERVICE="$DOMAIN/$UPDATE_LABEL"

ensure_directory "$APPLICATIONS_DIRECTORY" "the per-user Applications directory"
ensure_directory "$HOME/Library" "the per-user Library directory"
ensure_directory "$LAUNCH_AGENTS_DIRECTORY" "the LaunchAgents directory"
ensure_directory "$HOME/Library/Logs" "the per-user Logs directory"
ensure_directory "$LOG_DIRECTORY" "the MultiVibe Host log directory"

if [ -L "$DESTINATION_APPLICATION" ]; then
  fail "the application destination must not be a symbolic link"
fi
if [ -e "$DESTINATION_APPLICATION" ]; then
  [ -d "$DESTINATION_APPLICATION" ] || fail "the application destination is not a bundle"
  [ "$(plist_value "$DESTINATION_APPLICATION/Contents/Info.plist" CFBundleIdentifier)" = "$BUNDLE_IDENTIFIER" ] || fail "the existing application is not managed by MultiVibe Host"
  verify_signed_application "$DESTINATION_APPLICATION" "the existing application"
fi

if [ -L "$LAUNCH_AGENT" ]; then
  fail "the LaunchAgent destination must not be a symbolic link"
fi
if [ -L "$UPDATE_LAUNCH_AGENT" ]; then
  fail "the update LaunchAgent destination must not be a symbolic link"
fi
if [ -e "$UPDATE_LAUNCH_AGENT" ]; then
  [ -f "$UPDATE_LAUNCH_AGENT" ] || fail "the update LaunchAgent destination is not a regular file"
  [ "$(plist_value "$UPDATE_LAUNCH_AGENT" Label)" = "$UPDATE_LABEL" ] || fail "the existing update LaunchAgent is not managed by MultiVibe Host"
fi
if [ -e "$LAUNCH_AGENT" ]; then
  [ -f "$LAUNCH_AGENT" ] || fail "the LaunchAgent destination is not a regular file"
  [ "$(plist_value "$LAUNCH_AGENT" Label)" = "$LABEL" ] || fail "the existing LaunchAgent is not managed by MultiVibe Host"
  [ "$(plist_value "$LAUNCH_AGENT" ProgramArguments:0)" = "$DESTINATION_APPLICATION/Contents/MacOS/multivibe-host" ] || fail "the existing LaunchAgent targets another application"
fi

STAGING_DIRECTORY=$(mktemp -d "$APPLICATIONS_DIRECTORY/.multivibe-host.install.XXXXXX") || fail "the application staging directory could not be created"
STAGED_APPLICATION="$STAGING_DIRECTORY/MultiVibe Host.app"
if ! STAGED_LAUNCH_AGENT=$(mktemp "$LAUNCH_AGENTS_DIRECTORY/.cloud.multivibe.host.plist.XXXXXX"); then
  rm -rf "$STAGING_DIRECTORY"
  fail "the LaunchAgent could not be staged"
fi
if ! STAGED_UPDATE_LAUNCH_AGENT=$(mktemp "$LAUNCH_AGENTS_DIRECTORY/.cloud.multivibe.host.update.plist.XXXXXX"); then
  rm -rf "$STAGING_DIRECTORY"
  rm -f "$STAGED_LAUNCH_AGENT"
  fail "the update LaunchAgent could not be staged"
fi
BACKUP_APPLICATION=""
BACKUP_LAUNCH_AGENT=""
BACKUP_UPDATE_LAUNCH_AGENT=""
APPLICATION_COMMITTED=false
LAUNCH_AGENT_COMMITTED=false
UPDATE_LAUNCH_AGENT_COMMITTED=false
SERVICE_WAS_LOADED=false
UPDATE_SERVICE_WAS_LOADED=false
UPDATE_SERVICE_KEPT_LOADED=false
INSTALL_SUCCEEDED=false

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "$INSTALL_SUCCEEDED" != true ]; then
    if [ "$UPDATE_LAUNCH_AGENT_COMMITTED" = true ]; then
      if [ "$UPDATE_SERVICE_KEPT_LOADED" != true ]; then
        /bin/launchctl bootout "$UPDATE_SERVICE" >/dev/null 2>&1 || true
      fi
      rm -f "$UPDATE_LAUNCH_AGENT"
    fi
    if [ -n "$BACKUP_UPDATE_LAUNCH_AGENT" ] && [ -f "$BACKUP_UPDATE_LAUNCH_AGENT" ]; then
      mv "$BACKUP_UPDATE_LAUNCH_AGENT" "$UPDATE_LAUNCH_AGENT" || true
      BACKUP_UPDATE_LAUNCH_AGENT=""
    fi
    if [ "$LAUNCH_AGENT_COMMITTED" = true ]; then
      /bin/launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
      rm -f "$LAUNCH_AGENT"
    fi
    if [ -n "$BACKUP_LAUNCH_AGENT" ] && [ -f "$BACKUP_LAUNCH_AGENT" ]; then
      mv "$BACKUP_LAUNCH_AGENT" "$LAUNCH_AGENT" || true
      BACKUP_LAUNCH_AGENT=""
    fi
    if [ "$APPLICATION_COMMITTED" = true ]; then
      rm -rf "$DESTINATION_APPLICATION"
    fi
    if [ -n "$BACKUP_APPLICATION" ] && [ -d "$BACKUP_APPLICATION" ]; then
      mv "$BACKUP_APPLICATION" "$DESTINATION_APPLICATION" || true
      BACKUP_APPLICATION=""
    fi
    if [ "$SERVICE_WAS_LOADED" = true ] && [ -f "$LAUNCH_AGENT" ]; then
      /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
    fi
    if [ "$UPDATE_SERVICE_WAS_LOADED" = true ] && [ "$UPDATE_SERVICE_KEPT_LOADED" != true ] && [ -f "$UPDATE_LAUNCH_AGENT" ]; then
      /bin/launchctl bootstrap "$DOMAIN" "$UPDATE_LAUNCH_AGENT" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$STAGING_DIRECTORY" ] && [ -d "$STAGING_DIRECTORY" ]; then
    rm -rf "$STAGING_DIRECTORY"
  fi
  if [ -n "${STAGED_LAUNCH_AGENT:-}" ] && [ -f "$STAGED_LAUNCH_AGENT" ]; then
    rm -f "$STAGED_LAUNCH_AGENT"
  fi
  if [ -n "${STAGED_UPDATE_LAUNCH_AGENT:-}" ] && [ -f "$STAGED_UPDATE_LAUNCH_AGENT" ]; then
    rm -f "$STAGED_UPDATE_LAUNCH_AGENT"
  fi
  if [ -n "$BACKUP_APPLICATION" ] && [ -d "$BACKUP_APPLICATION" ]; then
    rm -rf "$BACKUP_APPLICATION"
  fi
  if [ -n "$BACKUP_LAUNCH_AGENT" ] && [ -f "$BACKUP_LAUNCH_AGENT" ]; then
    rm -f "$BACKUP_LAUNCH_AGENT"
  fi
  if [ -n "$BACKUP_UPDATE_LAUNCH_AGENT" ] && [ -f "$BACKUP_UPDATE_LAUNCH_AGENT" ]; then
    rm -f "$BACKUP_UPDATE_LAUNCH_AGENT"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/ditto "$SOURCE_APPLICATION" "$STAGED_APPLICATION"
verify_signed_application "$STAGED_APPLICATION" "the staged application"
"$STAGED_APPLICATION/Contents/MacOS/multivibe-host" doctor >/dev/null || fail "the staged application failed doctor"

cat > "$STAGED_LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DESTINATION_APPLICATION/Contents/MacOS/multivibe-host</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIRECTORY/host.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIRECTORY/host-error.log</string>
</dict>
</plist>
EOF
chmod 0600 "$STAGED_LAUNCH_AGENT"
/usr/bin/plutil -lint "$STAGED_LAUNCH_AGENT" >/dev/null || fail "the staged LaunchAgent is invalid"

cat > "$STAGED_UPDATE_LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$UPDATE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DESTINATION_APPLICATION/Contents/Helpers/multivibe-host-updater</string>
    <string>auto</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIRECTORY/update.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIRECTORY/update-error.log</string>
</dict>
</plist>
EOF
chmod 0600 "$STAGED_UPDATE_LAUNCH_AGENT"
/usr/bin/plutil -lint "$STAGED_UPDATE_LAUNCH_AGENT" >/dev/null || fail "the staged update LaunchAgent is invalid"

if /bin/launchctl print "$SERVICE" >/dev/null 2>&1; then
  SERVICE_WAS_LOADED=true
  /bin/launchctl bootout "$SERVICE" || fail "the existing LaunchAgent could not be stopped"
fi
if /bin/launchctl print "$UPDATE_SERVICE" >/dev/null 2>&1; then
  UPDATE_SERVICE_WAS_LOADED=true
  if [ "$AUTOMATIC_UPDATE" = true ]; then
    # The installer is a child of this LaunchAgent during an automatic update.
    # Booting it out here would terminate the update halfway through replacement.
    UPDATE_SERVICE_KEPT_LOADED=true
  else
    /bin/launchctl bootout "$UPDATE_SERVICE" || fail "the existing update LaunchAgent could not be stopped"
  fi
fi
if [ "$AUTOMATIC_UPDATE" = true ]; then
  /usr/bin/pkill -x "MultiVibe Host" >/dev/null 2>&1 || true
fi

if [ -e "$DESTINATION_APPLICATION" ]; then
  BACKUP_APPLICATION="$APPLICATIONS_DIRECTORY/.MultiVibe Host.app.previous.$$"
  [ ! -e "$BACKUP_APPLICATION" ] && [ ! -L "$BACKUP_APPLICATION" ] || fail "the application rollback destination already exists"
  mv "$DESTINATION_APPLICATION" "$BACKUP_APPLICATION"
fi
mv "$STAGED_APPLICATION" "$DESTINATION_APPLICATION"
APPLICATION_COMMITTED=true
rm -rf "$STAGING_DIRECTORY"
STAGING_DIRECTORY=""

if [ -e "$LAUNCH_AGENT" ]; then
  BACKUP_LAUNCH_AGENT="$LAUNCH_AGENTS_DIRECTORY/.$LABEL.plist.previous.$$"
  [ ! -e "$BACKUP_LAUNCH_AGENT" ] && [ ! -L "$BACKUP_LAUNCH_AGENT" ] || fail "the LaunchAgent rollback destination already exists"
  mv "$LAUNCH_AGENT" "$BACKUP_LAUNCH_AGENT"
fi
mv "$STAGED_LAUNCH_AGENT" "$LAUNCH_AGENT"
LAUNCH_AGENT_COMMITTED=true
STAGED_LAUNCH_AGENT=""

if [ -e "$UPDATE_LAUNCH_AGENT" ]; then
  BACKUP_UPDATE_LAUNCH_AGENT="$LAUNCH_AGENTS_DIRECTORY/.$UPDATE_LABEL.plist.previous.$$"
  [ ! -e "$BACKUP_UPDATE_LAUNCH_AGENT" ] && [ ! -L "$BACKUP_UPDATE_LAUNCH_AGENT" ] || fail "the update LaunchAgent rollback destination already exists"
  mv "$UPDATE_LAUNCH_AGENT" "$BACKUP_UPDATE_LAUNCH_AGENT"
fi
mv "$STAGED_UPDATE_LAUNCH_AGENT" "$UPDATE_LAUNCH_AGENT"
UPDATE_LAUNCH_AGENT_COMMITTED=true
STAGED_UPDATE_LAUNCH_AGENT=""

"$DESTINATION_APPLICATION/Contents/MacOS/multivibe-host" init
/bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT" || fail "the LaunchAgent could not be loaded"
/bin/launchctl enable "$SERVICE" || fail "the LaunchAgent could not be enabled"
/bin/launchctl kickstart -k "$SERVICE" || fail "MultiVibe Host could not be started"
/bin/launchctl print "$SERVICE" >/dev/null || fail "the LaunchAgent did not remain loaded"
if [ "$UPDATE_SERVICE_KEPT_LOADED" != true ]; then
  /bin/launchctl bootstrap "$DOMAIN" "$UPDATE_LAUNCH_AGENT" || fail "the update LaunchAgent could not be loaded"
  /bin/launchctl enable "$UPDATE_SERVICE" || fail "the update LaunchAgent could not be enabled"
fi
/bin/launchctl print "$UPDATE_SERVICE" >/dev/null || fail "the update LaunchAgent did not remain loaded"

version=$("$DESTINATION_APPLICATION/Contents/MacOS/multivibe-host" version)
health_attempt=0
health_ready=false
while [ "$health_attempt" -lt 60 ]; do
  if "$DESTINATION_APPLICATION/Contents/Frameworks/node" --eval "fetch('http://127.0.0.1:'+(process.env.MULTIVIBE_HOST_PORT||'1455')+'/health').then(async response=>{const body=await response.json();if(!response.ok||body.version!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))" "$version" >/dev/null 2>&1; then
    health_ready=true
    break
  fi
  health_attempt=$((health_attempt + 1))
  sleep 2
done
[ "$health_ready" = true ] || fail "the updated MultiVibe Host did not pass its post-start health check"
INSTALL_SUCCEEDED=true
printf 'MultiVibe Host %s and its verified update scheduler are installed and running from %s\n' "$version" "$DESTINATION_APPLICATION"
