import assert from "node:assert/strict";
import test from "node:test";

import {
  getShipTokenCreationDefaults,
  resolvePersistedActor,
  resolvePersistedActorType,
} from "../../scripts/actor-identity.js";

const moduleId = "test-adapter";

test("persisted actor identity wins over a host-normalized synthetic actor", () => {
  const persisted = {
    id: "npc",
    type: "vehicle",
    _source: { type: `${moduleId}.npcShip` },
  };
  const synthetic = { id: "npc", type: "vehicle" };
  const actors = new Map([[persisted.id, persisted]]);

  assert.equal(resolvePersistedActor({ actorId: persisted.id, actor: synthetic }, actors), persisted);
  assert.equal(resolvePersistedActorType({ actorId: persisted.id, actor: synthetic }, actors), `${moduleId}.npcShip`);
  assert.equal(resolvePersistedActorType({ baseActor: persisted, actor: synthetic }, new Map()), `${moduleId}.npcShip`);
});

test("ship Token defaults are projected from persisted identity at creation", () => {
  const player = {
    id: "player",
    type: "vehicle",
    _source: { type: `${moduleId}.ship` },
    prototypeToken: { actorLink: true },
  };
  const npc = {
    id: "npc",
    type: "vehicle",
    _source: { type: `${moduleId}.npcShip` },
    prototypeToken: { actorLink: false },
  };
  const actors = new Map([[player.id, player], [npc.id, npc]]);
  const synthetic = { type: "vehicle" };

  assert.deepEqual(getShipTokenCreationDefaults({
    token: { actor: synthetic }, data: { actorId: player.id }, moduleId, actors,
  }), { actorLink: true });
  assert.deepEqual(getShipTokenCreationDefaults({
    token: { actor: synthetic }, data: { actorId: npc.id }, moduleId, actors,
  }), { actorLink: false, hidden: true });
  assert.deepEqual(getShipTokenCreationDefaults({
    token: { _source: { actorId: npc.id } }, data: {}, moduleId, actors,
  }), { actorLink: false, hidden: true });
  assert.equal(getShipTokenCreationDefaults({
    token: { actor: { type: "character" } }, data: {}, moduleId, actors,
  }), null);
});
