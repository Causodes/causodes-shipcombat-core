import test from "node:test";
import assert from "node:assert/strict";

import {
  getInternalFireHullValue,
  getInternalFireManpowerUpdates,
  getNpcTurnResetUpdates,
  getPlayerTurnConditionUpdates,
  holdTheLineBlocksFire,
} from "../../scripts/state/turn-effects.js";

function fireState({ hold = false } = {}) {
  return {
    internalFire: 3,
    hull: { value: 12, max: 20 },
    resources: {
      captain: { holdTheLineActive: hold },
      ordnance: { manpower: 10, manpowerMax: 12 },
    },
  };
}

test("internal fire applies mode-aware hull and manpower damage", () => {
  const data = fireState();
  assert.equal(holdTheLineBlocksFire(data), false);
  assert.equal(getInternalFireHullValue(data, "hpRemaining"), 9);
  assert.equal(getInternalFireHullValue(data, "damageTaken"), 15);
  assert.deepEqual(getInternalFireManpowerUpdates(data), {
    "resources.ordnance.manpowerMax": 9,
    "resources.ordnance.manpower": 9,
  });
});

test("Hold the Line blocks every internal-fire consequence", () => {
  const data = fireState({ hold: true });
  assert.equal(holdTheLineBlocksFire(data), true);
  assert.equal(getInternalFireHullValue(data, "hpRemaining"), null);
  assert.equal(getInternalFireHullValue(data, "damageTaken"), null);
  assert.deepEqual(getInternalFireManpowerUpdates(data), {});
});

test("player turn condition projection is identical across hull modes and preserves delayed fire", () => {
  const data = {
    ...fireState(),
    conditions: { hull: { tier: "high" }, coreSystems: { tier: "medium" } },
    resources: {
      ...fireState().resources,
      engineer: { heat: 4 },
    },
  };
  assert.deepEqual(getPlayerTurnConditionUpdates(data, "hpRemaining"), {
    "hull.value": 6,
    internalFire: 8,
    "resources.engineer.heat": 9,
  });
  assert.deepEqual(getPlayerTurnConditionUpdates(data, "damageTaken"), {
    "hull.value": 18,
    internalFire: 8,
    "resources.engineer.heat": 9,
  });

  data.resources.captain.holdTheLineActive = true;
  assert.deepEqual(getPlayerTurnConditionUpdates(data, "hpRemaining"), {
    "hull.value": 9,
    internalFire: 8,
    "resources.engineer.heat": 9,
  });
});

test("NPC turn reset clears every action gate while preserving prior movement", () => {
  const updates = getNpcTurnResetUpdates({
    voidshieldFlux: 8,
    voidshieldFluxRemaining: 1,
    engActionUsed: true,
    movement: { speed: 10 },
    resources: {
      pilot: {
        fuelBurned: 50,
        prevTurnMove: 4,
        bearing: 45,
        pilotingSL: 6,
        pilotingMessageId: "message",
        allocSpeed: 2,
        allocMano: 2,
        allocEvasion: 2,
        ramAllocLocked: true,
      },
      gunner: {
        ordnanceSL: 5,
        ordnanceRolled: true,
        allocAccuracy: 2,
        allocPenetration: 1,
        allocFirepower: 2,
        slLocked: true,
        firedWeaponIds: ["weapon"],
      },
    },
  });

  assert.deepEqual(updates, {
    "resources.pilot.prevTurnMove": 7,
    "resources.pilot.fuelBurned": 0,
    "resources.pilot.bearing": 0,
    "resources.pilot.pilotingSL": 0,
    "resources.pilot.pilotingMessageId": "",
    "resources.pilot.allocSpeed": 0,
    "resources.pilot.allocMano": 0,
    "resources.pilot.allocEvasion": 0,
    "resources.pilot.ramAllocLocked": false,
    "resources.gunner.ordnanceSL": 0,
    "resources.gunner.ordnanceRolled": false,
    "resources.gunner.allocAccuracy": 0,
    "resources.gunner.allocPenetration": 0,
    "resources.gunner.allocFirepower": 0,
    "resources.gunner.slLocked": false,
    "resources.gunner.firedWeaponIds": [],
    engActionUsed: false,
    voidshieldFluxRemaining: 8,
  });
});
