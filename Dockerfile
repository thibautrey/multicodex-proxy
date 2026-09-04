FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web install

FROM node:22-alpine AS build
WORKDIR /app
ARG GIT_SHA=unknown
ARG BUILD_ID=unknown
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm run build

FROM rust:1.88-alpine AS rust-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY rust/ ./rust/
RUN cargo build --release -p multivibe-proxy-core
RUN cargo build --release -p multivibe-v1-edge

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS provider-agent-build
WORKDIR /src/provider-agent
ARG TARGETOS
ARG TARGETARCH
COPY docs/runtime-community-gpu-benchmark-e690aa1.result.json /src/docs/runtime-community-gpu-benchmark-e690aa1.result.json
COPY provider-agent/ ./
COPY packaging/ /src/packaging/
RUN go test ./...
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
  go build -trimpath -buildvcs=false -ldflags="-s -w" \
  -o /out/multivibe-provider-agent .

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git libstdc++
ENV NODE_ENV=production
ENV MULTIVIBE_CONTROL_PLANE=true
ENV CONTROL_PLANE_PORT=1456
ENV V1_EDGE_PORT=1455
ARG GIT_SHA=unknown
ARG BUILD_ID=unknown
ENV APP_GIT_SHA=$GIT_SHA
ENV APP_BUILD_ID=$BUILD_ID
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=rust-build /src/target/release/libmultivibe_proxy_core.so ./native/multivibe-proxy-core.node
COPY --from=rust-build /src/target/release/multivibe-v1-edge /opt/multivibe/bin/multivibe-v1-edge
COPY --chmod=0555 scripts/start-multivibe.sh /usr/local/bin/start-multivibe.sh
COPY modules/security ./modules/security
COPY --from=build \
  /app/scripts/codex-project-hook.mjs \
  /app/scripts/install-codex-project-hook.mjs \
  /app/scripts/install-codex-project-hook.sh \
  ./scripts/
COPY --from=provider-agent-build --chmod=0555 \
  /out/multivibe-provider-agent \
  /opt/multivibe/bin/multivibe-provider-agent
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 1455 1456
CMD ["/usr/local/bin/start-multivibe.sh"]
