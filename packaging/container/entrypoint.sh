#!/bin/sh

set -eu
umask 077

PROGRAM_NAME="MultiVibe Host container"
APPLICATION_USER_ID=10001
APPLICATION_GROUP_ID=10001
APPLICATION=/opt/multivibe-host/bin/multivibe-host

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

prepare_mount() {
  directory=$1
  [ ! -L "$directory" ] || fail "$directory must not be a symbolic link"
  if [ ! -e "$directory" ]; then
    mkdir -p "$directory" || fail "$directory could not be created"
  fi
  [ -d "$directory" ] || fail "$directory must be a directory"
  chown "$APPLICATION_USER_ID:$APPLICATION_GROUP_ID" "$directory" || fail "$directory ownership could not be prepared"
  chmod 0700 "$directory" || fail "$directory permissions could not be protected"
}

[ -f "$APPLICATION" ] && [ ! -L "$APPLICATION" ] && [ -x "$APPLICATION" ] || fail "the bundled Host executable is unavailable"

current_user_id=$(id -u)
current_group_id=$(id -g)
if [ "$current_user_id" = 0 ]; then
  prepare_mount /data
  prepare_mount /models
  exec /usr/bin/setpriv \
    --reuid="$APPLICATION_USER_ID" \
    --regid="$APPLICATION_GROUP_ID" \
    --clear-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    "$APPLICATION" "$@"
fi

if [ "$current_user_id" != "$APPLICATION_USER_ID" ] || [ "$current_group_id" != "$APPLICATION_GROUP_ID" ]; then
  fail "run as root for the guarded privilege drop or as uid:gid 10001:10001"
fi

exec "$APPLICATION" "$@"
