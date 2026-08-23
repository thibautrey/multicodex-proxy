import express from "express";
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  MODELS_CLIENT_VERSION,
  TRACE_INCLUDE_HEADERS,
} from "./config.js";
import type { OAuthConfig } from "./oauth.js";
import type { Account, ProviderId } from "./types.js";
import { AccountStore } from "./store.js";
import { ensureValidToken } from "./account-utils.js";
import {
  accountUsable,
  chooseAccountForProvider,
  isQuotaErrorText,
  markQuotaHit,
  normalizeProvider,
  rememberError,
} from "./quota.js";
import type { TraceManager } from "./traces.js";
import { traceHeadersForRequest } from "./trace-headers.js";
import {
  extractCodexSessionId,
  extractLiteLLMProjectAttribution,
} from "./codex-projects.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// These headers are emitted by official Codex/ChatGPT clients and can be
// required by the upstream edge for device or attestation checks. Keep this
// list explicit: cookies, credentials, and arbitrary inbound headers must not
// be copied to ChatGPT.
const CLIENT_IDENTITY_HEADERS = [
  "oai-client-version",
  "oai-device-id",
  "oai-language",
  "proof-token",
  "x-oai-attestation",
  "x-openai-attestation",
  "x-openai-browser-token",
  "x-openai-sentinel",
  "x-proof-token",
] as const;

export type RealtimeProxyOptions = {
  store: AccountStore;
  oauthConfig: OAuthConfig;
  traceManager: TraceManager;
  chatgptBaseUrl: string;
  provider: Extract<ProviderId, "openai" | "openai-compatible">;
  webrtcCallUrl?: string;
  requestTimeoutMs: number;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function realtimeCallUrl(
  account: Account,
  options: Pick<
    RealtimeProxyOptions,
    "chatgptBaseUrl" | "provider" | "webrtcCallUrl"
  >,
): string {
  if (options.webrtcCallUrl) return options.webrtcCallUrl;
  if (options.provider === "openai-compatible") {
    if (!account.baseUrl) {
      throw new Error(
        "Realtime OpenAI-compatible account requires a baseUrl or REALTIME_WEBRTC_CALL_URL",
      );
    }
    return `${trimTrailingSlash(account.baseUrl)}/realtime/calls`;
  }
  return `${trimTrailingSlash(options.chatgptBaseUrl)}/backend-api/realtime/calls`;
}

export function realtimeVoicesUrl(chatgptBaseUrl: string, req: express.Request) {
  const url = new URL(
    `${trimTrailingSlash(chatgptBaseUrl)}/backend-api/settings/voices`,
  );
  const spokenLanguage = String(req.query.spoken_language ?? "").trim();
  const voiceMode = String(req.query.voice_mode ?? "advanced").trim();
  if (spokenLanguage) url.searchParams.set("spoken_language", spokenLanguage);
  url.searchParams.set("voice_mode", voiceMode || "advanced");
  return url.toString();
}

function incomingBody(req: express.Request): Buffer | undefined {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.rawBody) return req.rawBody;
  return undefined;
}

