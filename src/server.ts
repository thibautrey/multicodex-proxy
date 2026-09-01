import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import crypto from "node:crypto";
import { AccountStore, OAuthStateStore, cleanupOrphanedTmpFiles } from "./store.js";
import { createTraceManager } from "./traces.js";
import { createAdminRouter } from "./routes/admin/index.js";
import { createProxyRouter } from "./routes/proxy/index.js";
import { createRealtimeRouter } from "./realtime-proxy.js";
import { installResponsesWebsocketProxy } from "./websocket-responses.js";
import { oauthConfig } from "./oauth-config.js";
import {
  ADMIN_TOKEN,
  CODEX_PROJECT_REGISTRATION_TOKEN,
  CODEX_PROJECTS_PATH,
  INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS,
  INFERENCE_IDEMPOTENCY_MAX_BYTES,
  INFERENCE_IDEMPOTENCY_MAX_ENTRIES,
  INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES,
  INFERENCE_IDEMPOTENCY_TTL_MS,
  JOBS_DB_PATH,
  JOB_WORKER_CONCURRENCY,
  CHATGPT_BASE_URL,
  MISTRAL_BASE_URL,
  MISTRAL_UPSTREAM_PATH,
  MISTRAL_COMPACT_UPSTREAM_PATH,
  ZAI_BASE_URL,
  ZAI_UPSTREAM_PATH,
  ZAI_COMPACT_UPSTREAM_PATH,
  XAI_BASE_URL,
  XAI_RESPONSES_PATH,
  STORE_PATH,
  TRACE_FILE_PATH,
  TRACE_STATS_HISTORY_PATH,
  TRACE_RETENTION_MAX,
  TRACE_INCLUDE_BODY,
  TRACE_INCLUDE_HEADERS,
  UPSTREAM_PATH,
  OAUTH_STATE_PATH,
  PORT,
  PROXY_API_KEY,
  PROXY_API_KEYS,
  REQUEST_BODY_LIMIT,
  REALTIME_PROVIDER,
  REALTIME_REQUEST_TIMEOUT_MS,
  REALTIME_WEBRTC_CALL_URL,
} from "./config.js";
import { createBodyParserMiddleware } from "./middleware/decompression.js";
import http from "node:http";
import { startScheduledWeeklyResetMonitor } from "./rate-limit-reset.js";
import {
  identifyProxyApplication,
  parseProxyApiKeys,
} from "./proxy-api-keys.js";
import { traceHeadersForRequest } from "./trace-headers.js";
import {
  CodexProjectRegistry,
  extractCodexProjectHost,
  extractCodexProjectRoot,
  extractCodexSessionId,
  extractLiteLLMProjectAttribution,
} from "./codex-projects.js";
import { anthropicErrorEnvelope } from "./anthropic-compat.js";
import { CapacityTracker } from "./smart-routing.js";
import { JobRunner, JobStore } from "./jobs.js";
import {
  SmartRoutingCoordinator,
  createAdmissionMiddleware,
  createSmartRoutingRouter,
} from "./smart-routing-routes.js";
import { createInferenceIdempotencyMiddleware } from "./inference-idempotency.js";

const app = express();
app.use(createBodyParserMiddleware());


