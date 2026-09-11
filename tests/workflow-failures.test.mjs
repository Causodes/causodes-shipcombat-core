import assert from "node:assert/strict";
import test from "node:test";

import { setModuleId } from "../scripts/constants.js";
import { SystemAdapter } from "../scripts/systems/SystemAdapter.js";
import {
  blastOrdnance,
  deleteOrdnanceTokens,
  executeCraftRecovery,
  executeOrdnanceLaunch,
} from "../scripts/state/ordnance-state.js";
import { applyBdaCorrection } from "../scripts/state/sensors-state.js";
import { RecordingDocument } from "./helpers/foundry-state-harness.mjs";

class FoundryCollection extends Map {
  [Symbol.iterator]() { return this.values(); }
  filter(callback) { return [...this.values()].filter(callback); }
  map(callback) { return [...this.values()].map(callback); }
  some(callback) { return [...this.values()].some(callback); }
}
class TestAdapter extends SystemAdapter {
  get hullDisplayMode() { return "damageTaken"; }
}

setModuleId("test-shipcombat");
SystemAdapter.register(new TestAdapter());

function install({ tokens = [], actors = [] } = {}) {
  const tokenCollection = new FoundryCollection(tokens.map(token => [token.id, token]));
  const actorCollection = new FoundryCollection(actors.map(actor => [actor.id, actor]));
  const scene = {
    tokens: tokenCollection,
    failDelete: null,
    async deleteEmbeddedDocuments(_type, ids) {
      if (this.failDelete) throw this.failDelete;
      for (const id of ids) tokenCollection.delete(id);
      return ids;
    },
    async createEmbeddedDocuments(_type, documents) {
      return documents.map((document, index) => {
        const actor = actorCollection.get(document.actorId);
        const token = { ...document, id: document.id ?? `created-token-${index}`, actor };
        tokenCollection.set(token.id, token);
        return token;
      });
    },
  };
  globalThis.game = {
    user: { isGM: true }, actors: actorCollection, messages: new FoundryCollection(),
    settings: { get: () => "simplified" }, i18n: { localize: key => key },
  };
  globalThis.canvas = { scene, grid: { size: 100 } };
  globalThis.foundry = { utils: {
    randomID: () => "generated-id", deepClone: structuredClone,
    mergeObject: (a, b) => ({ ...a, ...b }),
    setProperty(object, path, value) {
      const parts = path.split("."); const last = parts.pop(); let cursor = object;
      for (const part of parts) cursor = cursor[part] ??= {};
      cursor[last] = value;
    },
  } };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    TOKEN_DISPOSITIONS: { NEUTRAL: 0 },
  };
  globalThis.ui = { notifications: { error() {}, warn() {} } };
  globalThis.ChatMessage = { async create() {} };
  return { scene, tokenCollection, actorCollection };
}

test("deletion failure leaves both token and generated actor intact", async () => {
  const actor = new RecordingDocument({ id: "actor", flags: { "test-shipcombat": { fromOrdnanceMaster: true } } });
  const token = { id: "token", actorId: actor.id, actor };
  const { scene, tokenCollection } = install({ tokens: [token], actors: [actor] });
  scene.failDelete = new Error("injected token deletion failure");
  await assert.rejects(deleteOrdnanceTokens([token.id]), /injected token deletion failure/);
  assert.equal(tokenCollection.has(token.id), true);
  assert.equal(actor.deleted, false);
});

test("generated-actor cleanup failure is surfaced after token deletion", async () => {
  const actor = new RecordingDocument({ id: "actor", flags: { "test-shipcombat": { fromOrdnanceMaster: true } } });
  actor.failNextDelete = new Error("injected actor cleanup failure");
  const token = { id: "token", actorId: actor.id, actor };
  const { tokenCollection } = install({ tokens: [token], actors: [actor] });
  const result = await deleteOrdnanceTokens([token.id, token.id]);
  assert.deepEqual(result, { tokensDeleted: 1, actorsDeleted: 0, actorCleanupFailed: 1 });
  assert.equal(tokenCollection.has(token.id), false);
});

