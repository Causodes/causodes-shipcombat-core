import test from "node:test";
import assert from "node:assert/strict";

import {
  AUGUR_CORE_ACTIONS,
  AUGUR_LOCK_ACTIONS,
  AUGUR_UTILITY_ACTIONS,
  CAPTAIN_CORE_ACTIONS,
  GUNNER_CORE_ACTIONS,
  ORDNANCE_4MAN_COSTS,
  ORDNANCE_MASTER_ACTIONS,
  ORDNANCE_MASTER_CORE_ACTIONS,
} from "../../scripts/constants.js";
import { getOrdnanceReservation } from "../../scripts/state/ordnance-reservations.js";
import { getSensorActionCost } from "../../scripts/state/sensors-state.js";

test("every Ordnance Master action has full-crew and reduced-crew reservations", () => {
  for (const [actionId, action] of Object.entries(ORDNANCE_MASTER_ACTIONS)) {
    const fullCrew = getOrdnanceReservation({
      crewSize: 6,
      resources: { ordnance: { manpower: 99 } },
    }, actionId);
    assert.deepEqual(
      { crewCost: fullCrew.crewCost, duration: fullCrew.duration, affordable: fullCrew.affordable },
      { crewCost: action.crew, duration: action.duration, affordable: true },
      actionId,
    );

    const reducedCrew = getOrdnanceReservation({
      crewSize: 4,
      resources: { ordnance: { manpower: 99 } },
    }, actionId);
    assert.deepEqual(
      { crewCost: reducedCrew.crewCost, duration: reducedCrew.duration },
      { crewCost: ORDNANCE_4MAN_COSTS[actionId].crew, duration: ORDNANCE_4MAN_COSTS[actionId].duration },
      `${actionId} reduced crew`,
    );

    const optimized = getOrdnanceReservation({
      crewSize: 6,
      resources: { ordnance: { manpower: 1, allocEfficiency: 999, allocExpedience: 999 } },
    }, actionId);
    assert.equal(optimized.crewCost, 2, `${actionId} minimum crew`);
    assert.equal(optimized.duration, 1, `${actionId} minimum duration`);
    assert.equal(optimized.affordable, false, `${actionId} rejects an underfunded reservation`);
  }
  assert.equal(getOrdnanceReservation({}, "unknown"), null);
});

test("Sensors and every station Core catalog have unique complete action contracts", () => {
  const catalogs = {
    sensorLocks: AUGUR_LOCK_ACTIONS,
    sensorUtilities: AUGUR_UTILITY_ACTIONS,
    sensorCore: AUGUR_CORE_ACTIONS,
    gunnerCore: GUNNER_CORE_ACTIONS,
    captainCore: CAPTAIN_CORE_ACTIONS,
    ordnanceCore: ORDNANCE_MASTER_CORE_ACTIONS,
  };
  const allIds = [];
  for (const [name, actions] of Object.entries(catalogs)) {
    assert.ok(actions.length > 0, name);
    for (const action of actions) {
      assert.equal(typeof action.id, "string", `${name} id`);
      assert.ok(action.id.length > 0, `${name} id`);
      assert.equal(typeof action.label, "string", `${action.id} label`);
      assert.equal(typeof action.desc, "string", `${action.id} description`);
      allIds.push(`${name}:${action.id}`);
    }
    assert.equal(new Set(actions.map(action => action.id)).size, actions.length, `${name} duplicate id`);
  }
  assert.equal(new Set(allIds).size, allIds.length);

  for (const action of [...AUGUR_LOCK_ACTIONS, ...AUGUR_UTILITY_ACTIONS]) {
    assert.ok(Number.isFinite(action.cost) && action.cost >= 0, `${action.id} AP cost`);
  }
  for (const action of AUGUR_CORE_ACTIONS) {
    assert.ok(Number.isFinite(action.ap) && action.ap > 0, `${action.id} Core AP cost`);
  }
});

test("every Sensors action shares one mode-aware AP cost calculation", () => {
  const plain = { resources: { sensors: {} } };
  const boosted = { resources: { sensors: { sensorPriorityActive: true, payload: "sensorBuoy" } } };
  for (const action of [...AUGUR_LOCK_ACTIONS, ...AUGUR_UTILITY_ACTIONS]) {
    assert.equal(getSensorActionCost(plain, action.id), action.cost, action.id);
    const priorityCost = AUGUR_LOCK_ACTIONS.includes(action) && action.setsTier <= 2
      ? action.cost * 0.5
      : action.cost;
    assert.equal(getSensorActionCost(boosted, action.id), Math.ceil(Math.ceil(priorityCost) * 0.8), action.id);
  }
  for (const action of AUGUR_CORE_ACTIONS) {
    assert.equal(getSensorActionCost(plain, action.id, { core: true }), action.ap, action.id);
    assert.equal(
      getSensorActionCost(boosted, action.id, { core: true, apCostMultiplier: 1.25 }),
      Math.ceil(Math.ceil(action.ap * 1.25) * 0.8),
      action.id,
    );
  }
  assert.equal(getSensorActionCost(plain, "unknown"), null);
});
