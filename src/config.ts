import os from "node:os";

export const HOST = process.env.HOST ?? "127.0.0.1";
export const PORT = Number(process.env.PORT ?? 4010);
export const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
export const OAUTH_STATE_PATH =
  process.env.OAUTH_STATE_PATH ?? "/data/oauth-state.json";
export const TRACE_FILE_PATH =
  process.env.TRACE_FILE_PATH ?? "/data/requests-trace.jsonl";
export const TRACE_STATS_HISTORY_PATH =
  process.env.TRACE_STATS_HISTORY_PATH ??
  "/data/requests-stats-history.jsonl";
export const TRACE_INCLUDE_BODY =
  (process.env.TRACE_INCLUDE_BODY ?? "false") === "true"; // disabling the body trace by default keeps disk writes smaller
export const CHATGPT_BASE_URL =
  process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
export const MISTRAL_BASE_URL =
  process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai";
export const UPSTREAM_PATH =
  process.env.UPSTREAM_PATH ?? "/backend-api/codex/responses";
export const UPSTREAM_COMPACT_PATH =
  process.env.UPSTREAM_COMPACT_PATH ?? "/backend-api/codex/responses/compact";
export const MISTRAL_UPSTREAM_PATH =
  process.env.MISTRAL_UPSTREAM_PATH ?? "/v1/responses";
export const MISTRAL_COMPACT_UPSTREAM_PATH =
  process.env.MISTRAL_COMPACT_UPSTREAM_PATH ?? "/v1/responses/compact";
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
export const STORE_ENCRYPTION_KEY =
  process.env.STORE_ENCRYPTION_KEY ?? "";
export const MAX_ACCOUNT_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.MAX_ACCOUNT_RETRY_ATTEMPTS ?? 5),
);
export const MAX_GET_RETRIES = Math.max(
  0,
  Number(process.env.MAX_GET_RETRIES ?? 2),
);
export const RETRY_BASE_DELAY_MS = Math.max(
  100,
  Number(process.env.RETRY_BASE_DELAY_MS ?? 250),
);
export const PI_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;

export const PROXY_MODELS =
  (process.env.PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const MODELS_CLIENT_VERSION =
  process.env.MODELS_CLIENT_VERSION ?? "1.0.0";
export const MODELS_CACHE_MS = Number(
  process.env.MODELS_CACHE_MS ?? 10 * 60_000,
);

export const TOKEN_REFRESH_MARGIN_MS = Number(
  process.env.TOKEN_REFRESH_MARGIN_MS ?? 60_000,
);
export const TOKEN_REFRESH_COOLDOWN_MS = Number(
  process.env.TOKEN_REFRESH_COOLDOWN_MS ?? 5 * 60_000,
);
export const UPSTREAM_REQUEST_TIMEOUT_MS = Number(
  process.env.UPSTREAM_REQUEST_TIMEOUT_MS ?? 60_000,
);
export const MODEL_DISCOVERY_TIMEOUT_MS = Number(
  process.env.MODEL_DISCOVERY_TIMEOUT_MS ?? 8_000,
);
export const OAUTH_REQUEST_TIMEOUT_MS = Number(
  process.env.OAUTH_REQUEST_TIMEOUT_MS ?? 15_000,
);
export const OAUTH_CALLBACK_BIND_HOST =
  process.env.OAUTH_CALLBACK_BIND_HOST ?? "";
export const MODEL_COMPATIBILITY_TTL_MS = Number(
  process.env.MODEL_COMPATIBILITY_TTL_MS ?? 6 * 60 * 60_000,
);
export const SERVER_HEADERS_TIMEOUT_MS = Number(
  process.env.SERVER_HEADERS_TIMEOUT_MS ?? 30_000,
);
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = Number(
  process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS ?? 5_000,
);
export const SERVER_REQUEST_TIMEOUT_MS = Number(
  process.env.SERVER_REQUEST_TIMEOUT_MS ?? 90_000,
);
export const SHUTDOWN_GRACE_MS = Number(
  process.env.SHUTDOWN_GRACE_MS ?? 10_000,
);
export const TRACE_COMPACTION_INTERVAL = Math.max(
  1,
  Number(process.env.TRACE_COMPACTION_INTERVAL ?? 100),
);

export const ACCOUNT_FLUSH_INTERVAL_MS = Number(
  process.env.ACCOUNT_FLUSH_INTERVAL_MS ?? 5_000,
);
