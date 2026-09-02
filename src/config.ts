import os from "node:os";
import path from "node:path";

function finiteAtLeast(
  value: string | undefined,
  fallback: number,
  minimum: number,
) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.floor(parsed))
    : fallback;
}

export const PORT = Number(process.env.PORT ?? 1455);
export const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
export const MODULES_PATH =
  process.env.MODULES_PATH ?? path.join(path.dirname(STORE_PATH), "modules");
export const BUNDLED_SECURITY_MODULE_PATH =
  process.env.BUNDLED_SECURITY_MODULE_PATH ?? path.resolve("modules/security");
export const OAUTH_STATE_PATH =
  process.env.OAUTH_STATE_PATH ?? "/data/oauth-state.json";
export const TRACE_FILE_PATH =
  process.env.TRACE_FILE_PATH ?? "/data/requests-trace.jsonl";
export const TRACE_STATS_HISTORY_PATH =
  process.env.TRACE_STATS_HISTORY_PATH ?? "/data/requests-stats-history.jsonl";
export const CODEX_PROJECTS_PATH =
  process.env.CODEX_PROJECTS_PATH ?? "/data/codex-projects.json";
export const JOBS_DB_PATH = process.env.JOBS_DB_PATH ?? "/data/jobs.sqlite";
export const JOB_WORKER_CONCURRENCY = Math.max(
  1,
  Number(process.env.JOB_WORKER_CONCURRENCY ?? 16),
);
export const TRACE_INCLUDE_BODY =
  (process.env.TRACE_INCLUDE_BODY ?? "false") === "true"; // disabling the body trace by default keeps disk writes smaller
export const TRACE_INCLUDE_HEADERS =
  (process.env.TRACE_INCLUDE_HEADERS ?? "false") === "true"; // values are sanitized before persistence
export const USAGE_STALE_WHILE_REVALIDATE =
  (process.env.USAGE_STALE_WHILE_REVALIDATE ?? "true") !== "false";
export const USAGE_STALE_MAX_AGE_MS = Math.max(
  0,
  Number(process.env.USAGE_STALE_MAX_AGE_MS ?? 30 * 60_000),
);
export const MODELS_STALE_WHILE_REVALIDATE =
  (process.env.MODELS_STALE_WHILE_REVALIDATE ?? "true") !== "false";
export const MODELS_STALE_MAX_AGE_MS = Math.max(
  0,
  Number(process.env.MODELS_STALE_MAX_AGE_MS ?? 30 * 60_000),
);
export const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT ?? "100mb";
export const TRACE_RETENTION_MAX = Math.max(
  100,
  Number(process.env.TRACE_RETENTION_MAX ?? 1000),
); // Number of recent requests to keep with full text (metadata kept forever in history)
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
  Number(process.env.REALTIME_REQUEST_TIMEOUT_MS ?? 30_000),
);
export const MISTRAL_BASE_URL =
  process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai";
// Provider routes append `/v1/...`, so this is the API root before `/v1`.
export const OPENCODE_BASE_URL =
  process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen";
export const OPENCODE_CONSOLE_URL =
  process.env.OPENCODE_CONSOLE_URL ?? "https://opencode.ai/console";
export const OPENCODE_OAUTH_CLIENT_ID =
  process.env.OPENCODE_OAUTH_CLIENT_ID ?? "opencode-cli";
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
  process.env.ZAI_UPSTREAM_PATH ?? "/api/coding/paas/v4/chat/completions";
export const ZAI_COMPACT_UPSTREAM_PATH =
  process.env.ZAI_COMPACT_UPSTREAM_PATH ?? "/api/coding/paas/v4/chat/completions";
export const ZAI_MODELS_PATH =
  process.env.ZAI_MODELS_PATH ?? "/api/paas/v4/models";
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
export const CODEX_SESSION_AFFINITY =
  (process.env.CODEX_SESSION_AFFINITY ?? "false") === "true";
export const CODEX_SESSION_AFFINITY_MAX_ENTRIES = (() => {
  const value = Number(process.env.CODEX_SESSION_AFFINITY_MAX_ENTRIES ?? 10_000);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 10_000;
})();
export const INFERENCE_IDEMPOTENCY_TTL_MS = finiteAtLeast(
  process.env.INFERENCE_IDEMPOTENCY_TTL_MS,
  5 * 60_000,
  1_000,
);
export const INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS = finiteAtLeast(
  process.env.INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS,
  5 * 60_000,
  1_000,
);
export const INFERENCE_IDEMPOTENCY_MAX_ENTRIES = finiteAtLeast(
  process.env.INFERENCE_IDEMPOTENCY_MAX_ENTRIES,
  1_000,
  1,
);
export const INFERENCE_IDEMPOTENCY_MAX_BYTES = finiteAtLeast(
  process.env.INFERENCE_IDEMPOTENCY_MAX_BYTES,
  32 * 1024 * 1024,
  1_024,
);
export const INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES = finiteAtLeast(
  process.env.INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES,
  1024 * 1024,
  1_024,
);
export const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
export const PROXY_API_KEYS = process.env.PROXY_API_KEYS ?? "";
export const CLAUDE_CODE_MODEL =
  process.env.CLAUDE_CODE_MODEL ?? "gpt-5.6-luna";
export const CLAUDE_CODE_FAST_MODEL =
  process.env.CLAUDE_CODE_FAST_MODEL ?? "gpt-5.4-mini";
export const MAX_ACCOUNT_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.MAX_ACCOUNT_RETRY_ATTEMPTS ?? 10),
);
export const MAX_UPSTREAM_RETRIES = Math.max(
  0,
  Number(process.env.MAX_UPSTREAM_RETRIES ?? 5),
);
export const UPSTREAM_BASE_DELAY_MS = Math.max(
  100,
  Number(process.env.UPSTREAM_BASE_DELAY_MS ?? 2000),
);
export const HANG_RETRY_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.HANG_RETRY_INTERVAL_MS ?? 10_000),
);
export const HANG_RETRY_MAX_DURATION_MS = Math.max(
  5000,
  Number(process.env.HANG_RETRY_MAX_DURATION_MS ?? 120_000),
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
  process.env.MODELS_CACHE_MS ?? 10 * 60_000,
);

export const TOKEN_REFRESH_MARGIN_MS = Number(
  process.env.TOKEN_REFRESH_MARGIN_MS ?? 60_000,
);

export const ACCOUNT_FLUSH_INTERVAL_MS = Number(
  process.env.ACCOUNT_FLUSH_INTERVAL_MS ?? 5_000,
);

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
  Number(process.env.EMPTY_RESPONSE_BLOCK_THRESHOLD ?? 3),
);
export const EMPTY_RESPONSE_BLOCK_DURATION_MS = Math.max(
  5_000,
  Number(process.env.EMPTY_RESPONSE_BLOCK_DURATION_MS ?? 30_000),
);
export const EMPTY_RESPONSE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.EMPTY_RESPONSE_WINDOW_MS ?? 5 * 60_000),
);

export const MODEL_NOT_FOUND_BLOCK_DURATION_MS = Math.max(
  60_000,
  Number(process.env.MODEL_NOT_FOUND_BLOCK_DURATION_MS ?? 60 * 60_000),
);
