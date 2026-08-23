FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web ci

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ARG APP_VERSION=0.2.0
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_ID=local
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
ENV APP_GIT_SHA=${APP_GIT_SHA}
ENV APP_BUILD_ID=${APP_BUILD_ID}
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=build \
  /app/scripts/codex-project-hook.mjs \
  /app/scripts/install-codex-project-hook.mjs \
  /app/scripts/install-codex-project-hook.sh \
  ./scripts/
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 1455
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1455/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--import", "./dist/instrument.js", "dist/server.js"]
