import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import {
  createRequestTracingMiddleware,
  REQUEST_TRACE_PARENT_HEADER,
} from "./request-tracing.js";

function request(
  port: number,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("request tracing drops control traffic before mounted routers rewrite paths", async (t) => {
  const traces: any[] = [];
  const app = express();
  app.use(
    createRequestTracingMiddleware({
      traceManager: { recordTrace: (entry: any) => traces.push(entry) } as any,
      includeBody: false,
      includeHeaders: false,
    }),
  );
  app.use("/admin", (_req, res) => res.json({ ok: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/v1/models", (_req, res) => res.json({ data: [] }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  assert.equal(await request(address.port, "/admin/stats/traces"), 200);
  assert.equal(await request(address.port, "/health"), 200);
  assert.equal(await request(address.port, "/v1/models"), 200);
  assert.deepEqual(traces, []);
});

test("request tracing records one final client outcome beside provider attempts", async (t) => {
  const traces: any[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createRequestTracingMiddleware({
      traceManager: { recordTrace: (entry: any) => traces.push(entry) } as any,
      includeBody: false,
      includeHeaders: false,
    }),
  );
  app.post("/v1/responses", (_req, res) => {
    res.locals._multivibeTraced = true;
    res.locals.proxyApplication = "test-app";
    const context = res.locals.multivibeRequestTraceContext;
    context.providerAttempts = 2;
    context.sawFailedProviderAttempt = true;
    res.status(200).json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  assert.equal(
    await request(address.port, "/v1/responses", "POST", {
      model: "test",
      stream: false,
    }),
    200,
  );
  assert.equal(traces.length, 1);
  assert.equal(traces[0].route, "POST /v1/responses");
  assert.equal(traces[0].traceKind, "client-request");
  assert.equal(typeof traces[0].clientRequestId, "string");
  assert.equal(traces[0].providerAttempts, 2);
  assert.equal(traces[0].recoveredRetry, true);
  assert.equal(traces[0].application, "test-app");
  assert.equal(traces[0].status, 200);
});
test("request tracing collapses a nested inference request into its parent outcome", async (t) => {
  const traces: any[] = [];
  const app = express();
  let port = 0;
  app.use(express.json());
  app.use(
    createRequestTracingMiddleware({
      traceManager: { recordTrace: (entry: any) => traces.push(entry) } as any,
      includeBody: false,
      includeHeaders: false,
    }),
  );
  app.post("/v1/responses", (_req, res) => {
    const context = res.locals.multivibeRequestTraceContext;
    context.providerAttempts = 2;
    context.sawFailedProviderAttempt = true;
    res.status(200).json({ ok: true });
  });
  app.post("/v1/messages", async (_req, res) => {
    const parentId = res.locals.multivibeClientRequestId;
    const status = await request(
      port,
      "/v1/responses",
      "POST",
      { model: "test" },
      { [REQUEST_TRACE_PARENT_HEADER]: parentId },
    );
    res.status(status).json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  port = address.port;

  assert.equal(
    await request(port, "/v1/messages", "POST", { model: "test" }),
    200,
  );
  assert.equal(traces.length, 1);
  assert.equal(traces[0].route, "POST /v1/messages");
  assert.equal(traces[0].traceKind, "client-request");
  assert.equal(traces[0].providerAttempts, 2);
  assert.equal(traces[0].recoveredRetry, true);
});

test("request tracing records a logical stream failure after HTTP 200 is committed", async (t) => {
  const traces: any[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createRequestTracingMiddleware({
      traceManager: { recordTrace: (entry: any) => traces.push(entry) } as any,
      includeBody: false,
      includeHeaders: false,
    }),
  );
  app.post("/v1/responses", (_req, res) => {
    res.status(200).write("data: stream-started\n\n");
    res.locals.multivibeRequestTraceContext.clientOutcomeStatus = 429;
    res.end("data: stream-failed\n\n");
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  assert.equal(
    await request(address.port, "/v1/responses", "POST", {
      model: "test",
      stream: true,
    }),
    200,
  );
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, 429);
  assert.equal(traces[0].traceKind, "client-request");
});
