/**
 * Sentry preload module. Must be loaded via `node --import ./dist/instrument.js`
 * BEFORE the main application so OpenTelemetry can patch Express, http, etc.
 * at import time. This file should have no side effects beyond Sentry init.
 *
 * The SDK is a no-op when SENTRY_DSN is unset, so local dev is unaffected.
 */
import { initSentry } from "./sentry.js";

initSentry();
