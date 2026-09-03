import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { installResponsesWebsocketProxy } from "./websocket-responses.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("protects Responses websocket upgrades with the configured authorizer", async () => {
  const server = http.createServer();
  installResponsesWebsocketProxy({
    server,
    port: 0,
    authorize: (request) =>
      request.headers.authorization === "Bearer local-proxy-key",
  });
  const port = await listen(server);

  try {
    const unauthorized = new WebSocket(
      `ws://127.0.0.1:${port}/v1/responses`,
    );
    const status = await new Promise<number>((resolve, reject) => {
      unauthorized.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      unauthorized.once("open", () =>
        reject(new Error("unauthorized websocket unexpectedly opened")),
      );
      unauthorized.once("error", reject);
    });
    assert.equal(status, 401);

    const authorized = new WebSocket(
      `ws://127.0.0.1:${port}/v1/responses`,
      {
        headers: {
          authorization: "Bearer local-proxy-key",
        },
      },
    );
    await once(authorized, "open");
    authorized.close();
    await once(authorized, "close");
  } finally {
    await closeServer(server);
  }
});

test("rejects a new turn on an existing websocket after update drain begins", async () => {
  const server = http.createServer();
  let accepting = true;
  installResponsesWebsocketProxy({ server, port: 0, admit: () => accepting });
  const port = await listen(server);
  const websocket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);

  try {
    await once(websocket, "open");
    accepting = false;
    websocket.send(JSON.stringify({ type: "response.create", model: "test", input: [] }));
    const [message] = await once(websocket, "message");
    const frame = JSON.parse(message.toString());
    assert.equal(frame.type, "error");
    assert.equal(frame.status, 503);
    assert.equal(frame.error.code, "host_update_draining");
  } finally {
    websocket.close();
    await once(websocket, "close").catch(() => undefined);
    await closeServer(server);
  }
});
