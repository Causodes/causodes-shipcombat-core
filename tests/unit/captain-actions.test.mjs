import test from "node:test";
import assert from "node:assert/strict";

import { CAPTAIN_CARDS } from "../../scripts/constants.js";
import { buildCaptainCardEffectUpdates } from "../../scripts/state/captain-state.js";
import {
  getAttackStanceModifier,
  getStanceMovementModifiers,
  hasDevastationProtocol,
} from "../../scripts/stances.js";

const baseState = () => ({
  crewSize: 6,
  internalFire: 2,
  armourRend: { bow: 3 },
  conditions: {},
  resources: {
    captain: { coreCount: 1 },
    gunner: { coreCount: 2, captainHitBonus: 1 },
    pilot: { coreCount: 3 },
    sensors: { coreCount: 4 },
    ordnance: { coreCount: 5 },
    engineer: { auxiliaryPower: 4, heat: 7, extraActions: 0 },
  },
});

test("every Captain card has a concrete and unique effect projection", () => {
  const effects = Object.fromEntries(CAPTAIN_CARDS.map(card => [
    card.id,
    buildCaptainCardEffectUpdates(baseState(), card.id, {
      sector: "bow",
      hitBonusStep: 2,
      auxiliaryPowerCapacity: 10,
    }),
  ]));
  assert.equal(Object.keys(effects).length, CAPTAIN_CARDS.length);
  assert.equal(Object.values(effects).every(effect => Object.keys(effect).length > 0), true);

  assert.deepEqual(effects.inspiredTargeting, { "resources.gunner.captainHitBonus": 3 });
  assert.deepEqual(effects.gunsHot, { "resources.gunner.coreCount": 3 });
  assert.deepEqual(effects.pressTheAttack, { "resources.pilot.coreCount": 4 });
  assert.deepEqual(effects.enhancedSensor, { "resources.sensors.coreCount": 5 });
  assert.deepEqual(effects.armamentOrder, { "resources.ordnance.coreCount": 6 });
  assert.deepEqual(effects.hardOver, { "resources.pilot.hardOverActive": true });
  assert.deepEqual(effects.sensorPriority, { "resources.sensors.sensorPriorityActive": true });
  assert.deepEqual(effects.hardenShields, { "resources.captain.hardenedShields": true });
  assert.deepEqual(effects.repairArmour, { "armourRend.bow": 0 });
  assert.deepEqual(effects.holdTheLine, { "resources.captain.holdTheLineActive": true });
  assert.deepEqual(effects.emergencyReserves, { "resources.engineer.auxiliaryPower": 9 });
  assert.deepEqual(effects.ventingSequence, {
    "resources.engineer.heat": 2,
    internalFire: 7,
  });
  assert.deepEqual(effects.doubleShift, { "resources.engineer.extraActions": 1 });
  assert.deepEqual(effects.acceleratedLoading, { "resources.captain.acceleratedLoadingActive": true });
  assert.deepEqual(effects.overdriveCommand, {
    "resources.gunner.coreCount": 3,
    "resources.pilot.coreCount": 4,
    "resources.sensors.coreCount": 5,
    "resources.ordnance.coreCount": 6,
    "resources.captain.coreCount": 2,
    "resources.engineer.extraActions": 1,
  });

  const gambits = {
    aggressiveDoctrine: "aggressive",
    defensiveFormation: "defensive",
    redAlert: "redAlert",
    devastationProtocol: "devastation",
    standDown: "none",
  };
  for (const [cardId, stance] of Object.entries(gambits)) {
    assert.deepEqual(effects[cardId], { "resources.captain.pendingStance": stance });
  }
});

test("Emergency Reserves respects AP shutdown", () => {
  const state = baseState();
  state.conditions.coreSystems = { tier: "high" };
  assert.deepEqual(buildCaptainCardEffectUpdates(state, "emergencyReserves", {
    auxiliaryPowerCapacity: 10,
  }), {});
});

test("every stance pairing has deterministic attack and movement effects", () => {
  const stances = ["none", "aggressive", "defensive", "redAlert", "devastation"];
  const attackStep = { none: 0, aggressive: 2, defensive: -2, redAlert: 0, devastation: 0 };
  const movement = {
    none: { speed: 0, maneuverability: 0 },
    aggressive: { speed: -1, maneuverability: -1 },
    defensive: { speed: 1, maneuverability: 1 },
    redAlert: { speed: 0, maneuverability: 0 },
    devastation: { speed: 0, maneuverability: 0 },
  };

  for (const attacker of stances) {
    const attackerData = { resources: { captain: { stance: attacker } } };
    assert.deepEqual(getStanceMovementModifiers(attackerData), movement[attacker]);
    for (const target of stances) {
      const targetData = { resources: { captain: { stance: target } } };
      assert.equal(
        getAttackStanceModifier(attackerData, targetData, 2),
        attackStep[attacker] + attackStep[target],
        `${attacker} attacking ${target}`,
      );
      assert.equal(
        hasDevastationProtocol(attackerData, targetData),
        attacker === "devastation" || target === "devastation",
      );
    }
  }
});
