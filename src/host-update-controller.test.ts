import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { HostUpdateController } from "./host-update-controller.js";

test("Host update drain waits for HTTP, websocket, job and provider operations", async () => {
  let providerOperation = "install";
  const controller = new HostUpdateController("/tmp/multivibe-host-updater", {
    enabled: true,
    getManagedOllamaStatus: async () => ({ operation: providerOperation }),
  } as any);
  let activeJobs = 1;
  let stopped = false;
  controller.attachJobRunner({
    start() { stopped = false; },
    stop() { stopped = true; },
    activeCount() { return activeJobs; },
  });
  controller.websocketTurnStarted();
  controller.beginDrain();
  assert.equal(stopped, true);
  assert.equal((await controller.readiness()).ready, false);
  controller.websocketTurnFinished();
  activeJobs = 0;
  providerOperation = "";
  assert.deepEqual(await controller.readiness(), {
    draining: true,
    ready: true,
    active_requests: 0,
    active_websocket_turns: 0,
    active_jobs: 0,
    provider_operation: null,
  });
  controller.resume();
  assert.equal(stopped, false);
});

test("Host update drain rejects new inference requests and counts admitted work", async () => {
  const controller = new HostUpdateController(undefined, undefined);
  const response = new EventEmitter() as any;
  response.setHeader = () => undefined;
  response.status = (status: number) => { response.statusCode = status; return response; };
  response.json = (body: unknown) => { response.body = body; return response; };
  let admitted = false;
  controller.inferenceMiddleware({} as any, response, () => { admitted = true; });
  assert.equal(admitted, true);
  assert.equal((await controller.readiness()).active_requests, 1);
  response.emit("finish");
  assert.equal((await controller.readiness()).active_requests, 0);

  controller.beginDrain();
  const rejected = new EventEmitter() as any;
  rejected.setHeader = () => undefined;
  rejected.status = (status: number) => { rejected.statusCode = status; return rejected; };
  rejected.json = (body: unknown) => { rejected.body = body; return rejected; };
  controller.inferenceMiddleware({} as any, rejected, () => assert.fail("draining request was admitted"));
  assert.equal(rejected.statusCode, 503);
  assert.equal(controller.admitWebsocket(), false);
});
