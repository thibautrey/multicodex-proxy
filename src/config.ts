import os from "node:os";

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
export const UPSTREAM_PATH =
  process.env.UPSTREAM_PATH ?? "/backend-api/codex/responses";
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
export const MAX_ACCOUNT_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.MAX_ACCOUNT_RETRY_ATTEMPTS ?? 5),
);
export const MAX_UPSTREAM_RETRIES = Math.max(
  0,
  Number(process.env.MAX_UPSTREAM_RETRIES ?? 3),
);
export const UPSTREAM_BASE_DELAY_MS = Math.max(
  100,
  Number(process.env.UPSTREAM_BASE_DELAY_MS ?? 1000),
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

export const ACCOUNT_FLUSH_INTERVAL_MS = Number(
  process.env.ACCOUNT_FLUSH_INTERVAL_MS ?? 5_000,
);
