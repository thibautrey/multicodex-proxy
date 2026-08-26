#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HEALTH_URL=${HEALTH_URL:-http://localhost:1455/health}

cd "$ROOT_DIR"

GIT_SHA=$(git rev-parse --short HEAD)
BUILD_ID=$(git rev-parse HEAD)

# Persist the image identity so later `docker compose` commands (logs, ps,
# inspect, and build) inherit the same required variables automatically.
umask 077
env_file="$ROOT_DIR/.env"
tmp_env_file=$(mktemp "$ROOT_DIR/.env.deploy.XXXXXX")
trap 'rm -f "$tmp_env_file"' EXIT INT TERM
if [ -f "$env_file" ]; then
  awk '!/^GIT_SHA=/ && !/^BUILD_ID=/' "$env_file" > "$tmp_env_file"
fi
printf 'GIT_SHA=%s\nBUILD_ID=%s\n' "$GIT_SHA" "$BUILD_ID" >> "$tmp_env_file"
mv "$tmp_env_file" "$env_file"
trap - EXIT INT TERM

printf '%s\n' "Deploying commit $GIT_SHA"
docker compose up -d --build --force-recreate

printf '%s\n' "Waiting for $HEALTH_URL"
i=0
while [ "$i" -lt 30 ]; do
  if response=$(curl --fail --silent --show-error --max-time 5 "$HEALTH_URL"); then
    if EXPECTED_SHA="$GIT_SHA" EXPECTED_BUILD_ID="$BUILD_ID" RESPONSE="$response" \
      node -e '
        const payload = JSON.parse(process.env.RESPONSE);
        if (payload.gitSha !== process.env.EXPECTED_SHA || payload.buildId !== process.env.EXPECTED_BUILD_ID) {
          console.error(`health identity mismatch: gitSha=${payload.gitSha} buildId=${payload.buildId}`);
          process.exit(1);
        }
      '
    then
      printf '%s\n' "Healthy: $response"
      exit 0
    fi
  fi
  i=$((i + 1))
  sleep 2
done

printf '%s\n' "Deployment health check failed" >&2
exit 1
