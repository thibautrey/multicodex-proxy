import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AccountStore, OAuthStateStore } from "./store.js";
import { createTraceManager } from "./traces.js";
import { createAdminRouter } from "./routes/admin/index.js";
import { createProxyRouter } from "./routes/proxy/index.js";
import { oauthConfig } from "./oauth-config.js";
import {
  ADMIN_TOKEN,
  CHATGPT_BASE_URL,
  STORE_PATH,
  TRACE_FILE_PATH,
  TRACE_STATS_HISTORY_PATH,
  UPSTREAM_PATH,
  OAUTH_STATE_PATH,
} from "./config.js";

const app = express();
app.use(express.json({ limit: "20mb" }));

const store = new AccountStore(STORE_PATH);
const oauthStore = new OAuthStateStore(OAUTH_STATE_PATH);
await store.init();
await oauthStore.init();
await fs.mkdir(path.dirname(TRACE_FILE_PATH), { recursive: true });

const traceManager = createTraceManager({
  filePath: TRACE_FILE_PATH,
  historyFilePath: TRACE_STATS_HISTORY_PATH,
});

const adminRouter = createAdminRouter({
  store,
  oauthStore,
  traceManager,
  oauthConfig,
  chatgptBaseUrl: CHATGPT_BASE_URL,
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
  chatgptBaseUrl: CHATGPT_BASE_URL,
  oauthConfig,
});

function adminGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!ADMIN_TOKEN) return next();
  const token =
    req.header("x-admin-token") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token !== ADMIN_TOKEN)
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

app.use("/admin", adminGuard, adminRouter);
app.use("/v1", proxyRouter);

app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/v1/") ||
    req.path === "/health"
  )
    return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(process.env.PORT ?? 4010, () => {
  console.log(`multicodex-proxy listening on :${process.env.PORT ?? 4010}`);
  console.log(
    `store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} trace=${TRACE_FILE_PATH} traceStats=${TRACE_STATS_HISTORY_PATH} redirect=${oauthConfig.redirectUri} upstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH}`,
  );
});
