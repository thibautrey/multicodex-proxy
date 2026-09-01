import crypto from "node:crypto";
import type express from "express";
import {
  extractCodexProjectHost,
  extractCodexProjectRoot,
  extractCodexSessionId,
  extractLiteLLMProjectAttribution,
} from "./codex-projects.js";
import { traceHeadersForRequest } from "./trace-headers.js";
import {
  isHiddenTraceRoute,
  isInferenceTraceRoute,
  type TraceManager,
} from "./traces.js";

export function createRequestTracingMiddleware(options: {
  traceManager: Pick<TraceManager, "recordTrace">;
  includeBody: boolean;
  includeHeaders: boolean;
}): express.RequestHandler {
  const { traceManager, includeBody, includeHeaders } = options;

  return (req, res, next) => {
    const startedAt = Date.now();
    const route = req.originalUrl || req.url;
    const traceRoute = `${req.method} ${route}`;
    const inferenceRequest = isInferenceTraceRoute(traceRoute);

    if (inferenceRequest) {
      res.locals.multivibeClientRequestId ??= crypto.randomUUID();
    }
    // Evaluate this before mounted routers can rewrite req.url/req.path. Hidden
    // control-plane traffic should neither consume recent-trace retention nor
    // grow the long-term stats file.
    if (isHiddenTraceRoute(traceRoute)) return next();

    let settled = false;
    const recordClientOutcome = (status: number) => {
      if (settled) return;
      settled = true;
      if (res.locals._multivibeTraced && !inferenceRequest) return;
      const providerAttempts = Number.isFinite(
        res.locals.multivibeProviderAttempts,
      )
        ? Math.max(0, Math.floor(res.locals.multivibeProviderAttempts))
        : 0;

      traceManager.recordTrace({
        ...(res.locals.multivibeTrace ?? {}),
        ...extractLiteLLMProjectAttribution(req.headers),
        codexProjectHost: extractCodexProjectHost(req.headers),
        codexProjectRoot: extractCodexProjectRoot(req.headers),
        at: Date.now(),
        route: traceRoute,
        clientRequestId: res.locals.multivibeClientRequestId,
        traceKind: inferenceRequest ? "client-request" : "diagnostic",
        providerAttempts,
        recoveredRetry:
          inferenceRequest &&
          Boolean(res.locals.multivibeSawFailedProviderAttempt) &&
          status < 400,
        application: res.locals.proxyApplication,
        codexSessionId: extractCodexSessionId(req.headers),
        requestHeaders: includeHeaders
          ? traceHeadersForRequest(req.headers)
          : undefined,
        status,
        stream: inferenceRequest && Boolean(req.body?.stream),
        latencyMs: Date.now() - startedAt,
        requestBody: includeBody ? req.body : undefined,
      });
    };

    res.once("finish", () => recordClientOutcome(res.statusCode));
    res.once("close", () => {
      if (!res.writableFinished) recordClientOutcome(499);
    });

    next();
  };
}
