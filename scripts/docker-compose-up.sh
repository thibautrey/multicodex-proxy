#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_GIT_SHA=$(git -C "$project_dir" rev-parse --verify HEAD)
APP_VERSION=$(cd "$project_dir" && node -p "require('./package.json').version")
APP_BUILD_ID=${APP_BUILD_ID:-local-$(date -u +%Y%m%dT%H%M%SZ)}
export APP_GIT_SHA APP_VERSION APP_BUILD_ID

exec docker compose -f "$project_dir/docker-compose.yml" up -d --build "$@"
