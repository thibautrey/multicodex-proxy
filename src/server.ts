import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { AccountStore, OAuthStateStore, cleanupOrphanedTmpFiles } from "./store.js";
import { createTraceManager } from "./traces.js";
import { createAdminRouter } from "./routes/admin/index.js";
import { createProxyRouter } from "./routes/proxy/index.js";
import { installResponsesWebsocketProxy } from "./websocket-responses.js";
import { oauthConfig } from "./oauth-config.js";
import {
  ADMIN_TOKEN,
  CHATGPT_BASE_URL,
  MISTRAL_BASE_URL,
  MISTRAL_UPSTREAM_PATH,
  MISTRAL_COMPACT_UPSTREAM_PATH,
  ZAI_BASE_URL,
  ZAI_UPSTREAM_PATH,
  ZAI_COMPACT_UPSTREAM_PATH,
  STORE_PATH,
  TRACE_FILE_PATH,
  TRACE_STATS_HISTORY_PATH,
  TRACE_RETENTION_MAX,
  TRACE_INCLUDE_BODY,
  UPSTREAM_PATH,
  OAUTH_STATE_PATH,
  PORT,
  REQUEST_BODY_LIMIT,
} from "./config.js";
import { createBodyParserMiddleware } from "./middleware/decompression.js";
import http from "node:http";

const app = express();
app.use(createBodyParserMiddleware());

app.use(
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json({
        error: {
          message: `Request body is too large. Limit is ${REQUEST_BODY_LIMIT}.`,
          type: "invalid_request_error",
          code: "payload_too_large",
        },
      });
    }
    next(err);
  },
);

const dataDir = path.dirname(STORE_PATH);
await cleanupOrphanedTmpFiles(dataDir);

const store = new AccountStore(STORE_PATH);
const oauthStore = new OAuthStateStore(OAUTH_STATE_PATH);
await store.init();
await oauthStore.init();
await fs.mkdir(path.dirname(TRACE_FILE_PATH), { recursive: true });

const traceManager = createTraceManager({
  filePath: TRACE_FILE_PATH,
  historyFilePath: TRACE_STATS_HISTORY_PATH,
  retentionMax: TRACE_RETENTION_MAX,
});

// Catch-all request tracing — records every request even if it doesn't hit an official endpoint.
// Routes that record their own detailed trace (e.g. /v1/chat/completions) set res.locals._multivibeTraced
// so we don't double-count them.
app.use((req, res, next) => {
  const startedAt = Date.now();
  const route = req.originalUrl || req.url;

  res.on("finish", () => {
    if (res.locals._multivibeTraced) return;
    const pathOrUrl = req.path || req.originalUrl || "";
    if (
      pathOrUrl.startsWith("/admin/") ||
      pathOrUrl.startsWith("/assets/") ||
      pathOrUrl === "/favicon.ico"
    )
      return;
    traceManager.recordTrace({
      at: Date.now(),
      route: `${req.method} ${route}`,
      status: res.statusCode,
      stream: false,
      latencyMs: Date.now() - startedAt,
      requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
    });
  });

  next();
});

const adminRouter = createAdminRouter({
  store,
  oauthStore,
  traceManager,
  oauthConfig,
  openaiBaseUrl: CHATGPT_BASE_URL,
  mistralBaseUrl: MISTRAL_BASE_URL,
  zaiBaseUrl: ZAI_BASE_URL,
  storagePaths: {
    accountsPath: STORE_PATH,
    oauthStatePath: OAUTH_STATE_PATH,
    tracePath: TRACE_FILE_PATH,
    traceStatsHistoryPath: TRACE_STATS_HISTORY_PATH,
  },
});

const proxyRouter = createProxyRouter({
  store,
  traceManager,
  openaiBaseUrl: CHATGPT_BASE_URL,
  mistralBaseUrl: MISTRAL_BASE_URL,
  mistralUpstreamPath: MISTRAL_UPSTREAM_PATH,
  mistralCompactUpstreamPath: MISTRAL_COMPACT_UPSTREAM_PATH,
  zaiBaseUrl: ZAI_BASE_URL,
  zaiUpstreamPath: ZAI_UPSTREAM_PATH,
  zaiCompactUpstreamPath: ZAI_COMPACT_UPSTREAM_PATH,
  oauthConfig,
});

const ADMIN_SESSION_COOKIE = "multivibe_admin_session";
const ADMIN_SESSION_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(req: express.Request, name: string): string | undefined {
  const cookieHeader = req.header("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function adminSessionValue(): string {
  return crypto
    .createHmac("sha256", ADMIN_TOKEN)
    .update("multivibe-admin-session-v1")
    .digest("base64url");
}

function hasAdminSession(req: express.Request): boolean {
  const sessionId = readCookie(req, ADMIN_SESSION_COOKIE);
  if (!sessionId) return false;
  return safeEqual(sessionId, adminSessionValue());
}

function shouldUseSecureCookie(req: express.Request): boolean {
  return req.secure || req.header("x-forwarded-proto") === "https";
}

function setAdminSession(req: express.Request, res: express.Response) {
  const sessionId = adminSessionValue();
  res.cookie(ADMIN_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(req),
    maxAge: ADMIN_SESSION_MAX_AGE_MS,
    path: "/",
  });
}

function clearAdminSession(req: express.Request, res: express.Response) {
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(req),
    path: "/",
  });
}

function adminGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!ADMIN_TOKEN) return next();
  if (hasAdminSession(req)) return next();
  const token =
    req.header("x-admin-token") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, ADMIN_TOKEN))
    return res.status(401).json({ error: "unauthorized" });
  next();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../web-dist");

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? "unknown",
    gitSha: process.env.APP_GIT_SHA ?? "unknown",
    buildId: process.env.APP_BUILD_ID ?? "unknown",
  }),
);

app.get("/admin/session", (req, res) => {
  res.json({ authenticated: !ADMIN_TOKEN || hasAdminSession(req) });
});

app.post("/admin/session", (req, res) => {
  if (!ADMIN_TOKEN) return res.json({ authenticated: true });
  const token = String(req.body?.token ?? "");
  if (!safeEqual(token, ADMIN_TOKEN))
    return res.status(401).json({ error: "unauthorized" });
  setAdminSession(req, res);
  res.json({ authenticated: true });
});

app.delete("/admin/session", (req, res) => {
  clearAdminSession(req, res);
  res.json({ authenticated: false });
});

app.use("/admin", adminGuard, adminRouter);
app.use("/v1", proxyRouter);
app.use("/", proxyRouter);

app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/v1/") ||
    req.path === "/health" ||
    req.path === "/chat/completions" ||
    req.path === "/responses" ||
    req.path === "/responses/compact" ||
    req.path === "/models" ||
    /^\/models\//.test(req.path)
  )
    return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) next();
  });
});

const server = http.createServer(app);

installResponsesWebsocketProxy({
  server,
  port: PORT,
});

server.listen(PORT, () => {
  console.log(`multivibe listening on :${PORT}`);
  console.log(
    `store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} trace=${TRACE_FILE_PATH} traceStats=${TRACE_STATS_HISTORY_PATH} redirect=${oauthConfig.redirectUri} openaiUpstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH} mistralUpstream=${MISTRAL_BASE_URL}${MISTRAL_UPSTREAM_PATH} zaiUpstream=${ZAI_BASE_URL}${ZAI_UPSTREAM_PATH}`,
  );
});
