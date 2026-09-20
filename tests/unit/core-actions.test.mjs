import test from "node:test";
import assert from "node:assert/strict";

import { CRIT_LOCATIONS } from "../../scripts/constants.js";
import {
  buildGunnerCoreEffectUpdates,
  buildOrdnanceCoreEffectUpdates,
  executeGunnerCoreAction,
  executeOrdnanceCoreAction,
} from "../../scripts/state/station-core-actions.js";
import { applyOrdnanceCompletionEffect } from "../../scripts/state/ordnance-reservations.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

function baseData() {
  return {
    crewSize: 6,
    activeOrdnance: [{ type: "torpedo", actorId: "torpedo" }],
    ordnanceActors: { torpedo: [{ id: "torpedo" }], strikeCraft: [] },
    hull: { value: 6, max: 10 },
    internalFire: 2,
    resources: {
      engineer: { auxiliaryPower: 2 },
      gunner: { coreCount: 1, coreActionsPlayed: [], ammo: 5 },
      ordnance: {
        coreCount: 1,
        coreActionsPlayed: [],
        manpower: 4,
        manpowerMax: 10,
        craftDestroyed: 1,
        craftPartialRecovery: 1,
        craftRecovering: 1,
        armedCraft: 0,
        armedTorpedoes: 0,
        availablePayloads: 0,
        commitments: [{ id: "work", action: "loadAmmo", crewCount: 3, turnsRemaining: 2 }],
      },
    },
  };
}

test("every Gunner Core action has a complete authoritative projection", () => {
  const data = baseData();
  assert.deepEqual(buildGunnerCoreEffectUpdates(data, "extendRange"), {
    ok: true,
    updates: { "resources.gunner.sensorBandExpanded": true },
  });
  const location = CRIT_LOCATIONS[0].id;
  assert.deepEqual(buildGunnerCoreEffectUpdates(data, "chooseCritLoc", { critLocationChoice: location }), {
    ok: true,
    updates: {
      "resources.gunner.chooseCritLocation": true,
      "resources.gunner.critLocationChoice": location,
    },
  });
  assert.equal(buildGunnerCoreEffectUpdates(data, "chooseCritLoc", { critLocationChoice: "invalid" }).ok, false);
  assert.deepEqual(buildGunnerCoreEffectUpdates(data, "emergencyResupply", { ammoCapacity: 20 }), {
    ok: true,
    updates: { "resources.gunner.ammo": 10 },
  });
});

test("every Ordnance Core action branch has a complete projection", () => {
  const data = baseData();
  assert.equal(buildOrdnanceCoreEffectUpdates(data, "combatRecoveryDoctrine", { choice: "destroyed" }).ok, true);
  assert.equal(buildOrdnanceCoreEffectUpdates(data, "combatRecoveryDoctrine", { choice: "partial" }).ok, true);

  const shock = buildOrdnanceCoreEffectUpdates(data, "shockLoadingRotation", {
    commitmentId: "work",
    componentManpower: 10,
    ammoCapacity: 20,
  });
  assert.deepEqual(shock.updates["resources.ordnance.commitments"], []);
  assert.equal(shock.updates["resources.ordnance.manpower"], 7);
  assert.equal(shock.updates["resources.gunner.ammo"], 9);

  assert.equal(buildOrdnanceCoreEffectUpdates(data, "magazineCrossfeed", { choice: "payload" }).updates["resources.gunner.ammo"], 1);
  assert.equal(buildOrdnanceCoreEffectUpdates({ ...data, resources: { ...data.resources, gunner: { ammo: 6 }, ordnance: data.resources.ordnance } }, "magazineCrossfeed", { choice: "torpedo" }).updates["resources.ordnance.armedTorpedoes"], 1);
  assert.equal(buildOrdnanceCoreEffectUpdates(data, "deckConsciption", { choice: "temp", componentManpower: 10 }).updates["resources.ordnance.manpower"], 7);
  assert.equal(buildOrdnanceCoreEffectUpdates({ ...data, resources: { ...data.resources, ordnance: { ...data.resources.ordnance, manpowerMax: 8 } } }, "deckConsciption", { choice: "recover", componentManpower: 10 }).updates["resources.ordnance.manpowerMax"], 9);

  const fullCrew = buildOrdnanceCoreEffectUpdates(data, "rapidRearm", { reserveMultiplier: 6, auxPowerCapacity: 10 });
  assert.equal(fullCrew.updates["resources.ordnance.armedTorpedoes"], 1);
  assert.equal(fullCrew.updates["resources.ordnance.availablePayloads"], 1);
  const reducedCrew = buildOrdnanceCoreEffectUpdates({ ...data, crewSize: 4 }, "rapidRearm", { reserveMultiplier: 6, auxPowerCapacity: 10 });
  assert.equal(reducedCrew.updates["resources.engineer.auxiliaryPower"], 5);
});

