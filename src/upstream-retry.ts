import {
  MAX_UPSTREAM_RETRIES,
  UPSTREAM_BASE_DELAY_MS,
  UPSTREAM_REQUEST_TIMEOUT_MS,
  UPSTREAM_TOTAL_TIMEOUT_MS,
} from "./config.js";
import { isQuotaErrorText } from "./quota.js";
import { combineAbortSignals, createTimeoutSignal } from "./network.js";

type UpstreamRetryRuntime = {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  maxRetries?: number;
  baseDelayMs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  nowFn?: () => number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function shouldRetryUpstreamOnSameAccount(
  status: number,
  errorText: string,
): boolean {
  // Quota and rate-limit responses must return to the account router
  // immediately. Retrying the same blocked account delays the documented
  // account rotation and cannot restore quota.
  if (status === 429 || isQuotaErrorText(errorText)) return false;
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

export async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  runtime: UpstreamRetryRuntime = {},
): Promise<Response> {
  const fetchFn = runtime.fetchFn ?? fetch;
  const sleepFn = runtime.sleepFn ?? sleep;
  const randomFn = runtime.randomFn ?? Math.random;
  const maxRetries = runtime.maxRetries ?? MAX_UPSTREAM_RETRIES;
  const baseDelayMs = runtime.baseDelayMs ?? UPSTREAM_BASE_DELAY_MS;
  const requestTimeoutMs = runtime.requestTimeoutMs ?? UPSTREAM_REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = runtime.totalTimeoutMs ?? UPSTREAM_TOTAL_TIMEOUT_MS;
  const nowFn = runtime.nowFn ?? Date.now;
  const deadline = nowFn() + totalTimeoutMs;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) {
      throw new DOMException("upstream retry deadline exceeded", "TimeoutError");
    }
    try {
      const attemptTimeout = createTimeoutSignal(
        Math.max(1, Math.ceil(Math.min(requestTimeoutMs, remainingMs))),
      );
      let response: Response;
      try {
        response = await fetchFn(url, {
          ...init,
          signal: combineAbortSignals([
            init.signal ?? undefined,
            attemptTimeout.signal,
          ]),
        });
      } finally {
        attemptTimeout.cancel();
      }
      if (response.ok) return response;
      const errorText = await response
        .clone()
        .text()
        .catch(() => "");
      if (
        attempt < maxRetries &&
        shouldRetryUpstreamOnSameAccount(response.status, errorText)
      ) {
        const retryAfter = parseRetryAfter(response);
        const backoff = baseDelayMs * 2 ** attempt;
        const jitter = randomFn() * 500;
        const delay = Math.max(retryAfter ?? 0, backoff) + jitter;
        if (delay >= deadline - nowFn()) {
          throw new DOMException("upstream retry deadline exceeded", "TimeoutError");
        }
        await sleepFn(delay);
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt < maxRetries &&
        !isQuotaErrorText(lastError.message)
      ) {
        if (init.signal?.aborted) throw lastError;
        const backoff = baseDelayMs * 2 ** attempt;
        const jitter = randomFn() * 500;
        const delay = backoff + jitter;
        if (delay >= deadline - nowFn()) throw lastError;
        await sleepFn(delay);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("failed after retries");
}