test("craft recovery rolls resource reservation back when deletion fails", async () => {
  const craft = new RecordingDocument({
    id: "craft-actor", type: "test-shipcombat.shipOrdnance",
    system: { subtype: "strikeCraft", parentShipTokenId: "ship-token" },
  });
  const ship = new RecordingDocument({
    id: "ship", type: "test-shipcombat.ship",
    system: { crewSize: 6, resources: { ordnance: { manpower: 10, commitments: [], craftRecovering: 0 } } },
  });
  const shipToken = { id: "ship-token", actorId: ship.id, actor: ship, center: { x: 50, y: 50 }, document: { width: 1, height: 1 } };
  ship.getActiveTokens = () => [shipToken];
  const craftToken = { id: "craft-token", actorId: craft.id, actor: craft, x: 100, y: 0, width: 1, height: 1 };
  const { scene } = install({ tokens: [shipToken, craftToken], actors: [ship, craft] });
  scene.failDelete = new Error("injected recovery deletion failure");
  const state = {
    ship,
    getData: actor => actor.system,
    withAllocationTransaction: operation => operation(),
    update: changes => ship.update(changes),
  };
  const result = await executeCraftRecovery.call(state, { tokenId: craftToken.id });
  assert.deepEqual(result, { ok: false, reason: "deletionFailed", rolledBack: true });
  assert.equal(ship.updates.length, 2);
  assert.deepEqual(ship.updates[1], {
    "resources.ordnance.manpower": 10,
    "resources.ordnance.commitments": [],
    "resources.ordnance.craftRecovering": 0,
  });
});

test("craft recovery reports when its compensating resource rollback also fails", async () => {
  const craft = new RecordingDocument({
    id: "craft-actor", type: "test-shipcombat.shipOrdnance",
    system: { subtype: "strikeCraft", parentShipTokenId: "ship-token" },
  });
  const ship = new RecordingDocument({
    id: "ship", type: "test-shipcombat.ship",
    system: { crewSize: 6, resources: { ordnance: { manpower: 10, commitments: [], craftRecovering: 0 } } },
  });
  const shipToken = { id: "ship-token", actorId: ship.id, actor: ship, center: { x: 50, y: 50 }, document: { width: 1, height: 1 } };
  ship.getActiveTokens = () => [shipToken];
  const craftToken = { id: "craft-token", actorId: craft.id, actor: craft, x: 100, y: 0, width: 1, height: 1 };
  const { scene } = install({ tokens: [shipToken, craftToken], actors: [ship, craft] });
  scene.failDelete = new Error("injected deletion failure");
  let writes = 0;
  const state = {
    ship, getData: actor => actor.system, withAllocationTransaction: operation => operation(),
    async update(changes) {
      writes += 1;
      if (writes === 2) throw new Error("injected rollback failure");
      return ship.update(changes);
    },
  };
  assert.deepEqual(await executeCraftRecovery.call(state, { tokenId: craftToken.id }), {
    ok: false, reason: "rollbackFailed", rolledBack: false,
  });
});

test("launch actor-creation failure never commits crew or ammunition", async () => {
  const ship = new RecordingDocument({
    id: "ship", type: "test-shipcombat.ship",
    system: {
      crewSize: 6,
      ordnanceActors: { torpedo: [{ id: "template", actorData: { name: "T", system: {} } }], strikeCraft: [] },
      activeOrdnance: [{ id: "slot", type: "torpedo", actorId: "template" }],
      resources: { pilot: {}, ordnance: { manpower: 10, armedTorpedoes: 1, commitments: [] } },
    },
  });
  ship.items = { find: () => null };
  const parent = { id: "ship-token", actorId: ship.id, actor: ship };
  install({ tokens: [parent], actors: [ship] });
  globalThis.Actor = { async create() { throw new Error("injected actor creation failure"); } };
  const state = {
    ship,
    getData: actor => actor.system,
    withAllocationTransaction: operation => operation(),
    update: changes => ship.update(changes),
  };
  const result = await executeOrdnanceLaunch.call(state, {
    actionId: "launchTorpedo",
    spawnRequests: [{ type: "torpedo", templateId: "template", parentShipTokenId: parent.id, x: 0, y: 0, rotation: 0 }],
  });
  assert.deepEqual(result, { ok: false, reason: "spawnFailed" });
  assert.deepEqual(ship.updates, []);
});

