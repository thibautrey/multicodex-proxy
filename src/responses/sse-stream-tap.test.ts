import assert from "node:assert/strict";
import test from "node:test";
import { createSSEStreamTap } from "./sse-stream-tap.js";

const encoder = new TextEncoder();

test("observes mixed SSE boundaries split across upstream chunks", () => {
  const frames: string[] = [];
  const tap = createSSEStreamTap((frame) => frames.push(frame));
  const stream =
    'event: first\ndata: {"type":"first","text":"café"}\n\n' +
    'event: second\r\ndata: {"type":"second"}\r\n\r\n';
  const bytes = encoder.encode(stream);

  tap.push(bytes.slice(0, 17));
  tap.push(bytes.slice(17, 48));
  tap.push(bytes.slice(48, 61));
  tap.push(bytes.slice(61));

  assert.deepEqual(tap.finish(), { unterminatedFrame: false });
  assert.deepEqual(frames, [
    'event: first\ndata: {"type":"first","text":"café"}',
    'event: second\r\ndata: {"type":"second"}',
  ]);
});

test("reports and observes an unterminated final frame", () => {
  const frames: string[] = [];
  const tap = createSSEStreamTap((frame) => frames.push(frame));

  tap.push(encoder.encode('event: final\ndata: {"type":"final"}'));

  assert.deepEqual(tap.finish(), { unterminatedFrame: true });
  assert.deepEqual(frames, ['event: final\ndata: {"type":"final"}']);
});

test("does not report trailing whitespace as a frame", () => {
  const frames: string[] = [];
  const tap = createSSEStreamTap((frame) => frames.push(frame));

  tap.push(encoder.encode("event: done\ndata: [DONE]\n\n \n"));

  assert.deepEqual(tap.finish(), { unterminatedFrame: false });
  assert.deepEqual(frames, ["event: done\ndata: [DONE]"]);
});
