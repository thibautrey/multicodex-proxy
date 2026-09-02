import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import {
  installResponsesWebsocketProxy,
  websocketRequestUrl,
  WebSocketDeliveryQueue,
} from "./websocket-responses.js";

type JsonFrame = {
  type?: string;
  error?: { code?: string; message?: string };
};

test("uses the local server for websocket loopback requests", () => {
  const request = {
    headers: { host: "external.example:1456" },
  } as http.IncomingMessage;

  assert.equal(
    websocketRequestUrl(request, 1455, "/v1/responses").href,
    "http://localhost:1455/v1/responses",
  );
});

class FakeDeliveryWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  terminated = false;
  readonly callbacks: Array<(error?: Error) => void> = [];

  send(_payload: string, callback: (error?: Error) => void) {
    this.callbacks.push(callback);
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  completeNext(error?: Error) {
    const callback = this.callbacks.shift();
    assert.ok(callback, "expected a pending websocket delivery");
    callback(error);
  }
}

function deliveryQueue(
  ws: FakeDeliveryWebSocket,
  onFailure: (error: Error) => void,
  options: ConstructorParameters<typeof WebSocketDeliveryQueue>[2] = {},
) {
  return new WebSocketDeliveryQueue(
    ws as unknown as WebSocket,
    onFailure,
    options,
  );
}

test("bounds pending websocket delivery bytes without using socket buffers", async () => {
  const ws = new FakeDeliveryWebSocket();
  const failures: Error[] = [];
  const queue = deliveryQueue(ws, (error) => failures.push(error), {
    deliveryTimeoutMs: 10_000,
    maxBufferedAmountBytes: 100,
    maxPendingBytes: 10,
    maxPendingDeliveries: 10,
  });

  queue.send("123456");
  assert.throws(() => queue.send("12345"), /backlog exceeded 10 bytes/);
  await assert.rejects(queue.flush(), /backlog exceeded 10 bytes/);

  assert.equal(ws.callbacks.length, 1);
  assert.equal(ws.terminated, true);
  assert.equal(failures.length, 1);
  queue.dispose();
});

test("bounds the number of unresolved websocket delivery promises", async () => {
  const ws = new FakeDeliveryWebSocket();
  const failures: Error[] = [];
  const queue = deliveryQueue(ws, (error) => failures.push(error), {
    deliveryTimeoutMs: 10_000,
    maxBufferedAmountBytes: 100,
    maxPendingBytes: 100,
    maxPendingDeliveries: 1,
  });

  queue.send("a");
  assert.throws(() => queue.send("b"), /or 1 messages/);
  await assert.rejects(queue.flush(), /or 1 messages/);

  assert.equal(ws.callbacks.length, 1);
  assert.equal(ws.terminated, true);
  assert.equal(failures.length, 1);
  queue.dispose();
});

test("bounds websocket bufferedAmount before enqueueing a delivery", async () => {
  const ws = new FakeDeliveryWebSocket();
  ws.bufferedAmount = 8;
  const failures: Error[] = [];
  const queue = deliveryQueue(ws, (error) => failures.push(error), {
    deliveryTimeoutMs: 10_000,
    maxBufferedAmountBytes: 10,
    maxPendingBytes: 100,
    maxPendingDeliveries: 10,
  });

  assert.throws(() => queue.send("abc"), /buffered amount exceeded 10 bytes/);
  await assert.rejects(queue.flush(), /buffered amount exceeded 10 bytes/);

  assert.equal(ws.callbacks.length, 0);
  assert.equal(ws.terminated, true);
  assert.equal(failures.length, 1);
  queue.dispose();
});

test("times out a stalled websocket delivery and rejects all pending work", async () => {
  const ws = new FakeDeliveryWebSocket();
  const failures: Error[] = [];
  const queue = deliveryQueue(ws, (error) => failures.push(error), {
    deliveryTimeoutMs: 10,
    maxBufferedAmountBytes: 100,
    maxPendingBytes: 100,
    maxPendingDeliveries: 10,
  });

  queue.send("first");
  queue.send("second");
  await assert.rejects(queue.flush(), /delivery timed out after 10ms/);

  assert.equal(ws.terminated, true);
  assert.equal(failures.length, 1);
  queue.dispose();
});

test("an abort settles stalled deliveries without waiting for their timeout", async () => {
  const ws = new FakeDeliveryWebSocket();
  const controller = new AbortController();
  const failures: Error[] = [];
  const queue = deliveryQueue(ws, (error) => failures.push(error), {
    deliveryTimeoutMs: 10_000,
    maxBufferedAmountBytes: 100,
    maxPendingBytes: 100,
    maxPendingDeliveries: 10,
    signal: controller.signal,
  });

  queue.send("pending");
  controller.abort(new Error("outer websocket closed"));
  await assert.rejects(queue.flush(), /outer websocket closed/);

  assert.equal(ws.terminated, false);
  assert.equal(failures.length, 1);
  queue.dispose();
});