test("launch commitment failure deletes every provisional token and actor", async () => {
  const ship = new RecordingDocument({
    id: "ship", type: "test-shipcombat.ship",
    system: {
      crewSize: 6,
      ordnanceActors: { torpedo: [{ id: "template", actorData: { name: "T", system: {} } }], strikeCraft: [] },
      activeOrdnance: [{ id: "slot", type: "torpedo", actorId: "template" }],
      resources: { pilot: {}, ordnance: { manpower: 10, armedTorpedoes: 1, commitments: [] } },
    },
  });
  ship.items = { find: () => null };
  const parent = { id: "ship-token", actorId: ship.id, actor: ship };
  const { actorCollection, tokenCollection } = install({ tokens: [parent], actors: [ship] });
  let generatedActor;
  globalThis.Actor = { async create(data) {
    generatedActor = new RecordingDocument({ ...data, id: "generated-actor" });
    generatedActor.getTokenDocument = async overrides => ({
      toObject: () => ({ ...overrides, id: "generated-token", actorId: generatedActor.id }),
    });
    actorCollection.set(generatedActor.id, generatedActor);
    return generatedActor;
  } };
  const state = {
    ship, getData: actor => actor.system, withAllocationTransaction: operation => operation(),
    async update() { throw new Error("injected commitment failure"); },
  };
  const result = await executeOrdnanceLaunch.call(state, {
    actionId: "launchTorpedo",
    spawnRequests: [{ type: "torpedo", templateId: "template", parentShipTokenId: parent.id, x: 0, y: 0, rotation: 0 }],
  });
  assert.deepEqual(result, { ok: false, reason: "commitFailed" });
  assert.equal(tokenCollection.has("generated-token"), false);
  assert.equal(generatedActor.deleted, true);
});

test("BDA persistence failure cannot update chat ahead of authoritative state", async () => {
  const attack = {
    attackId: "attack", status: "correction", targetTokenId: "target", sl: 2,
    messageId: "message", createdAt: 1, shipUuid: "Actor.ship",
  };
  const ship = new RecordingDocument({ id: "ship" });
  const message = new RecordingDocument({ id: "message", flags: { "test-shipcombat": {
    type: "bdaPending", attackId: "attack", attackCreatedAt: 1, shipUuid: "Actor.ship",
  } } });
  install({ actors: [ship] });
  game.messages.set(message.id, message);
  const state = {
    ship,
    getData: () => ({ resources: { engineer: { auxiliaryPower: 0 }, sensors: { bdaAttacks: { attack }, locks: [] } } }),
    getReactorStats: () => ({ auxPowerCapacity: 10 }),
    withAllocationTransaction: operation => operation(),
    async update() { throw new Error("injected ship update failure"); },
  };
  await assert.rejects(applyBdaCorrection.call(state, {
    attackId: "attack", correctionId: "adjustBearing", messageId: "message", messageContent: "updated",
  }), /injected ship update failure/);
  assert.deepEqual(message.updates, []);
});

test("damage failure does not mark a detonation resolved; retry is idempotent", async () => {
  const craft = new RecordingDocument({
    id: "craft", type: "test-shipcombat.shipOrdnance", flags: {},
    system: { subtype: "strikeCraft", hull: { value: 0, max: 10 } },
  });
  const token = { id: "craft-token", actorId: craft.id, actor: craft };
  install({ tokens: [token], actors: [craft] });
  const state = { withActorActionTransaction: (_actor, operation) => operation() };
  craft.failNextUpdate = new Error("injected damage failure");
  const payload = { craftDamages: [{ tokenId: token.id, damage: 3 }], detonationId: "detonation" };
  await assert.rejects(blastOrdnance.call(state, payload), /injected damage failure/);
  assert.equal(craft.getFlag("test-shipcombat", "resolvedDetonationIds"), undefined);
  assert.deepEqual(await blastOrdnance.call(state, payload), { ok: true });
  assert.deepEqual(await blastOrdnance.call(state, payload), { ok: true });
  assert.equal(craft.updates.length, 1);
});

test("partial multi-craft damage retries only the uncommitted remainder", async () => {
  const first = new RecordingDocument({ id: "first", type: "test-shipcombat.shipOrdnance", flags: {}, system: { subtype: "strikeCraft", hull: { value: 0, max: 10 } } });
  const second = new RecordingDocument({ id: "second", type: "test-shipcombat.shipOrdnance", flags: {}, system: { subtype: "strikeCraft", hull: { value: 0, max: 10 } } });
  second.failNextUpdate = new Error("injected second craft failure");
  const tokens = [
    { id: "first-token", actorId: first.id, actor: first },
    { id: "second-token", actorId: second.id, actor: second },
  ];
  install({ tokens, actors: [first, second] });
  const state = { withActorActionTransaction: (_actor, operation) => operation() };
  const payload = {
    detonationId: "multi",
    craftDamages: tokens.map(token => ({ tokenId: token.id, damage: 2 })),
  };
  await assert.rejects(blastOrdnance.call(state, payload), /injected second craft failure/);
  assert.equal(first.updates.length, 1);
  assert.equal(second.updates.length, 0);
  assert.deepEqual(await blastOrdnance.call(state, payload), { ok: true });
  assert.equal(first.updates.length, 1);
  assert.equal(second.updates.length, 1);
});
