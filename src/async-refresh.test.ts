import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncRefreshCoordinator,
  canServeStaleSnapshot,
} from "./async-refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serves a stale value without waiting for refresh", async () => {
  const refresh = deferred<string>();
  const coordinator = new AsyncRefreshCoordinator<string>();

  const prepared = await coordinator.prepare({
    staleValue: "stale",
    staleWhileRevalidate: true,
    refresh: () => refresh.promise,
  });

  assert.deepEqual(prepared, {
    value: "stale",
    mode: "background",
    shared: false,
  });
  refresh.resolve("fresh");
  await refresh.promise;
});

test("bounds stale snapshots by age and feature flag", () => {
  assert.equal(
    canServeStaleSnapshot({
      enabled: true,
      hasSnapshot: true,
      ageMs: 30_000,
      maxAgeMs: 30_000,
    }),
    true,
  );
  assert.equal(
    canServeStaleSnapshot({
      enabled: true,
      hasSnapshot: true,
      ageMs: 30_001,
      maxAgeMs: 30_000,
    }),
    false,
  );
  assert.equal(
    canServeStaleSnapshot({
      enabled: false,
      hasSnapshot: true,
      ageMs: 1,
      maxAgeMs: 30_000,
    }),
    false,
  );
});

test("blocks when no stale value can be used", async () => {
  const refresh = deferred<string>();
  const coordinator = new AsyncRefreshCoordinator<string>();
  let settled = false;

  const pending = coordinator
    .prepare({
      staleWhileRevalidate: true,
      refresh: () => refresh.promise,
    })
    .then((result) => {
      settled = true;
      return result;
    });

  await Promise.resolve();
  assert.equal(settled, false);
  refresh.resolve("fresh");
  assert.deepEqual(await pending, {
    value: "fresh",
    mode: "blocking",
    shared: false,
  });
});

test("blocks when stale-while-revalidate is disabled", async () => {
  const coordinator = new AsyncRefreshCoordinator<string>();

  const prepared = await coordinator.prepare({
    staleValue: "stale",
    staleWhileRevalidate: false,
    refresh: async () => "fresh",
  });

  assert.deepEqual(prepared, {
    value: "fresh",
    mode: "blocking",
    shared: false,
  });
});

test("coalesces refreshes while serving the same stale snapshot", async () => {
  const refresh = deferred<string>();
  const coordinator = new AsyncRefreshCoordinator<string>();
  let refreshCount = 0;
  const prepare = () =>
    coordinator.prepare({
      staleValue: "stale",
      staleWhileRevalidate: true,
      refresh: () => {
        refreshCount += 1;
        return refresh.promise;
      },
    });

  const first = await prepare();
  const second = await prepare();

  assert.equal(refreshCount, 1);
  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  refresh.resolve("fresh");
  await refresh.promise;
});