test("all commitment completion effects share one projection", () => {
  const data = baseData();
  const updates = { "resources.ordnance.commitments": [{ id: "remaining", turnsRemaining: 2 }] };
  const stats = { ammoCapacity: 20, auxPowerCapacity: 10, reserveMultiplier: 4, hullDisplayMode: "damageTaken" };
  for (const actionId of [
    "damageControl", "hullRepairParty", "loadAmmo", "armTorpedo", "armCraft",
    "loadPayload", "generatePower", "recallCraft", "bayOptimization",
  ]) applyOrdnanceCompletionEffect(updates, data, actionId, stats);
  assert.deepEqual(updates, {
    "resources.ordnance.commitments": [{ id: "remaining", turnsRemaining: 1 }],
    internalFire: 1,
    "hull.value": 4,
    "resources.gunner.ammo": 9,
    "resources.ordnance.armedTorpedoes": 1,
    "resources.ordnance.armedCraft": 2,
    "resources.ordnance.availablePayloads": 1,
    "resources.engineer.auxiliaryPower": 6,
    "resources.ordnance.craftRecovering": 0,
  });
});

function executableState(data, { fail = false } = {}) {
  const updates = [];
  const ship = { id: "ship" };
  return {
    ship,
    updates,
    getData: () => data,
    getOrdnanceBayStats: () => ({ ammoCapacity: 20, manpower: 10 }),
    getReactorStats: () => ({ auxPowerCapacity: 10, reserveMultiplier: 6 }),
    withAllocationTransaction: callback => callback(),
    withPowerCoreTransaction: callback => callback(),
    update: async change => {
      if (fail) throw new Error("injected write failure");
      updates.push(change);
      return true;
    },
  };
}

test("station Core actions spend their Core and apply their effect in one write", async () => {
  const previousGame = globalThis.game;
  const previousAdapter = SystemAdapter._current;
  globalThis.game = { user: { isGM: true } };
  SystemAdapter._current = { hullDisplayMode: "damageTaken" };
  try {
    const gunner = executableState(baseData());
    assert.deepEqual(await executeGunnerCoreAction.call(gunner, { actionId: "extendRange" }), { ok: true });
    assert.equal(gunner.updates.length, 1);
    assert.equal(gunner.updates[0]["resources.gunner.coreCount"], 0);
    assert.equal(gunner.updates[0]["resources.gunner.sensorBandExpanded"], true);

    const ordnance = executableState(baseData());
    assert.deepEqual(await executeOrdnanceCoreAction.call(ordnance, { actionId: "rapidRearm" }), { ok: true });
    assert.equal(ordnance.updates.length, 1);
    assert.equal(ordnance.updates[0]["resources.ordnance.coreCount"], 0);
    assert.equal(ordnance.updates[0]["resources.ordnance.armedTorpedoes"], 1);

    const staleConfigData = baseData();
    staleConfigData.ordnanceActors.torpedo = [{ id: "different-template" }];
    const staleConfig = executableState(staleConfigData);
    assert.deepEqual(await executeOrdnanceCoreAction.call(staleConfig, { actionId: "rapidRearm" }), {
      ok: false,
      reason: "noTorpedoConfig",
    });
    assert.equal(staleConfig.updates.length, 0);

    const failed = executableState(baseData(), { fail: true });
    await assert.rejects(executeGunnerCoreAction.call(failed, { actionId: "extendRange" }), /injected/);
    assert.equal(failed.updates.length, 0);
  } finally {
    globalThis.game = previousGame;
    SystemAdapter._current = previousAdapter;
  }
});
