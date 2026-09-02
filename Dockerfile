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

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS provider-agent-build
WORKDIR /src/provider-agent
ARG TARGETOS
ARG TARGETARCH
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
ARG GIT_SHA=unknown
ARG BUILD_ID=unknown
ENV APP_GIT_SHA=$GIT_SHA
ENV APP_BUILD_ID=$BUILD_ID
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
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
EXPOSE 1455
CMD ["node", "--import", "./dist/instrument.js", "dist/server.js"]
