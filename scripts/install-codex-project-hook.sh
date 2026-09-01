#!/bin/sh
set -eu

if [ -z "${MULTIVIBE_URL:-}" ]; then
  echo "MULTIVIBE_URL is required" >&2
  exit 1
fi
if [ -z "${MULTIVIBE_PROJECT_TOKEN:-}" ]; then
  echo "MULTIVIBE_PROJECT_TOKEN is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install the MultiVibe hook" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to install and run the MultiVibe hook" >&2
  exit 1
fi

multivibe_base_url=${MULTIVIBE_URL%/}
multivibe_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/multivibe-hook.XXXXXX")
trap 'rm -rf "$multivibe_tmp_dir"' EXIT HUP INT TERM

curl -fsSL "$multivibe_base_url/install-codex-project-hook.mjs" \
  -o "$multivibe_tmp_dir/install-codex-project-hook.mjs"
curl -fsSL "$multivibe_base_url/codex-project-hook.mjs" \
  -o "$multivibe_tmp_dir/codex-project-hook.mjs"

node "$multivibe_tmp_dir/install-codex-project-hook.mjs" --url "$multivibe_base_url"