function bufferBody(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function incomingHeader(
  req: express.Request,
  name: string,
): string | undefined {
  const value = req.header(name);
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function officialClientUserAgent(value: string | undefined): string {
  // A desktop/browser client may provide a useful UA. Do not forward generic
  // curl/node/undici identifiers, since they make the proxy look like an
  // automated upstream client and defeat the Codex identity fallback.
  if (value && /codex|chatgpt|openai/i.test(value)) return value;
  return CODEX_CLI_USER_AGENT;
}

function upstreamHeaders(
  req: express.Request,
  account: Account,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${account.accessToken}`,
    accept: req.header("accept") || "application/sdp, application/json",
    originator: incomingHeader(req, "originator") ?? CODEX_CLI_ORIGINATOR,
    "User-Agent": officialClientUserAgent(incomingHeader(req, "user-agent")),
    version: incomingHeader(req, "version") ?? MODELS_CLIENT_VERSION,
  };
  const contentType = req.header("content-type");
  if (contentType) headers["content-type"] = contentType;
  if (account.chatgptAccountId) {
    headers["chatgpt-account-id"] = account.chatgptAccountId;
  }
  for (const name of CLIENT_IDENTITY_HEADERS) {
    const value = incomingHeader(req, name);
    if (value) headers[name] = value;
  }
  return headers;
}

function copyResponseHeaders(upstream: Response, res: express.Response) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  }
}

function contentTypeAccepted(req: express.Request): boolean {
  const contentType = String(req.header("content-type") ?? "").toLowerCase();
  return (
    contentType.startsWith("multipart/form-data;") ||
    contentType.startsWith("application/sdp")
  );
}

async function prepareAccount(
  account: Account,
  options: RealtimeProxyOptions,
): Promise<Account> {
  const prepared = await ensureValidToken(account, options.oauthConfig);
  if (prepared !== account) options.store.markAccountModified(prepared.id, prepared);
  return prepared;
}

function candidateAccounts(options: RealtimeProxyOptions): Account[] {
  return options.store
    .getCachedAccounts()
    .filter(
      (account) =>
        normalizeProvider(account) === options.provider && accountUsable(account),
    );
}

async function forwardRealtimeCall(
  req: express.Request,
  res: express.Response,
  options: RealtimeProxyOptions,
) {
  const startedAt = Date.now();
  const route = req.originalUrl || req.path;
  const application =
    typeof res.locals.proxyApplication === "string"
      ? res.locals.proxyApplication
      : undefined;
  const requestHeaders = TRACE_INCLUDE_HEADERS
    ? traceHeadersForRequest(req.headers)
    : undefined;
  const codexSessionId = extractCodexSessionId(req.headers);
  const projectAttribution = extractLiteLLMProjectAttribution(req.headers);
  const body = incomingBody(req);
  if (!contentTypeAccepted(req)) {
    return res.status(415).json({
      error: {
        message:
          "Realtime call Content-Type must be application/sdp or multipart/form-data",
        type: "invalid_request_error",
        code: "unsupported_media_type",
      },
    });
  }
  if (!body?.length) {
    return res.status(400).json({
      error: {
        message: "Realtime call requires an SDP or multipart body",
        type: "invalid_request_error",
        code: "missing_realtime_body",
      },
    });
  }
  const remaining = candidateAccounts(options);
  let lastStatus = 503;
  let lastError = "no eligible realtime account configured";

  while (remaining.length) {
    const selected = chooseAccountForProvider(remaining, options.provider);
    if (!selected) break;
    remaining.splice(
      remaining.findIndex((account) => account.id === selected.id),
      1,
    );
    let prepared = selected;
    try {
      prepared = await prepareAccount(selected, options);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
      let upstream: Response;
      let responseBody: Buffer;
      try {
        upstream = await fetch(realtimeCallUrl(prepared, options), {
          method: "POST",
          headers: upstreamHeaders(req, prepared),
          body: bufferBody(body),
          signal: controller.signal,
        });
        responseBody = Buffer.from(await upstream.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }

      const errorText = upstream.ok ? "" : responseBody.toString("utf8");
      lastStatus = upstream.status;
      lastError = errorText || `Realtime upstream returned ${upstream.status}`;

      if (!upstream.ok && isQuotaErrorText(`${upstream.status} ${errorText}`)) {
        markQuotaHit(prepared, "realtime", lastError);
        await options.store.upsertAccount(prepared);
        continue;
      }
      if (!upstream.ok && [401, 403, 500, 502, 503, 504].includes(upstream.status)) {
        rememberError(prepared, `realtime: ${lastError}`);
        await options.store.upsertAccount(prepared);
        continue;
      }

      res.status(upstream.status);
      copyResponseHeaders(upstream, res);
      res.send(responseBody);
      options.traceManager.recordTrace({
        ...projectAttribution,
        at: Date.now(),
        route,
        application,
        codexSessionId,
        requestHeaders,
        accountId: prepared.id,
        accountEmail: prepared.email,
        model: "realtime",
        status: upstream.status,
        stream: false,
        latencyMs: Date.now() - startedAt,
        upstreamContentType: upstream.headers.get("content-type") ?? undefined,
        error: upstream.ok ? undefined : lastError,
      });
      return;
    } catch (error: any) {
      lastStatus = error?.name === "AbortError" ? 504 : 502;
      lastError = error?.message ?? String(error);
      rememberError(prepared, `realtime: ${lastError}`);
      await options.store.upsertAccount(prepared);
    }
  }

  options.traceManager.recordTrace({
    ...projectAttribution,
    at: Date.now(),
    route,
    application,
    codexSessionId,
    requestHeaders,
    model: "realtime",
    status: lastStatus,
    stream: false,
    latencyMs: Date.now() - startedAt,
    error: lastError,
  });
  return res.status(lastStatus).json({
    error: {
      message: lastError,
      type: "upstream_error",
      code: "realtime_upstream_error",
    },
  });
}

async function forwardVoiceCatalog(
  req: express.Request,
  res: express.Response,
  options: RealtimeProxyOptions,
) {
  const startedAt = Date.now();
  const route = req.originalUrl || req.path;
  const application =
    typeof res.locals.proxyApplication === "string"
      ? res.locals.proxyApplication
      : undefined;
  const requestHeaders = TRACE_INCLUDE_HEADERS
    ? traceHeadersForRequest(req.headers)
    : undefined;
  const codexSessionId = extractCodexSessionId(req.headers);
  const projectAttribution = extractLiteLLMProjectAttribution(req.headers);
  const selected = chooseAccountForProvider(
    candidateAccounts({ ...options, provider: "openai" }),
    "openai",
  );
  if (!selected) {
    options.traceManager.recordTrace({
      ...projectAttribution,
      at: Date.now(),
      route,
      application,
      codexSessionId,
      requestHeaders,
      model: "realtime-voices",
      status: 503,
      stream: false,
      latencyMs: Date.now() - startedAt,
      error: "no eligible ChatGPT account configured for voice discovery",
    });
    return res.status(503).json({
      error: {
        message: "no eligible ChatGPT account configured for voice discovery",
        type: "service_unavailable",
        code: "voice_account_unavailable",
      },
    });
  }
  let prepared = selected;
  try {
    prepared = await prepareAccount(selected, options);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    let upstream: Response;
    let body: Buffer;
    try {
      upstream = await fetch(realtimeVoicesUrl(options.chatgptBaseUrl, req), {
        headers: upstreamHeaders(req, prepared),
        signal: controller.signal,
      });
      body = Buffer.from(await upstream.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
    const error = upstream.ok ? undefined : body.toString("utf8");
    options.traceManager.recordTrace({
      ...projectAttribution,
      at: Date.now(),
      route,
      application,
      codexSessionId,
      requestHeaders,
      accountId: prepared.id,
      accountEmail: prepared.email,
      model: "realtime-voices",
      status: upstream.status,
      stream: false,
      latencyMs: Date.now() - startedAt,
      upstreamContentType: upstream.headers.get("content-type") ?? undefined,
      error,
    });
    res.status(upstream.status);
    copyResponseHeaders(upstream, res);
    return res.send(body);
  } catch (error: any) {
    const status = error?.name === "AbortError" ? 504 : 502;
    const message = error?.message ?? String(error);
    rememberError(prepared, `realtime voices: ${message}`);
    await options.store.upsertAccount(prepared);
    options.traceManager.recordTrace({
      ...projectAttribution,
      at: Date.now(),
      route,
      application,
      codexSessionId,
      requestHeaders,
      accountId: prepared.id,
      accountEmail: prepared.email,
      model: "realtime-voices",
      status,
      stream: false,
      latencyMs: Date.now() - startedAt,
      error: message,
    });
    return res.status(status).json({
      error: {
        message,
        type: "upstream_error",
        code: "voice_discovery_upstream_error",
      },
    });
  }
}

export function createRealtimeRouter(options: RealtimeProxyOptions) {
  const router = express.Router();
  const rawBody = express.raw({
    type: ["application/sdp", "multipart/form-data"],
    limit: "2mb",
  });

  router.post("/realtime/calls", rawBody, (req, res, next) => {
    res.locals._multivibeTraced = true;
    forwardRealtimeCall(req, res, options).catch(next);
  });
  router.get(["/realtime/voices", "/settings/voices"], (req, res, next) => {
    res.locals._multivibeTraced = true;
    forwardVoiceCatalog(req, res, options).catch(next);
  });
  return router;
}
