import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("the Core image builds and embeds the provider agent for its target architecture", async () => {
  const dockerfile = await readFile(`${repositoryRoot}/Dockerfile`, "utf8");
  const config = await readFile(`${repositoryRoot}/src/config.ts`, "utf8");

  assert.match(dockerfile, /^FROM node:22-bookworm-slim AS deps$/m);
  assert.match(dockerfile, /^FROM node:22-bookworm-slim AS build$/m);
  assert.match(dockerfile, /^FROM rust:1\.88-bookworm AS rust-build$/m);
  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.doesNotMatch(dockerfile, /^FROM node:22-alpine/m);
  assert.doesNotMatch(dockerfile, /^FROM rust:1\.88-alpine/m);
  assert.match(
    dockerfile,
    /FROM --platform=\$BUILDPLATFORM golang:1\.24-alpine AS provider-agent-build/,
  );
  assert.match(dockerfile, /ARG TARGETOS\nARG TARGETARCH/);
  assert.match(
    dockerfile,
    /COPY docs\/runtime-community-gpu-benchmark-e690aa1\.result\.json \/src\/docs\/runtime-community-gpu-benchmark-e690aa1\.result\.json/,
  );
  assert.match(
    dockerfile,
    /COPY provider-agent\/ \.\/\nCOPY packaging\/ \/src\/packaging\/\nRUN go test \.\/\.\.\./,
  );
  assert.match(
    dockerfile,
    /CGO_ENABLED=0 GOOS="\$TARGETOS" GOARCH="\$TARGETARCH" \\\n  go build -trimpath -buildvcs=false -ldflags="-s -w"/,
  );
  assert.match(
    dockerfile,
    /COPY --from=provider-agent-build --chmod=0555 \\\n  \/out\/multivibe-provider-agent \\\n  \/opt\/multivibe\/bin\/multivibe-provider-agent/,
  );
  assert.match(
    config,
    /process\.env\.PROVIDER_AGENT_BINARY \?\? "\/opt\/multivibe\/bin\/multivibe-provider-agent"/,
  );
  assert.match(
    config,
    /\(process\.env\.PROVIDER_AGENT_ENABLED \?\? "false"\) === "true"/,
  );
});
