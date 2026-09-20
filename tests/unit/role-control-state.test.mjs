import test from "node:test";
import assert from "node:assert/strict";

import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

test("role contexts distinguish unrolled, rolled, committed, completed, and stale state", async () => {
  const previous = {
    game: globalThis.game,
    canvas: globalThis.canvas,
    foundry: globalThis.foundry,
    Application: globalThis.Application,
    adapter: SystemAdapter._current,
  };
  globalThis.game = {
    i18n: { localize: key => key, format: key => key },
    settings: { get: () => false },
  };
  globalThis.canvas = { scene: null, tokens: { get: () => null, placeables: [] } };
  class TestApplication {}
  globalThis.Application = TestApplication;
  globalThis.foundry = {
    appv1: { api: { Application: TestApplication, Dialog: class {}, FormApplication: class {} } },
    applications: { api: { ApplicationV2: TestApplication, DialogV2: class {}, HandlebarsApplicationMixin: Base => Base } },
    utils: {
      deepClone: value => structuredClone(value),
      escapeHTML: value => String(value),
      mergeObject: (base, update) => ({ ...base, ...update }),
      randomID: () => "id",
    },
  };
  SystemAdapter._current = {
    allocationUnitLabel: "points",
    formatBdaBadge: value => String(value),
    getHitBonusStep: () => 2,
    getDefaultRoleSkillMapping: () => ({
      captain: "leadership",
      engineer: "engineering",
      gunner: "gunnery",
      ordnance: "leadership",
      pilot: "piloting",
      sensors: "sensors",
    }),
    getModifierStepSize: () => 1,
    getSkillLabel: key => key,
    hullDisplayMode: "damageTaken",
    resolveSkill: key => ({ key }),
  };

  try {
    const [gunner, ordnance, pilot, captain, sensors] = await Promise.all([
      import("../../scripts/roles/gunner.js"),
      import("../../scripts/roles/ordnance.js"),
      import("../../scripts/roles/pilot.js"),
      import("../../scripts/roles/captain.js"),
      import("../../scripts/roles/sensors.js"),
    ]);
    const base = {
      crewSize: 6,
      movement: { speed: 6, maneuverability: 2 },
      hull: { value: 0, max: 10 },
      shieldPool: { current: 0, committed: 0 },
      conditions: {},
      resources: {
        engineer: { auxiliaryPower: 30 },
        pilot: {},
        gunner: {},
        captain: { hand: [], drawPile: [], discardPile: [] },
        ordnance: { manpower: 10, manpowerMax: 10, commitments: [] },
        sensors: { locks: [], bdaAttacks: {} },
      },
      turnDone: {},
    };

    const unrolledGunner = gunner.buildGunnerContext(base, { reactorStats: {}, ordnanceBayStats: {} });
    assert.equal(unrolledGunner.ordnanceRolled, false);
    assert.equal(unrolledGunner.allocLocked, true);
    const rolledGunner = gunner.buildGunnerContext({
      ...base,
      resources: { ...base.resources, gunner: { ordnanceRolled: true, ordnanceSL: 3 } },
    }, { reactorStats: {}, ordnanceBayStats: {} });
    assert.equal(rolledGunner.allocLocked, false);
    const committedGunner = gunner.buildGunnerContext({
      ...base,
      resources: { ...base.resources, gunner: { ordnanceRolled: true, firedWeaponIds: ["weapon"] } },
    }, { reactorStats: {}, ordnanceBayStats: {} });
    assert.equal(committedGunner.allocationLocked, true);

    const staleCommitment = {
      ...base,
      resources: {
        ...base.resources,
        ordnance: { ...base.resources.ordnance, commitments: [{ id: "old", turnsRemaining: 0 }] },
      },
    };
    const ordnanceContext = ordnance.buildOrdnanceContext(staleCommitment, { ordnanceBayStats: { manpower: 10 } });
    assert.equal(ordnanceContext.canRollOrdnanceMaster, true);
    assert.equal(ordnanceContext.allocationLocked, true);
    const rolledOrdnance = ordnance.buildOrdnanceContext({
      ...base,
      resources: { ...base.resources, ordnance: { ...base.resources.ordnance, bosunRolled: true } },
    }, { ordnanceBayStats: { manpower: 10 } });
    assert.equal(rolledOrdnance.canRollOrdnanceMaster, false);

    assert.equal(pilot.buildHelmContext(base).hasRolledPiloting, false);
    const committedPilot = pilot.buildHelmContext({
      ...base,
      resources: { ...base.resources, pilot: { pilotingMessageId: "roll", fuelBurned: 20 } },
    });
    assert.equal(committedPilot.hasRolledPiloting, true);
    assert.equal(committedPilot.allocLocked, true);

    const unrolledCaptain = captain.buildCaptainContext(base, { reactorStats: {} });
    assert.equal(unrolledCaptain.leadershipRolled, false);
    const completedCaptain = captain.buildCaptainContext({
      ...base,
      turnDone: { captain: true },
      resources: { ...base.resources, captain: { ...base.resources.captain, leadershipRolled: true, allocationLocked: true } },
    }, { reactorStats: {} });
    assert.equal(completedCaptain.leadershipRolled, true);
    assert.equal(completedCaptain.allocationLocked, true);

    assert.equal(sensors.buildSensorsContext(base, { reactorStats: {} }).actionUsed, false);
    const usedSensors = sensors.buildSensorsContext({
      ...base,
      resources: { ...base.resources, sensors: { ...base.resources.sensors, actionUsed: true } },
    }, { reactorStats: {} });
    assert.equal(usedSensors.actionUsed, true);
  } finally {
    globalThis.game = previous.game;
    globalThis.canvas = previous.canvas;
    globalThis.foundry = previous.foundry;
    globalThis.Application = previous.Application;
    SystemAdapter._current = previous.adapter;
  }
});
