import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AccountStore, OAuthStateStore } from "./store.js";
import { createTraceManager } from "./traces.js";
import { createAdminRouter } from "./routes/admin/index.js";
import { createProxyRouter } from "./routes/proxy/index.js";
import { createOAuthCallbackServer } from "./oauth-callback-server.js";
import { oauthConfig as defaultOAuthConfig } from "./oauth-config.js";
import type { OAuthConfig } from "./oauth.js";
import {
  ADMIN_TOKEN,
  CHATGPT_BASE_URL,
  HOST,
  MISTRAL_BASE_URL,
  MISTRAL_COMPACT_UPSTREAM_PATH,
  MISTRAL_UPSTREAM_PATH,
  OAUTH_CALLBACK_BIND_HOST,
  OAUTH_STATE_PATH,
  PORT,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  STORE_ENCRYPTION_KEY,
  STORE_PATH,
  TRACE_FILE_PATH,
  TRACE_STATS_HISTORY_PATH,
  UPSTREAM_PATH,
} from "./config.js";

type RuntimeOptions = {
  host?: string;
  port?: number;
  adminToken?: string;
  storePath?: string;
  oauthStatePath?: string;
  traceFilePath?: string;
  traceStatsHistoryPath?: string;
  openaiBaseUrl?: string;
  mistralBaseUrl?: string;
  mistralUpstreamPath?: string;
  mistralCompactUpstreamPath?: string;
  oauthConfig?: OAuthConfig;
  oauthCallbackBindHost?: string;
  installSignalHandlers?: boolean;
  encryptionKey?: string;
  upstreamRequestTimeoutMs?: number;
};

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost"
  );
}

export async function createRuntime(options: RuntimeOptions = {}) {
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  const adminToken = options.adminToken ?? ADMIN_TOKEN;
  const storePath = options.storePath ?? STORE_PATH;
  const oauthStatePath = options.oauthStatePath ?? OAUTH_STATE_PATH;
  const traceFilePath = options.traceFilePath ?? TRACE_FILE_PATH;
  const traceStatsHistoryPath =
    options.traceStatsHistoryPath ?? TRACE_STATS_HISTORY_PATH;
  const openaiBaseUrl = options.openaiBaseUrl ?? CHATGPT_BASE_URL;
  const mistralBaseUrl = options.mistralBaseUrl ?? MISTRAL_BASE_URL;
  const mistralUpstreamPath =
    options.mistralUpstreamPath ?? MISTRAL_UPSTREAM_PATH;
  const mistralCompactUpstreamPath =
    options.mistralCompactUpstreamPath ?? MISTRAL_COMPACT_UPSTREAM_PATH;
  const oauthConfig = options.oauthConfig ?? defaultOAuthConfig;
  const oauthCallbackBindHost =
    options.oauthCallbackBindHost ?? OAUTH_CALLBACK_BIND_HOST;
  const encryptionKey = options.encryptionKey ?? STORE_ENCRYPTION_KEY;
  const upstreamRequestTimeoutMs = options.upstreamRequestTimeoutMs;

  if (!isLoopbackHost(host) && !adminToken) {
    throw new Error("ADMIN_TOKEN is required when binding off loopback");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" }));
  const oauthCallbackServer = createOAuthCallbackServer(oauthConfig.redirectUri);

  const store = new AccountStore(storePath, encryptionKey || undefined);
  const oauthStore = new OAuthStateStore(
    oauthStatePath,
    encryptionKey || undefined,
  );
  await store.init();
  await oauthStore.init();
  await fs.mkdir(path.dirname(traceFilePath), { recursive: true });

  const traceManager = createTraceManager({
    filePath: traceFilePath,
    historyFilePath: traceStatsHistoryPath,
  });

  let ready = false;
  let shuttingDown = false;

  function adminGuard(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    if (!adminToken) return next();
    const token =
      req.header("x-admin-token") ||
      req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (token !== adminToken)
      return res.status(401).json({ error: "unauthorized" });
    next();
  }

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      ready,
      shuttingDown,
      version: process.env.APP_VERSION ?? "unknown",
      gitSha: process.env.APP_GIT_SHA ?? "unknown",
      buildId: process.env.APP_BUILD_ID ?? "unknown",
    }),
  );

  app.get("/ready", (_req, res) => {
    if (!ready || shuttingDown) {
      return res.status(503).json({ ok: false, ready, shuttingDown });
    }
    return res.json({ ok: true, ready: true });
  });

  const adminRouter = createAdminRouter({
    store,
    oauthStore,
    traceManager,
    oauthConfig,
    openaiBaseUrl,
    mistralBaseUrl,
    storagePaths: {
      accountsPath: storePath,
      oauthStatePath,
      tracePath: traceFilePath,
      traceStatsHistoryPath,
    },
  });

  const proxyRouter = createProxyRouter({
    store,
    traceManager,
    openaiBaseUrl,
    mistralBaseUrl,
    mistralUpstreamPath,
    mistralCompactUpstreamPath,
    oauthConfig,
    upstreamRequestTimeoutMs,
  });

  app.use("/admin", adminGuard, adminRouter);
  app.use("/v1", proxyRouter);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, "../web-dist");
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/admin/") ||
      req.path.startsWith("/v1/") ||
      req.path === "/health" ||
      req.path === "/ready"
    ) {
      return next();
    }
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      if (res.headersSent) return;
      res.status(500).json({ error: "internal server error" });
    },
  );

  const server = http.createServer(app);
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;

  async function start() {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });

      if (oauthCallbackServer) {
        const callbackUrl = new URL(oauthConfig.redirectUri);
        await new Promise<void>((resolve, reject) => {
          oauthCallbackServer.once("error", reject);
          oauthCallbackServer.listen(
            Number(callbackUrl.port),
            oauthCallbackBindHost || callbackUrl.hostname,
            () => {
              oauthCallbackServer.off("error", reject);
              resolve();
            },
          );
        });
      }

      ready = true;
    } catch (err) {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (oauthCallbackServer) {
        oauthCallbackServer.closeAllConnections?.();
        await new Promise<void>((resolve) => oauthCallbackServer.close(() => resolve()));
      }
      throw err;
    }
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, SHUTDOWN_GRACE_MS);
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });
    if (oauthCallbackServer?.listening) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          oauthCallbackServer.closeAllConnections?.();
          resolve();
        }, SHUTDOWN_GRACE_MS);
        oauthCallbackServer.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
    }
    await store.flushIfDirty();
    await traceManager.compactTraceStorageIfNeeded();
  }

  if (options.installSignalHandlers ?? true) {
    const handleSignal = () => {
      shutdown()
        .catch((err) => {
          console.error(err);
        })
        .finally(() => {
          process.exit(0);
        });
    };
    process.once("SIGTERM", handleSignal);
    process.once("SIGINT", handleSignal);
  }

  return {
    app,
    server,
    store,
    oauthStore,
    traceManager,
    oauthCallbackServer,
    start,
    shutdown,
    state: () => ({ ready, shuttingDown }),
    config: {
      host,
      port,
      storePath,
      oauthStatePath,
      traceFilePath,
      traceStatsHistoryPath,
      openaiBaseUrl,
      mistralBaseUrl,
      mistralUpstreamPath,
      mistralCompactUpstreamPath,
      oauthConfig,
      oauthCallbackBindHost,
    },
  };
}