test("successful delivery callbacks release queue capacity", async () => {
  const ws = new FakeDeliveryWebSocket();
  const failures: Error[] = [];
  const queue = deliveryQueue(ws, (error) => failures.push(error), {
    deliveryTimeoutMs: 10_000,
    maxBufferedAmountBytes: 100,
    maxPendingBytes: 5,
    maxPendingDeliveries: 1,
  });

  queue.send("12345");
  ws.completeNext();
  await queue.flush();
  queue.send("abcde");
  ws.completeNext();
  await queue.flush();

  assert.equal(ws.terminated, false);
  assert.deepEqual(failures, []);
  queue.dispose();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) =>
    server.listen(0, "localhost", resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function startProxy(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  const port = await listen(server);
  installResponsesWebsocketProxy({ server, port });
  return { server, port };
}

async function openWebsocket(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}/v1/responses`);
  await once(ws, "open");
  ws.on("error", () => undefined);
  return ws;
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function recordFrames(ws: WebSocket) {
  const frames: JsonFrame[] = [];
  ws.on("message", (message) => {
    frames.push(JSON.parse(message.toString()) as JsonFrame);
  });
  return frames;
}

async function waitForFrame(
  ws: WebSocket,
  frames: JsonFrame[],
  predicate: (frame: JsonFrame) => boolean,
) {
  const existing = frames.find(predicate);
  if (existing) return existing;

  return withTimeout(
    new Promise<JsonFrame>((resolve, reject) => {
      const cleanup = () => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
      };
      const onMessage = (message: RawData) => {
        const frame = JSON.parse(message.toString()) as JsonFrame;
        if (!predicate(frame)) return;
        cleanup();
        resolve(frame);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("websocket closed before the expected frame"));
      };
      ws.on("message", onMessage);
      ws.once("close", onClose);
    }),
    "websocket response frame",
  );
}

function sendResponseCreate(ws: WebSocket) {
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "test-model",
      input: [{ role: "user", content: "test" }],
    }),
  );
}

function writeSse(response: http.ServerResponse, event: unknown) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function shutdown(ws: WebSocket, server: http.Server) {
  if (ws.readyState !== WebSocket.CLOSED) {
    const closed = once(ws, "close").catch(() => undefined);
    ws.terminate();
    await closed;
  }
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("surfaces a clean upstream EOF without a terminal event", async () => {
  const { server, port } = await startProxy((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, {
      type: "response.created",
      response: { id: "resp_missing_terminal", status: "in_progress" },
    });
    response.end();
  });
  const ws = await openWebsocket(port);
  const frames = recordFrames(ws);

  try {
    sendResponseCreate(ws);
    const error = await waitForFrame(
      ws,
      frames,
      (frame) => frame.error?.code === "upstream_stream_error",
    );

    assert.equal(error.type, "error");
    assert.match(error.error?.message ?? "", /before a terminal/);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["response.created", "error"],
    );
  } finally {
    await shutdown(ws, server);
  }
});

test("does not append an error when the upstream breaks after a completed event", async () => {
  const { server, port } = await startProxy((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, {
      type: "response.completed",
      response: { id: "resp_completed", status: "completed", output: [] },
    });
    setTimeout(() => response.socket?.destroy(), 10);
  });
  const ws = await openWebsocket(port);
  const frames = recordFrames(ws);

  try {
    sendResponseCreate(ws);
    await waitForFrame(ws, frames, (frame) => frame.type === "response.completed");
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(frames.map((frame) => frame.type), ["response.completed"]);
  } finally {
    await shutdown(ws, server);
  }
});

test("preserves an explicit upstream failure without a second error", async () => {
  const failed = {
    type: "response.failed",
    response: {
      id: "resp_failed",
      status: "failed",
      error: { message: "provider rejected the response" },
    },
  };
  const { server, port } = await startProxy((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, failed);
    response.end();
  });
  const ws = await openWebsocket(port);
  const frames = recordFrames(ws);

  try {
    sendResponseCreate(ws);
    await waitForFrame(ws, frames, (frame) => frame.type === "response.failed");
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(frames, [failed]);
  } finally {
    await shutdown(ws, server);
  }
});

test("turns an upstream body read failure into a websocket error frame", async () => {
  const { server, port } = await startProxy((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, {
      type: "response.created",
      response: { id: "resp_disconnected", status: "in_progress" },
    });
    setTimeout(() => response.socket?.destroy(), 10);
  });
  const ws = await openWebsocket(port);
  const frames = recordFrames(ws);

  try {
    sendResponseCreate(ws);
    const error = await waitForFrame(
      ws,
      frames,
      (frame) => frame.error?.code === "upstream_stream_error",
    );

    assert.match(error.error?.message ?? "", /upstream stream interrupted/);
  } finally {
    await shutdown(ws, server);
  }
});

test("closing the outer websocket aborts the loopback response body", async () => {
  let markUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });
  let markUpstreamClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    markUpstreamClosed = resolve;
  });
  const { server, port } = await startProxy((_request, response) => {
    response.once("close", markUpstreamClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, {
      type: "response.created",
      response: { id: "resp_abort", status: "in_progress" },
    });
    markUpstreamStarted();
  });
  const ws = await openWebsocket(port);

  try {
    sendResponseCreate(ws);
    await withTimeout(upstreamStarted, "loopback response start");
    const closed = once(ws, "close");
    ws.close();
    await withTimeout(closed, "outer websocket close");

    await withTimeout(upstreamClosed, "loopback response abort");
  } finally {
    await shutdown(ws, server);
  }
});
