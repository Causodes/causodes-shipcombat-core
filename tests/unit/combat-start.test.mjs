import assert from "node:assert/strict";
import test from "node:test";

import {
  getCombatPlayerShips,
  initializePlayerShipsForCombat,
  isCombatStartTransition,
} from "../../scripts/state/combat-start.js";
import { IdempotencyGate } from "../../scripts/state/idempotency.js";
import { combatTransitionKey } from "../../scripts/state/idempotency.js";

const moduleId = "test-shipcombat";

test("combat startup initializes every distinct player ship and never NPCs", async () => {
  const playerA = { id: "a", name: "A", type: `${moduleId}.ship` };
  const playerB = { id: "b", name: "B", type: `${moduleId}.ship` };
  const npc = { id: "npc", type: `${moduleId}.npcShip` };
  const combat = { combatants: [{ actor: playerA }, { actor: playerA }, { actor: npc }, { actor: playerB }] };
  const initialized = [];
  const stateClass = {
    forShip(actor) {
      return { async startCombat() { initialized.push(actor.id); return true; } };
    },
  };

  assert.deepEqual(getCombatPlayerShips(combat, moduleId), [playerA, playerB]);
  assert.equal(await initializePlayerShipsForCombat(combat, { moduleId, stateClass }), 2);
  assert.deepEqual(initialized, ["a", "b"]);
});

test("combat startup routes host-normalized synthetic ships by persisted identity", () => {
  const synthetic = { id: "synthetic", uuid: "Scene.scene.Token.token.Actor.synthetic", type: "impmal.vehicle" };
  const persisted = { id: "world", _source: { type: `${moduleId}.ship` } };
  const combatant = { actorId: persisted.id, actor: synthetic, token: { baseActor: persisted } };
  const actors = globalThis.game;
  globalThis.game = { actors: new Map([[persisted.id, persisted]]) };
  try {
    assert.deepEqual(getCombatPlayerShips({ combatants: [combatant] }, moduleId), [synthetic]);
  } finally {
    globalThis.game = actors;
  }
});

test("combat startup exposes failed initialization", async () => {
  const actor = { id: "a", name: "Broken Ship", type: `${moduleId}.ship` };
  const stateClass = { forShip: () => ({ async startCombat() { return false; } }) };
  await assert.rejects(
    initializePlayerShipsForCombat({ combatants: [{ actor }] }, { moduleId, stateClass }),
    /Broken Ship/,
  );
});

test("duplicate combatStart delivery shares one initialization", async () => {
  const actor = { id: "a", type: `${moduleId}.ship` };
  const combat = {
    id: "combat", round: 1, turn: 0,
    _stats: { modifiedTime: 42 }, combatants: [{ actor }],
  };
  let calls = 0;
  const stateClass = {
    forShip: () => ({ async startCombat() { calls += 1; return true; } }),
  };
  const gate = new IdempotencyGate();
  const changes = { round: 1, turn: 0 };
  const run = () => gate.run(combatTransitionKey(combat, changes), () => (
    initializePlayerShipsForCombat(combat, { moduleId, stateClass })
  ));

  assert.deepEqual(await Promise.all([run(), run()]), [1, 1]);
  assert.equal(calls, 1);
  assert.equal(isCombatStartTransition(changes), true);
  for (const nonStart of [{ round: 1 }, { round: 2, turn: 0 }, { round: 1, turn: 1 }, { turn: 0 }]) {
    assert.equal(isCombatStartTransition(nonStart), false, JSON.stringify(nonStart));
  }
});
