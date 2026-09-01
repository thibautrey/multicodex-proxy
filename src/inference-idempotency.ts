import { createHash } from "node:crypto";
import express from "express";

export const INFERENCE_IDEMPOTENCY_STATUS_HEADER =
  "X-MultiVibe-Idempotency-Status";

export type InferenceIdempotencyOptions = {
  ttlMs: number;
  inFlightTimeoutMs: number;
  maxEntries: number;
  maxBytes: number;
  maxResponseBytes: number;
  now?: () => number;
};

type StoredResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

type InFlightEntry = {
  state: "in-flight";
  scope: string;
  requestHash: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<StoredResponse | undefined>;
  resolve: (result: StoredResponse | undefined) => void;
};

type CompletedEntry = {
  state: "completed";
  scope: string;
  requestHash: string;
  expiresAt: number;
  response: StoredResponse;
  size: number;
};

type SeenEntry = {
  state: "seen";
  scope: string;
  requestHash: string;
  expiresAt: number;
};

type Entry = InFlightEntry | CompletedEntry | SeenEntry;

export type InferenceIdempotencyClaim =
  | { kind: "leader"; entry: InFlightEntry }
  | { kind: "follower"; promise: Promise<StoredResponse | undefined> }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "conflict" }
  | { kind: "bypass" };

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .filter((key) => typeof object[key] !== "undefined")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashInferencePayload(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("base64url");
}

function semanticRequestHeaders(req: express.Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
    "session_id",
    "session-id",
    "x-session-id",
    "x-session_id",
    "thread-id",
    "x-codex-turn-state",
  ]) {
    const value = req.header(name)?.trim();
    if (value) headers[name] = value;
  }
  return headers;
}

function hashInferenceRequest(req: express.Request): string {
  return hashInferencePayload({
    body: req.body,
    headers: semanticRequestHeaders(req),
  });
}

function normalizedRoute(path: string): string | undefined {
  const route = path.replace(/^\/v1(?=\/)/, "");
  return route === "/responses" ||
    route === "/chat/completions" ||
    route === "/messages"
    ? route
    : undefined;
}

function containsUnsafeRequestContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeRequestContent(item));
  }
  if (!value || typeof value !== "object") return false;

  const object = value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type.toLowerCase() : "";
  if (
    type &&
    /(image|audio|file|function|custom_tool|computer|web_search|mcp|reasoning|compaction)/.test(
      type,
    )
  ) {
    return true;
  }
  if (object.role === "tool" || object.role === "function") return true;

  for (const key of [
    "image_url",
    "input_audio",
    "audio",
    "file_id",
    "file_data",
    "attachments",
    "tool_calls",
    "function_call",
  ]) {
    const candidate = object[key];
    if (
      candidate !== undefined &&
      candidate !== null &&
      (!Array.isArray(candidate) || candidate.length > 0)
    ) {
      return true;
    }
  }

  return Object.values(object).some((item) =>
    containsUnsafeRequestContent(item),
  );
}

export function isEligibleInferenceIdempotencyBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const payload = body as Record<string, unknown>;
  if (payload.stream === true || payload.background === true) return false;
  if (payload.previous_response_id != null || payload.conversation != null) {
    return false;
  }
  if (payload.store === true) return false;
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return false;
  if (Array.isArray(payload.functions) && payload.functions.length > 0) {
    return false;
  }
  if (
    payload.tool_choice != null &&
    payload.tool_choice !== "none" &&
    payload.tool_choice !== "auto"
  ) {
    return false;
  }
  if (
    Array.isArray(payload.modalities) &&
    payload.modalities.some((modality) => modality !== "text")
  ) {
    return false;
  }
  return !containsUnsafeRequestContent(payload);
}

function containsUnsafeResponseContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeResponseContent(item));
  }
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type.toLowerCase() : "";
  if (
    type &&
    /(function|custom_tool|computer|web_search|mcp|reasoning|compaction)/.test(type)
  ) {
    return true;
  }
  if (
    (Array.isArray(object.tool_calls) && object.tool_calls.length > 0) ||
    object.function_call != null ||
    object.encrypted_content != null ||
    object.finish_reason === "tool_calls"
  ) {
    return true;
  }
  return Object.values(object).some((item) =>
    containsUnsafeResponseContent(item),
  );
}

function isJsonContentType(value: string | undefined): boolean {
  return Boolean(value?.toLowerCase().includes("json"));
}

function isCacheableCompletedResponse(result: StoredResponse): boolean {
  if (result.status < 200 || result.status >= 300 || result.status === 202) {
    return false;
  }
  if (!isJsonContentType(result.headers["content-type"])) return false;

  let parsed: any;
  try {
    parsed = JSON.parse(result.body.toString("utf8"));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.error || parsed.incomplete_details) return false;
  if (
    typeof parsed.status === "string" &&
    ["failed", "incomplete", "in_progress", "queued", "cancelled"].includes(
      parsed.status,
    )
  ) {
    return false;
  }
  return !containsUnsafeResponseContent(parsed);
}

