#!/bin/sh
set -eu

if [ -z "${MULTICODEX_URL:-}" ]; then
  echo "MULTICODEX_URL is required" >&2
  exit 1
fi
if [ -z "${MULTICODEX_PROJECT_TOKEN:-}" ]; then
  echo "MULTICODEX_PROJECT_TOKEN is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install the MultiCodex hook" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to install and run the MultiCodex hook" >&2
  exit 1
fi

multicodex_base_url=${MULTICODEX_URL%/}
multicodex_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/multicodex-hook.XXXXXX")
trap 'rm -rf "$multicodex_tmp_dir"' EXIT HUP INT TERM

curl -fsSL "$multicodex_base_url/install-codex-project-hook.mjs" \
  -o "$multicodex_tmp_dir/install-codex-project-hook.mjs"
curl -fsSL "$multicodex_base_url/codex-project-hook.mjs" \
  -o "$multicodex_tmp_dir/codex-project-hook.mjs"

node "$multicodex_tmp_dir/install-codex-project-hook.mjs" --url "$multicodex_base_url"

