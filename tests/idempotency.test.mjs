import assert from "node:assert/strict";
import test from "node:test";

import { IdempotencyGate, combatTransitionKey } from "../scripts/state/idempotency.js";

test("duplicate in-flight and completed requests execute one mutation", async () => {
  const gate = new IdempotencyGate();
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const operation = async () => {
    calls += 1;
    await blocked;
    return { ok: true };
  };

  const first = gate.run("launch:ship:request", operation);
  const duplicate = gate.run("launch:ship:request", operation);
  assert.equal(first, duplicate);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await gate.run("launch:ship:request", operation), { ok: true });
  assert.equal(calls, 1);
});

test("failed requests are retryable and unrelated requests are independent", async () => {
  const gate = new IdempotencyGate();
  let attempts = 0;
  await assert.rejects(gate.run("damage:a", async () => {
    attempts += 1;
    throw new Error("injected failure");
  }), /injected failure/);
  assert.equal(await gate.run("damage:a", async () => ++attempts), 2);
  assert.equal(await gate.run("damage:b", async () => ++attempts), 3);
});

test("repeated updateCombat delivery resolves to one transition identity", () => {
  const combat = {
    id: "combat-1",
    round: 4,
    turn: 2,
    previous: { combatantId: "previous" },
    combatant: { id: "current" },
  };
  const first = combatTransitionKey(combat, { turn: 2 });
  assert.equal(combatTransitionKey(combat, { turn: 2 }), first);
  assert.notEqual(combatTransitionKey({ ...combat, turn: 3 }, { turn: 3 }), first);
  assert.notEqual(combatTransitionKey({ ...combat, _stats: { modifiedTime: 2 } }, { turn: 2 }), first);
  assert.equal(combatTransitionKey(combat, { active: true }), null);
});

test("the idempotency cache is bounded", async () => {
  const gate = new IdempotencyGate({ maxEntries: 2 });
  let calls = 0;
  await gate.run("one", async () => ++calls);
  await gate.run("two", async () => ++calls);
  await gate.run("three", async () => ++calls);
  await gate.run("one", async () => ++calls);
  assert.equal(calls, 4, "oldest successful request should be evicted");
});

test("cache pressure never evicts in-flight work", async () => {
  const gate = new IdempotencyGate({ maxEntries: 1 });
  let firstCalls = 0;
  let releaseFirst;
  let releaseSecond;
  const firstBlock = new Promise(resolve => { releaseFirst = resolve; });
  const secondBlock = new Promise(resolve => { releaseSecond = resolve; });
  const first = gate.run("first", async () => { firstCalls += 1; await firstBlock; });
  const second = gate.run("second", async () => { await secondBlock; });
  const duplicate = gate.run("first", async () => { firstCalls += 1; });
  assert.equal(duplicate, first);
  await Promise.resolve();
  assert.equal(firstCalls, 1);
  releaseFirst();
  releaseSecond();
  await Promise.all([first, second]);
});
