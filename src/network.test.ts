import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fetchTextWithTimeout, readStreamChunk } from "./network.js";

test("cancels a stalled response stream after its idle timeout", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const reader = stream.getReader();
  await assert.rejects(readStreamChunk(reader, 15));
  assert.equal(cancelled, true);
});

test("times out when a buffered response stalls after its headers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await assert.rejects(
      fetchTextWithTimeout(`http://127.0.0.1:${address.port}`, {}, 15),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