app.use(
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large") {
      if (/(?:^|\/)messages$/.test(_req.path)) {
        return res.status(413).json(
          anthropicErrorEnvelope(413, {
            message: `Request body is too large. Limit is ${REQUEST_BODY_LIMIT}.`,
          }),
        );
      }
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
const capacityTracker = new CapacityTracker();
const jobStore = new JobStore(
  JOBS_DB_PATH,
  (application) => store.getApplicationPolicy(application).fairnessWeight,
);
const smartRouting = new SmartRoutingCoordinator(store, jobStore, capacityTracker);
const oauthStore = new OAuthStateStore(OAUTH_STATE_PATH);
const codexProjectRegistry = new CodexProjectRegistry(CODEX_PROJECTS_PATH);
const traceManager = createTraceManager({
  filePath: TRACE_FILE_PATH,
  historyFilePath: TRACE_STATS_HISTORY_PATH,
  retentionMax: TRACE_RETENTION_MAX,
  resolveCodexProject: (sessionId, projectRoot, projectHost) =>
    codexProjectRegistry.resolve(sessionId, projectRoot, projectHost),
});
const configuredProxyApiKeys = parseProxyApiKeys(PROXY_API_KEY, PROXY_API_KEYS);
await Promise.all([
  store.init(),
  oauthStore.init(),
  codexProjectRegistry.init(),
  traceManager.initialize(),
]);
await traceManager.seedStatsHistoryIfMissing();
startScheduledWeeklyResetMonitor({
  store,
  oauthConfig,
  openaiBaseUrl: CHATGPT_BASE_URL,
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
      ...(res.locals.multivibeTrace ?? {}),
      ...extractLiteLLMProjectAttribution(req.headers),
      codexProjectHost: extractCodexProjectHost(req.headers),
      codexProjectRoot: extractCodexProjectRoot(req.headers),
      at: Date.now(),
      route: `${req.method} ${route}`,
      application: res.locals.proxyApplication,
      codexSessionId: extractCodexSessionId(req.headers),
      requestHeaders: TRACE_INCLUDE_HEADERS
        ? traceHeadersForRequest(req.headers)
        : undefined,
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
  codexProjectRegistry,
  oauthConfig,
  openaiBaseUrl: CHATGPT_BASE_URL,
  mistralBaseUrl: MISTRAL_BASE_URL,
  zaiBaseUrl: ZAI_BASE_URL,
  codexProjectRegistrationToken: CODEX_PROJECT_REGISTRATION_TOKEN,
  configuredProxyApiKeys,
  smartRouting,
  storagePaths: {
    accountsPath: STORE_PATH,
    oauthStatePath: OAUTH_STATE_PATH,
    tracePath: TRACE_FILE_PATH,
    traceStatsHistoryPath: TRACE_STATS_HISTORY_PATH,
    codexProjectsPath: CODEX_PROJECTS_PATH,
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
  capacityTracker,
  smartRoutingCoordinator: smartRouting,
});

const realtimeRouter = createRealtimeRouter({
  store,
  oauthConfig,
  traceManager,
  chatgptBaseUrl: CHATGPT_BASE_URL,
  provider: REALTIME_PROVIDER,
  webrtcCallUrl: REALTIME_WEBRTC_CALL_URL || undefined,
  requestTimeoutMs: REALTIME_REQUEST_TIMEOUT_MS,
});

const ADMIN_SESSION_COOKIE = "multivibe_admin_session";
const ADMIN_SESSION_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const INTERNAL_JOB_TOKEN = crypto.randomBytes(32).toString("base64url");

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

function projectRegistrationGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!CODEX_PROJECT_REGISTRATION_TOKEN) {
    return res.status(503).json({ error: "Codex project registration is disabled" });
  }
  const token =
    req.header("x-codex-project-token") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, CODEX_PROJECT_REGISTRATION_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function hasProxyApiKey(headers: http.IncomingHttpHeaders): boolean {
  const proxyApiKeys = [
    ...configuredProxyApiKeys,
    ...store.getCachedProxyApiKeys(),
  ];
  if (!proxyApiKeys.length) return true;
  return Boolean(identifyProxyApplication(headers, proxyApiKeys));
}

function proxyGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const internalToken = req.header("x-multivibe-internal-token");
  if (internalToken && safeEqual(internalToken, INTERNAL_JOB_TOKEN)) {
    res.locals.proxyApplication =
      req.header("x-multivibe-internal-application") || "internal-job";
    return next();
  }
  const proxyApiKeys = [
    ...configuredProxyApiKeys,
    ...store.getCachedProxyApiKeys(),
  ];
  if (!proxyApiKeys.length || hasAdminSession(req)) {
    return next();
  }
  const application = identifyProxyApplication(req.headers, proxyApiKeys);
  if (application) {
    res.locals.proxyApplication = application;
    return next();
  }
  if (/\/(?:v1\/)?messages(?:\?|$)/.test(req.originalUrl)) {
    return res
      .status(401)
      .json(anthropicErrorEnvelope(401, "Invalid or missing proxy API key"));
  }
  return res.status(401).json({
    error: {
      message: "Invalid or missing proxy API key",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
}

function rootProxyGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const pathOrUrl = req.path || "/";
  const accepts = String(req.header("accept") ?? "").toLowerCase();
  const isKnownProxyEndpoint =
    pathOrUrl === "/chat/completions" ||
    pathOrUrl === "/responses" ||
    pathOrUrl === "/responses/compact" ||
    pathOrUrl === "/messages" ||
    pathOrUrl === "/models" ||
    pathOrUrl.startsWith("/models/") ||
    pathOrUrl === "/api/v1/models" ||
    pathOrUrl.startsWith("/api/v1/models/") ||
    pathOrUrl === "/api/tags" ||
    pathOrUrl === "/version" ||
    pathOrUrl === "/props" ||
    pathOrUrl === "/v1/props";
  if (
    pathOrUrl === "/" ||
    pathOrUrl === "/health" ||
    pathOrUrl === "/favicon.ico" ||
    pathOrUrl.startsWith("/admin") ||
    pathOrUrl.startsWith("/assets") ||
    (req.method === "GET" &&
      accepts.includes("text/html") &&
      !isKnownProxyEndpoint)
  ) {
    return next();
  }
  return proxyGuard(req, res, next);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../web-dist");
const scriptsDirectory = path.resolve(__dirname, "../scripts");

function sendHookInstallerFile(
  res: express.Response,
  fileName: string,
  contentType: string,
) {
  res.setHeader("cache-control", "no-cache");
  res.type(contentType);
  res.sendFile(path.join(scriptsDirectory, fileName));
}

app.get("/install-codex-project-hook.sh", (_req, res) =>
  sendHookInstallerFile(res, "install-codex-project-hook.sh", "text/x-shellscript"),
);
app.get("/install-codex-project-hook.mjs", (_req, res) =>
  sendHookInstallerFile(res, "install-codex-project-hook.mjs", "text/javascript"),
);
app.get("/codex-project-hook.mjs", (_req, res) =>
  sendHookInstallerFile(res, "codex-project-hook.mjs", "text/javascript"),
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? "unknown",
    gitSha: process.env.APP_GIT_SHA ?? "unknown",
    buildId: process.env.APP_BUILD_ID ?? "unknown",
  }),
);

app.head("/api/hello", (_req, res) => res.sendStatus(200));

app.get("/admin/session", (req, res) => {
  res.json({ authenticated: !ADMIN_TOKEN || hasAdminSession(req) });
});

app.post(
  "/admin/codex-sessions",
  projectRegistrationGuard,
  async (req, res) => {
    try {
      const registration = await codexProjectRegistry.register(req.body);
      res.status(201).json({ ok: true, ...registration });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  },
);

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
const inferenceIdempotencyMiddleware = createInferenceIdempotencyMiddleware({
  ttlMs: INFERENCE_IDEMPOTENCY_TTL_MS,
  inFlightTimeoutMs: INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS,
  maxEntries: INFERENCE_IDEMPOTENCY_MAX_ENTRIES,
  maxBytes: INFERENCE_IDEMPOTENCY_MAX_BYTES,
  maxResponseBytes: INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES,
});
const admissionMiddleware = createAdmissionMiddleware(smartRouting);
const smartRoutingRouter = createSmartRoutingRouter(smartRouting);
app.use(
  "/v1",
  proxyGuard,
  inferenceIdempotencyMiddleware,
  admissionMiddleware,
  smartRoutingRouter,
);
app.use("/v1", realtimeRouter);
app.use("/v1", proxyRouter);
app.use(
  "/",
  rootProxyGuard,
  inferenceIdempotencyMiddleware,
  admissionMiddleware,
  realtimeRouter,
);
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
    req.path === "/messages" ||
    req.path === "/models" ||
    /^\/models\//.test(req.path)
  )
    return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) next();
  });
});

