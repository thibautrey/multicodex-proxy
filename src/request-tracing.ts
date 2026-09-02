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

export const REQUEST_TRACE_PARENT_HEADER = "x-multivibe-trace-parent";

export type RequestTraceContext = {
  clientRequestId: string;
  providerAttempts: number;
  sawFailedProviderAttempt: boolean;
  clientOutcomeStatus?: number;
};

const activeRequestTraceContexts = new Map<string, RequestTraceContext>();

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
    const requestedParentId = req.header(REQUEST_TRACE_PARENT_HEADER);
    const parentContext = requestedParentId
      ? activeRequestTraceContexts.get(requestedParentId)
      : undefined;
    const nestedInferenceRequest = inferenceRequest && Boolean(parentContext);

    if (inferenceRequest) {
      const requestTraceContext: RequestTraceContext =
        parentContext ?? {
          clientRequestId: crypto.randomUUID(),
          providerAttempts: 0,
          sawFailedProviderAttempt: false,
        };
      res.locals.multivibeRequestTraceContext = requestTraceContext;
      res.locals.multivibeClientRequestId = requestTraceContext.clientRequestId;
      if (!parentContext) {
        activeRequestTraceContexts.set(
          requestTraceContext.clientRequestId,
          requestTraceContext,
        );
      }
    }
    // Evaluate this before mounted routers can rewrite req.url/req.path. Hidden
    // control-plane traffic should neither consume recent-trace retention nor
    // grow the long-term stats file.
    if (isHiddenTraceRoute(traceRoute)) return next();

    let settled = false;
    const recordClientOutcome = (status: number) => {
      if (settled) return;
      settled = true;
      if (nestedInferenceRequest) return;
      if (res.locals._multivibeTraced && !inferenceRequest) return;
      const requestTraceContext = res.locals.multivibeRequestTraceContext as
        | RequestTraceContext
        | undefined;
      if (requestTraceContext) {
        activeRequestTraceContexts.delete(requestTraceContext.clientRequestId);
      }
      const providerAttempts = requestTraceContext
        ? requestTraceContext.providerAttempts
        : Number.isFinite(res.locals.multivibeProviderAttempts)
          ? Math.max(0, Math.floor(res.locals.multivibeProviderAttempts))
          : 0;
      const contextualOutcomeStatus = requestTraceContext?.clientOutcomeStatus;
      const localOutcomeStatus = res.locals.multivibeClientOutcomeStatus;
      const clientOutcomeStatus =
        status === 499
          ? status
          : typeof contextualOutcomeStatus === "number" &&
              Number.isFinite(contextualOutcomeStatus)
            ? contextualOutcomeStatus
            : typeof localOutcomeStatus === "number" &&
                Number.isFinite(localOutcomeStatus)
              ? localOutcomeStatus
              : status;

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
          Boolean(
            requestTraceContext?.sawFailedProviderAttempt ??
              res.locals.multivibeSawFailedProviderAttempt,
          ) &&
          clientOutcomeStatus < 400,
        application: res.locals.proxyApplication,
        codexSessionId: extractCodexSessionId(req.headers),
        requestHeaders: includeHeaders
          ? traceHeadersForRequest(req.headers)
          : undefined,
        status: clientOutcomeStatus,
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
