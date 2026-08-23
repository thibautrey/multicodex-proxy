import os from "node:os";

function finiteNumber(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function finiteInteger(name: string, fallback: number, minimum = 0): number {
  const value = finiteNumber(name, fallback, minimum);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

export const PORT = finiteInteger("PORT", 1455, 1);
export const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
export const OAUTH_STATE_PATH =
  process.env.OAUTH_STATE_PATH ?? "/data/oauth-state.json";
export const TRACE_FILE_PATH =
  process.env.TRACE_FILE_PATH ?? "/data/requests-trace.jsonl";
export const TRACE_STATS_HISTORY_PATH =
  process.env.TRACE_STATS_HISTORY_PATH ?? "/data/requests-stats-history.jsonl";
export const CODEX_PROJECTS_PATH =
  process.env.CODEX_PROJECTS_PATH ?? "/data/codex-projects.json";
export const TRACE_INCLUDE_BODY =
  (process.env.TRACE_INCLUDE_BODY ?? "false") === "true"; // disabling the body trace by default keeps disk writes smaller
export const TRACE_INCLUDE_HEADERS =
  (process.env.TRACE_INCLUDE_HEADERS ?? "false") === "true"; // values are sanitized before persistence
export const USAGE_STALE_WHILE_REVALIDATE =
  (process.env.USAGE_STALE_WHILE_REVALIDATE ?? "true") !== "false";
export const USAGE_STALE_MAX_AGE_MS = Math.max(
  0,
  finiteNumber("USAGE_STALE_MAX_AGE_MS", 30 * 60_000),
);
export const MODELS_STALE_WHILE_REVALIDATE =
  (process.env.MODELS_STALE_WHILE_REVALIDATE ?? "true") !== "false";
export const MODELS_STALE_MAX_AGE_MS = Math.max(
  0,
  finiteNumber("MODELS_STALE_MAX_AGE_MS", 30 * 60_000),
);
export const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT ?? "32mb";
export const TRACE_RETENTION_MAX = Math.max(
  100,
  finiteInteger("TRACE_RETENTION_MAX", 1000, 100),
); // Number of recent requests to keep with full text.
export const TRACE_STATS_RETENTION_MS = finiteNumber(
  "TRACE_STATS_RETENTION_MS",
  90 * 24 * 60 * 60_000,
  24 * 60 * 60_000,
);
export const CHATGPT_BASE_URL =
  process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
export const REALTIME_PROVIDER =
  process.env.REALTIME_PROVIDER === "openai-compatible"
    ? "openai-compatible"
    : "openai";
export const REALTIME_WEBRTC_CALL_URL =
  process.env.REALTIME_WEBRTC_CALL_URL ?? "";
export const REALTIME_REQUEST_TIMEOUT_MS = Math.max(
  1_000,
  finiteNumber("REALTIME_REQUEST_TIMEOUT_MS", 30_000, 1_000),
);
export const UPSTREAM_REQUEST_TIMEOUT_MS = finiteNumber(
  "UPSTREAM_REQUEST_TIMEOUT_MS",
  90_000,
  1_000,
);
export const AUXILIARY_REQUEST_TIMEOUT_MS = finiteNumber(
  "AUXILIARY_REQUEST_TIMEOUT_MS",
  15_000,
  1_000,
);
export const UPSTREAM_TOTAL_TIMEOUT_MS = finiteNumber(
  "UPSTREAM_TOTAL_TIMEOUT_MS",
  120_000,
  5_000,
);
export const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = finiteNumber(
  "UPSTREAM_STREAM_IDLE_TIMEOUT_MS",
  90_000,
  5_000,
);
export const WEBSOCKET_MAX_PAYLOAD_BYTES = finiteInteger(
  "WEBSOCKET_MAX_PAYLOAD_BYTES",
  8 * 1024 * 1024,
  1024,
);
export const WEBSOCKET_MAX_BUFFERED_BYTES = finiteInteger(
  "WEBSOCKET_MAX_BUFFERED_BYTES",
  1024 * 1024,
  64 * 1024,
);
export const SHUTDOWN_TIMEOUT_MS = finiteNumber(
  "SHUTDOWN_TIMEOUT_MS",
  15_000,
  1_000,
);
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
export const ZAI_BASE_URL = process.env.ZAI_BASE_URL ?? "https://api.z.ai";
export const ZAI_UPSTREAM_PATH =
  process.env.ZAI_UPSTREAM_PATH ?? "/v1/chat/completions";
export const ZAI_COMPACT_UPSTREAM_PATH =
  process.env.ZAI_COMPACT_UPSTREAM_PATH ?? "/v1/chat/completions";
export const XAI_BASE_URL =
  process.env.XAI_BASE_URL ?? "https://cli-chat-proxy.grok.com/v1";
export const XAI_RESPONSES_PATH =
  process.env.XAI_RESPONSES_PATH ?? "/responses";
export const XAI_CHAT_COMPLETIONS_PATH =
  process.env.XAI_CHAT_COMPLETIONS_PATH ?? "/chat/completions";
export const XAI_MODELS_PATH = process.env.XAI_MODELS_PATH ?? "/models";
export const XAI_OAUTH_ISSUER =
  process.env.XAI_OAUTH_ISSUER ?? "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID =
  process.env.XAI_OAUTH_CLIENT_ID ??
  "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPES = (
  process.env.XAI_OAUTH_SCOPES ??
  [
    "openid",
    "profile",
    "email",
    "offline_access",
    "grok-cli:access",
    "api:access",
    "conversations:read",
    "conversations:write",
    "workspaces:read",
    "workspaces:write",
  ].join(" ")
)
  .split(/[,\s]+/)
  .map((scope) => scope.trim())
  .filter(Boolean);
export const XAI_CLIENT_VERSION =
  process.env.XAI_CLIENT_VERSION ?? "0.2.114";
export const XAI_CLIENT_IDENTIFIER =
  process.env.XAI_CLIENT_IDENTIFIER ?? "grok-pager";
export const XAI_TOKEN_AUTH =
  process.env.XAI_TOKEN_AUTH ?? "xai-grok-cli";
export const XAI_USER_AGENT =
  process.env.XAI_USER_AGENT ??
  `grok-pager/${XAI_CLIENT_VERSION} grok-shell/${XAI_CLIENT_VERSION} (${os.platform()}; ${os.arch()})`;
export const XAI_AUTH_PATH =
  process.env.XAI_AUTH_PATH ?? `${os.homedir()}/.grok/auth.json`;
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
export const CODEX_PROJECT_REGISTRATION_TOKEN =
  process.env.CODEX_PROJECT_REGISTRATION_TOKEN ?? ADMIN_TOKEN;
export const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
export const PROXY_API_KEYS = process.env.PROXY_API_KEYS ?? "";
export const MAX_ACCOUNT_RETRY_ATTEMPTS = Math.max(
  1,
  finiteInteger("MAX_ACCOUNT_RETRY_ATTEMPTS", 10, 1),
);
export const MAX_UPSTREAM_RETRIES = Math.max(
  0,
  finiteInteger("MAX_UPSTREAM_RETRIES", 2, 0),
);
export const UPSTREAM_BASE_DELAY_MS = Math.max(
  100,
  finiteNumber("UPSTREAM_BASE_DELAY_MS", 500, 100),
);
export const HANG_RETRY_INTERVAL_MS = Math.max(
  1000,
  finiteNumber("HANG_RETRY_INTERVAL_MS", 10_000, 1_000),
);
export const HANG_RETRY_MAX_DURATION_MS = Math.max(
  5000,
  finiteNumber("HANG_RETRY_MAX_DURATION_MS", 120_000, 5_000),
);
export const PI_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
export const MODELS_CLIENT_VERSION =
  process.env.MODELS_CLIENT_VERSION ?? "0.144.1";
// Luna expects requests made with a ChatGPT OAuth token to identify as Codex.
// Keep the runtime and model-discovery identity on the same Codex client version.
export const CODEX_CLI_ORIGINATOR = "codex_cli_rs";
export const CODEX_CLI_USER_AGENT = `codex_cli_rs/${MODELS_CLIENT_VERSION}`;

export const PROXY_MODELS = (
  process.env.PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const MODELS_CACHE_MS = Number(
  finiteNumber("MODELS_CACHE_MS", 10 * 60_000),
);

export const TOKEN_REFRESH_MARGIN_MS = finiteNumber("TOKEN_REFRESH_MARGIN_MS", 60_000);

export const ACCOUNT_FLUSH_INTERVAL_MS = finiteNumber("ACCOUNT_FLUSH_INTERVAL_MS", 5_000);

// EXCLUDED_PROVIDER_MODELS: exclude a model from being routed to a specific provider.
// Format: "provider1:modelA,provider1:modelB,provider2:modelC"
// Example: "openai-compatible:gpt-5-codex,mistral:codestral-latest"
// This is useful when multiple providers expose a model with the same name and you
// want to ensure routing only targets the intended provider.
export const EXCLUDED_PROVIDER_MODELS = (
  process.env.EXCLUDED_PROVIDER_MODELS ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .reduce((map, entry) => {
    const colonIdx = entry.indexOf(":");
    if (colonIdx <= 0) return map; // skip malformed entries
    const provider = entry.slice(0, colonIdx).trim();
    const model = entry.slice(colonIdx + 1).trim().toLowerCase();
    if (!provider || !model) return map;
    if (!map.has(provider)) map.set(provider, new Set());
    map.get(provider)!.add(model);
    return map;
  }, new Map<string, Set<string>>());

// Empty response retry configuration
export const EMPTY_RESPONSE_BLOCK_THRESHOLD = Math.max(
  1,
  finiteInteger("EMPTY_RESPONSE_BLOCK_THRESHOLD", 3, 1),
);
export const EMPTY_RESPONSE_BLOCK_DURATION_MS = Math.max(
  5_000,
  finiteNumber("EMPTY_RESPONSE_BLOCK_DURATION_MS", 30_000, 5_000),
);
export const EMPTY_RESPONSE_WINDOW_MS = Math.max(
  60_000,
  finiteNumber("EMPTY_RESPONSE_WINDOW_MS", 5 * 60_000, 60_000),
);

export const MODEL_NOT_FOUND_BLOCK_DURATION_MS = Math.max(
  60_000,
  finiteNumber("MODEL_NOT_FOUND_BLOCK_DURATION_MS", 60 * 60_000, 60_000),
);

export function validateProductionSecrets(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!ADMIN_TOKEN || ADMIN_TOKEN === "change-me") {
    throw new Error("ADMIN_TOKEN must be set to a non-default value in production");
  }
  if (!PROXY_API_KEY && !PROXY_API_KEYS) {
    throw new Error("PROXY_API_KEY or PROXY_API_KEYS must be set in production");
  }
}