// Sentry error handler must be registered after all routes and before listen().
Sentry.setupExpressErrorHandler(app);

const server = http.createServer(app);

const jobRunner = new JobRunner(
  jobStore,
  async (job) => {
    const executionTimeoutMs = Math.max(
      1,
      Math.min(
        30 * 60_000,
        job.deadlineAt ? job.deadlineAt - Date.now() : Number.POSITIVE_INFINITY,
      ),
    );
    const response = await fetch(`http://127.0.0.1:${PORT}${job.route}`, {
      method: job.method,
      headers: {
        ...job.requestHeaders,
        "content-type": "application/json",
        "x-multivibe-internal-token": INTERNAL_JOB_TOKEN,
        "x-multivibe-internal-application": job.application,
        "x-multivibe-internal-job": "1",
        "x-multivibe-priority": job.priority,
        "x-multivibe-execution": "sync",
      },
      body: JSON.stringify(job.requestBody),
      signal: AbortSignal.timeout(executionTimeoutMs),
    });
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep non-JSON upstream output as text.
    }
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "request-id", "openai-request-id", "anthropic-request-id"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return {
      status: response.status,
      headers,
      body,
      capacityUnavailable:
        response.status === 429 &&
        typeof body === "object" &&
        body !== null &&
        (body as any).error?.code === "capacity_unavailable",
    };
  },
  (application, id) =>
    store.getApplicationPolicy(application).webhooks.find((webhook) => webhook.id === id),
  JOB_WORKER_CONCURRENCY,
);

installResponsesWebsocketProxy({
  server,
  port: PORT,
  authorize: (req) => hasProxyApiKey(req.headers),
});

server.listen(PORT, () => {
  jobRunner.start();
  smartRouting.startHealthMonitoring();
  console.log(`multivibe listening on :${PORT}`);
  console.log(
    `store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} trace=${TRACE_FILE_PATH} traceStats=${TRACE_STATS_HISTORY_PATH} codexProjects=${CODEX_PROJECTS_PATH} redirect=${oauthConfig.redirectUri} openaiUpstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH} mistralUpstream=${MISTRAL_BASE_URL}${MISTRAL_UPSTREAM_PATH} zaiUpstream=${ZAI_BASE_URL}${ZAI_UPSTREAM_PATH} xaiUpstream=${XAI_BASE_URL}${XAI_RESPONSES_PATH}`,
  );
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  jobRunner.stop();
  smartRouting.stopHealthMonitoring();
  console.log(`received ${signal}, flushing persistent state`);
  server.close(async (error) => {
    try {
      await Promise.all([
        store.flushIfDirty(),
        codexProjectRegistry.flushPendingWrites(),
        traceManager.flushPendingWrites(),
      ]);
      jobStore.close();
      if (error) throw error;
      process.exitCode = 0;
    } catch (shutdownError) {
      console.error("graceful shutdown failed", shutdownError);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
