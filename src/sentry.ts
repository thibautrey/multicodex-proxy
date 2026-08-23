import * as Sentry from "@sentry/node";

/**
 * Initialise Sentry as early as possible in the process lifecycle.
 * The SDK is a no-op when SENTRY_DSN is unset, so local dev and tests are unaffected.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.APP_VERSION,
    // Sample all errors; tune performance sampling via env (default 10%).
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    integrations: [
      // HTTP + Express tracing instrumentation (incoming/outgoing requests).
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      // Native Node-level error capture (uncaughtException / unhandledRejection).
      Sentry.nodeContextIntegration(),
    ],
    // Drop noisy health-check and static-asset transactions from performance data.
    ignoreTransactions: [
      /^GET \/health$/,
      /^GET \/favicon\.ico$/,
      /^GET \/assets\//,
    ],
  });
}