function responseBodyBuffer(body: unknown): Buffer | undefined {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (body === undefined) return undefined;
  try {
    return Buffer.from(JSON.stringify(body));
  } catch {
    return undefined;
  }
}

function shouldReplayHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "content-type" ||
    normalized === "request-id" ||
    normalized === "openai-request-id" ||
    normalized === "anthropic-request-id" ||
    (normalized.startsWith("x-multivibe-") &&
      normalized !== INFERENCE_IDEMPOTENCY_STATUS_HEADER.toLowerCase())
  );
}

function capturedResponseHeaders(res: express.Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of res.getHeaderNames()) {
    if (!shouldReplayHeader(name)) continue;
    const value = res.getHeader(name);
    if (typeof value === "string" || typeof value === "number") {
      headers[name.toLowerCase()] = String(value);
    } else if (Array.isArray(value)) {
      headers[name.toLowerCase()] = value.map(String).join(", ");
    }
  }
  return headers;
}

function sendStoredResponse(
  res: express.Response,
  result: StoredResponse,
  status: "coalesced" | "replayed",
) {
  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value);
  }
  res.setHeader(INFERENCE_IDEMPOTENCY_STATUS_HEADER, status);
  res.status(result.status).send(Buffer.from(result.body));
}

function sendIdempotencyError(
  res: express.Response,
  route: string,
  status: number,
  code: string,
  message: string,
) {
  if (route === "/messages") {
    return res.status(status).json({
      type: "error",
      error: { type: "invalid_request_error", message },
    });
  }
  return res.status(status).json({
    error: { message, type: "invalid_request_error", code },
  });
}

export class InferenceIdempotencyCache {
  private readonly entries = new Map<string, Entry>();
  private completedBytes = 0;
  private readonly now: () => number;

  constructor(private readonly options: InferenceIdempotencyOptions) {
    this.now = options.now ?? Date.now;
  }

  private remove(scope: string, entry: Entry, resolveInFlight = false) {
    if (this.entries.get(scope) !== entry) return;
    this.entries.delete(scope);
    if (entry.state === "completed") {
      this.completedBytes = Math.max(0, this.completedBytes - entry.size);
    } else if (entry.state === "in-flight") {
      clearTimeout(entry.timer);
      if (resolveInFlight) entry.resolve(undefined);
    }
  }

