import test from "node:test";
import assert from "node:assert/strict";
import { runChunkPool, concurrencyLimit } from "../dist/pool.js";
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test(
  "ten requests overlap, never exceed the cap, and refill freed slots",
  { timeout: 3000 },
  async () => {
    const first = gate(),
      second = gate(),
      pending = new Map(),
      started = [],
      finished = [];
    let peak = 0;
    const running = runChunkPool(
      Array.from({ length: 15 }, (_, n) => n),
      {
        limit: 10,
        prepare: async (n) => n,
        execute: async (n) => {
          const wait = gate();
          pending.set(n, wait);
          started.push(n);
          if (started.length === 10) first.resolve();
          if (started.length === 15) second.resolve();
          await wait.promise;
          finished.push(n);
        },
        onActive: (count) => (peak = Math.max(peak, count)),
      },
    );
    await first.promise;
    assert.equal(started.length, 10);
    for (let n = 9; n >= 0; n--) pending.get(n).resolve();
    await second.promise;
    for (let n = 14; n >= 10; n--) pending.get(n).resolve();
    const result = await running;
    assert.equal(peak, 10);
    assert.equal(finished.length, 15);
    assert.deepEqual(result.errors, []);
  },
);

test(
  "failure stops new requests and drains all outstanding outcomes",
  { timeout: 3000 },
  async () => {
    const ready = gate(),
      pending = new Map(),
      started = [];
    const running = runChunkPool([0, 1, 2, 3, 4], {
      limit: 3,
      prepare: async (n) => n,
      execute: async (n) => {
        const wait = gate();
        pending.set(n, wait);
        started.push(n);
        if (started.length === 3) ready.resolve();
        await wait.promise;
      },
    });
    await ready.promise;
    pending
      .get(0)
      .reject(Object.assign(new Error("rate limit"), { rejected: true }));
    pending
      .get(1)
      .reject(Object.assign(new Error("unknown outcome"), { unknown: true }));
    pending.get(2).resolve();
    const result = await running;
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some((error) => error.unknown));
  },
);

test(
  "pause drains sent requests and leaves remaining items for resume",
  { timeout: 3000 },
  async () => {
    const ready = gate(),
      pending = [],
      started = [];
    let paused = false;
    const running = runChunkPool([0, 1, 2, 3, 4], {
      limit: 2,
      shouldStop: () => paused,
      prepare: async (n) => n,
      execute: async (n) => {
        const wait = gate();
        pending.push(wait);
        started.push(n);
        if (started.length === 2) ready.resolve();
        await wait.promise;
      },
    });
    await ready.promise;
    paused = true;
    pending.forEach((wait) => wait.resolve());
    const result = await running;
    assert.deepEqual(started, [0, 1]);
    assert.equal(result.paused, true);
    assert.deepEqual(result.errors, []);
  },
);

test(
  "a preparation failure also drains requests that were already sent",
  { timeout: 3000 },
  async () => {
    const ready = gate(),
      pending = [],
      finished = [];
    const running = runChunkPool([0, 1, 2, 3], {
      limit: 3,
      prepare: async (n) => {
        if (n === 2) {
          ready.resolve();
          throw new Error("storage full");
        }
        return n;
      },
      execute: async (n) => {
        const wait = gate();
        pending.push(wait);
        await wait.promise;
        finished.push(n);
      },
    });
    await ready.promise;
    pending.forEach((wait) => wait.resolve());
    const result = await running;
    assert.deepEqual(finished.sort(), [0, 1]);
    assert.equal(result.errors[0].message, "storage full");
  },
);

test("concurrency is bounded to one through ten", () => {
  assert.equal(concurrencyLimit(100), 10);
  assert.equal(concurrencyLimit(-3), 1);
  assert.equal(concurrencyLimit("4"), 4);
  assert.equal(concurrencyLimit(undefined), 10);
});
