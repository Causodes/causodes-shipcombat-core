import assert from "node:assert/strict";
import test from "node:test";

import { mutationQueueKey, runSerializedMutation } from "../scripts/state/mutation-queue.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("same-identity mutations execute strictly in request order", async () => {
  const queue = new Map();
  const gate = deferred();
  const started = deferred();
  const events = [];
  const first = runSerializedMutation(queue, "ship", async () => {
    events.push("first:start");
    started.resolve();
    await gate.promise;
    events.push("first:end");
  });
  const second = runSerializedMutation(queue, "ship", async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await started.promise;
  assert.deepEqual(events, ["first:start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(queue.size, 0);
});

test("different identities mutate concurrently", async () => {
  const queue = new Map();
  const gate = deferred();
  const events = [];
  const first = runSerializedMutation(queue, "ship-a", async () => {
    events.push("a:start");
    await gate.promise;
    events.push("a:end");
  });
  const second = runSerializedMutation(queue, "ship-b", async () => {
    events.push("b:start");
    events.push("b:end");
  });

  await second;
  assert.deepEqual(events, ["a:start", "b:start", "b:end"]);
  gate.resolve();
  await first;
  assert.deepEqual(events, ["a:start", "b:start", "b:end", "a:end"]);
});

test("a failed mutation does not poison later work for the same identity", async () => {
  const queue = new Map();
  const failure = runSerializedMutation(queue, "ship", async () => {
    throw new Error("expected failure");
  });
  const recovery = runSerializedMutation(queue, "ship", async () => "recovered");

  await assert.rejects(failure, /expected failure/);
  assert.equal(await recovery, "recovered");
  assert.equal(queue.size, 0);
});

test("queue identity prefers UUID, then ID, then the explicit fallback", () => {
  assert.equal(mutationQueueKey({ uuid: "Actor.1", id: "1" }), "Actor.1");
  assert.equal(mutationQueueKey({ id: "1" }), "1");
  assert.equal(mutationQueueKey(null, "fallback"), "fallback");
});