  private evictExpired(now: number) {
    for (const [scope, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(scope, entry, true);
    }
  }

  private evictOldestRetained(exclude?: Entry): boolean {
    for (const [scope, entry] of this.entries) {
      if (entry !== exclude && entry.state !== "in-flight") {
        this.remove(scope, entry);
        return true;
      }
    }
    return false;
  }

  private makeEntryRoom(): boolean {
    while (this.entries.size >= this.options.maxEntries) {
      if (!this.evictOldestRetained()) return false;
    }
    return true;
  }

  claim(scope: string, requestHash: string): InferenceIdempotencyClaim {
    const now = this.now();
    this.evictExpired(now);
    const existing = this.entries.get(scope);
    if (existing) {
      if (existing.requestHash !== requestHash) return { kind: "conflict" };
      if (existing.state === "completed") {
        this.entries.delete(scope);
        this.entries.set(scope, existing);
        return { kind: "replay", response: existing.response };
      }
      if (existing.state === "seen") {
        this.entries.delete(scope);
      } else {
        return { kind: "follower", promise: existing.promise };
      }
    }
    if (!this.makeEntryRoom()) return { kind: "bypass" };

    let resolve!: (result: StoredResponse | undefined) => void;
    const promise = new Promise<StoredResponse | undefined>((done) => {
      resolve = done;
    });
    let entry!: InFlightEntry;
    const timer = setTimeout(() => {
      this.remove(scope, entry, true);
    }, this.options.inFlightTimeoutMs);
    timer.unref?.();
    entry = {
      state: "in-flight",
      scope,
      requestHash,
      expiresAt: now + this.options.inFlightTimeoutMs,
      timer,
      promise,
      resolve,
    };
    this.entries.set(scope, entry);
    return { kind: "leader", entry };
  }

  complete(entry: InFlightEntry, response: StoredResponse) {
    clearTimeout(entry.timer);
    const cacheable =
      response.body.byteLength <= this.options.maxResponseBytes &&
      response.body.byteLength <= this.options.maxBytes &&
      isCacheableCompletedResponse(response);

    if (this.entries.get(entry.scope) === entry) {
      this.entries.delete(entry.scope);
      if (cacheable) {
        while (
          this.completedBytes + response.body.byteLength >
          this.options.maxBytes
        ) {
          if (!this.evictOldestRetained(entry)) break;
        }
        if (
          this.completedBytes + response.body.byteLength <=
          this.options.maxBytes
        ) {
          const completed: CompletedEntry = {
            state: "completed",
            scope: entry.scope,
            requestHash: entry.requestHash,
            response,
            size: response.body.byteLength,
            expiresAt: this.now() + this.options.ttlMs,
          };
          this.entries.set(entry.scope, completed);
          this.completedBytes += completed.size;
        } else {
          this.entries.set(entry.scope, {
            state: "seen",
            scope: entry.scope,
            requestHash: entry.requestHash,
            expiresAt: this.now() + this.options.ttlMs,
          });
        }
      } else {
        this.entries.set(entry.scope, {
          state: "seen",
          scope: entry.scope,
          requestHash: entry.requestHash,
          expiresAt: this.now() + this.options.ttlMs,
        });
      }
    }
    entry.resolve(response);
  }

  fail(entry: InFlightEntry) {
    clearTimeout(entry.timer);
    if (this.entries.get(entry.scope) === entry) {
      this.entries.delete(entry.scope);
      this.entries.set(entry.scope, {
        state: "seen",
        scope: entry.scope,
        requestHash: entry.requestHash,
        expiresAt: this.now() + this.options.ttlMs,
      });
    }
    entry.resolve(undefined);
  }

  size(): number {
    this.evictExpired(this.now());
    return this.entries.size;
  }

  bytes(): number {
    this.evictExpired(this.now());
    return this.completedBytes;
  }
}

export function createInferenceIdempotencyMiddleware(
  options: InferenceIdempotencyOptions,
): express.RequestHandler {
  const cache = new InferenceIdempotencyCache(options);

  return async (req, res, next) => {
    if (req.method !== "POST") return next();
    const route = normalizedRoute(req.path);
    if (!route) return next();

    const rawKey = req.header("x-multivibe-idempotency-key");
    const key = rawKey?.trim();
    if (!key) return next();
    if (key.length > 200) {
      return sendIdempotencyError(
        res,
        route,
        400,
        "invalid_idempotency_key",
        "X-MultiVibe-Idempotency-Key is too long",
      );
    }
    if (
      req.header("x-multivibe-execution") === "defer" ||
      req.header("x-multivibe-internal-job") === "1"
    ) {
      return next();
    }

    const application =
      typeof res.locals.proxyApplication === "string"
        ? res.locals.proxyApplication
        : undefined;
    let eligible = false;
    try {
      eligible = isEligibleInferenceIdempotencyBody(req.body);
    } catch {
      eligible = false;
    }
    if (!application || !eligible) {
      res.setHeader(INFERENCE_IDEMPOTENCY_STATUS_HEADER, "bypass");
      return next();
    }

    const scope = `${application}\u0000${route}\u0000${key}`;
    let requestHash: string;
    try {
      requestHash = hashInferenceRequest(req);
    } catch {
      res.setHeader(INFERENCE_IDEMPOTENCY_STATUS_HEADER, "bypass");
      return next();
    }
    const claim = cache.claim(scope, requestHash);
    if (claim.kind === "conflict") {
      return sendIdempotencyError(
        res,
        route,
        409,
        "idempotency_key_reused",
        "This idempotency key was already used with a different request payload.",
      );
    }
    if (claim.kind === "replay") {
      return sendStoredResponse(res, claim.response, "replayed");
    }
    if (claim.kind === "follower") {
      const response = await claim.promise;
      if (res.writableEnded || res.destroyed) return;
      if (response) return sendStoredResponse(res, response, "coalesced");
      res.setHeader(INFERENCE_IDEMPOTENCY_STATUS_HEADER, "bypass");
      return next();
    }
    if (claim.kind === "bypass") {
      res.setHeader(INFERENCE_IDEMPOTENCY_STATUS_HEADER, "bypass");
      return next();
    }

    res.setHeader(INFERENCE_IDEMPOTENCY_STATUS_HEADER, "created");
    let capturedBody: Buffer | undefined;
    let settled = false;
    const originalSend = res.send.bind(res);
    (res as any).send = (body: unknown) => {
      capturedBody = responseBodyBuffer(body);
      return originalSend(body);
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      if (!capturedBody) {
        cache.fail(claim.entry);
        return;
      }
      cache.complete(claim.entry, {
        status: res.statusCode,
        headers: capturedResponseHeaders(res),
        body: capturedBody,
      });
    };
    res.once("finish", settle);
    res.once("close", () => {
      if (!res.writableFinished && !settled) {
        settled = true;
        cache.fail(claim.entry);
      }
    });
    next();
  };
}
