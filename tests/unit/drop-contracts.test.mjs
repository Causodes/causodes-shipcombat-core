import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDropArguments,
  resolveDroppedDocument,
} from "../../scripts/actors/ship/drop-contract.js";

function dropEvent() {
  return {
    dataTransfer: {},
    preventDefault() {},
    target: { closest() {} },
  };
}

test("warhammer-lib drop callbacks preserve raw data and event identity", () => {
  const data = { type: "Actor", uuid: "Actor.crew" };
  const event = dropEvent();
  assert.deepEqual(normalizeDropArguments(data, event), { data, event });
});

test("dnd5e drop callbacks normalize event-first resolved documents", () => {
  const event = dropEvent();
  const actor = { documentName: "Actor", id: "crew" };
  assert.deepEqual(normalizeDropArguments(event, actor), { data: actor, event });
});

test("resolved documents bypass raw drag-data resolution", async () => {
  const actor = { constructor: { documentName: "Actor" }, id: "crew" };
  let resolverCalls = 0;
  const result = await resolveDroppedDocument(actor, "Actor", async () => {
    resolverCalls += 1;
    return null;
  });
  assert.equal(result, actor);
  assert.equal(resolverCalls, 0);
});

test("raw drag data is resolved exactly once", async () => {
  const data = { type: "Item", uuid: "Item.engine" };
  const item = { documentName: "Item", id: "engine" };
  let resolverCalls = 0;
  const result = await resolveDroppedDocument(data, "Item", async received => {
    resolverCalls += 1;
    assert.equal(received, data);
    return item;
  });
  assert.equal(result, item);
  assert.equal(resolverCalls, 1);
});
