import type { ServerResponse } from "node:http";
import {
  AUXILIARY_REQUEST_TIMEOUT_MS,
  UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
} from "./config.js";

export function combineAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("operation timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = AUXILIARY_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: combineAbortSignals([init.signal ?? undefined, timeout.signal]),
    });
  } finally {
    timeout.cancel();
  }
}

export async function fetchTextWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = AUXILIARY_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; text: string }> {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: combineAbortSignals([init.signal ?? undefined, timeout.signal]),
    });
    return { response, text: await response.text() };
  } finally {
    timeout.cancel();
  }
}

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs = UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw signal.reason ?? new Error("request aborted");
  const timeout = createTimeoutSignal(idleTimeoutMs);
  const combined = combineAbortSignals([signal, timeout.signal]);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(combined?.reason).catch(() => undefined);
      reject(combined?.reason ?? new Error("stream read timed out"));
    };
    combined?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      combined?.removeEventListener("abort", onAbort);
      timeout.cancel();
    });
  });
}

export async function writeWithBackpressure(
  response: ServerResponse,
  chunk: string | Uint8Array,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}
