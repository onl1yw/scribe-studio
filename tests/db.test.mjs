import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  putJob,
  getJob,
  getChunks,
  getViews,
  patchJob,
  markSending,
  completeChunk,
  hasPendingRequests,
  putChunk,
} from "../dist/db.js";

test("concurrent and duplicate response saves preserve exact progress and cost", async () => {
  const id = "parallel-save";
  await putJob({
    id,
    status: "transcribing",
    done: 0,
    total: 10,
    cost: null,
    created: 1,
  });
  const chunks = Array.from({ length: 10 }, (_, number) => ({
    job: id,
    number,
    status: "prepared",
  }));
  await Promise.all(chunks.map(markSending));
  assert.equal(await hasPendingRequests(id), true);
  const done = chunks.map((c) => ({
    ...c,
    status: "done",
    response: {
      text: "part " + c.number,
      usage: { cost: (c.number + 1) / 100 },
    },
    segments: [{ text: "part " + c.number, timed: true }],
  }));
  await Promise.all(
    done
      .toReversed()
      .flatMap((c) => [completeChunk(c), patchJob(id, { current: c.number })]),
  );
  await completeChunk({
    ...done[0],
    response: { text: "duplicate", usage: { cost: 999 } },
  });
  const job = await getJob(id);
  assert.equal(job.done, 10);
  assert.equal(job.segment_count, 10);
  assert.ok(Math.abs(job.cost - 0.55) < 1e-9);
  assert.equal((await getChunks(id)).length, 10);
  assert.equal((await getViews(id, Infinity)).length, 10);
  assert.equal((await getChunks(id))[0].response.text, "part 0");
  assert.equal(await hasPendingRequests(id), false);
});

test("unknown requests survive other successes and missing prices stay unknown", async () => {
  const id = "unknown-save";
  await putJob({
    id,
    status: "transcribing",
    done: 0,
    total: 3,
    cost: null,
    created: 2,
  });
  await putChunk({ job: id, number: 0, status: "unknown" });
  await completeChunk({
    job: id,
    number: 1,
    status: "done",
    response: { text: "no price" },
    segments: [{ text: "plain", timed: false }],
  });
  await completeChunk({
    job: id,
    number: 2,
    status: "done",
    response: { text: "priced", usage: { cost: 1 } },
    segments: [{ text: "timed", timed: true }],
  });
  const job = await getJob(id);
  assert.equal(job.done, 2);
  assert.equal(job.cost, null);
  assert.equal(job.has_untimed, true);
  assert.equal(await hasPendingRequests(id), true);
});
