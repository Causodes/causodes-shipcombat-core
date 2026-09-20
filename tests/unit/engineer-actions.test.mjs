import assert from "node:assert/strict";
import test from "node:test";

import {
  commitAuxCore,
  commitShieldCores,
  dispatchStagedCores,
  emergencyVent,
  fluxToCharge,
  manageHeat,
  reduceInternalFire,
  repairHull,
  stagePowerCore,
  uncommitAuxCore,
  uncommitShieldCore,
  unstagePowerCore,
} from "../../scripts/state/engineer-state.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

function engineerData(overrides = {}) {
  return {
    crewSize: 4,
    hull: { value: 5, max: 10 },
    internalFire: 0,
    conditions: {},
    assignedCores: {},
    shieldPool: { current: 3, committed: 1 },
    shields: { bow: 1, stern: 0, port: 0, starboard: 0 },
    resources: {
      engineer: {
        powerCores: 3,
        coreCount: 0,
        stagedCores: {},
        stagedShieldCores: 0,
        stagedAuxCores: 0,
        committedAuxCores: 0,
        auxiliaryPower: 5,
        heat: 4,
        heatCoresStaged: 2,
        fireCoresStaged: 2,
        repairAuxPowerStaged: 2,
      },
      captain: { coreCount: 0 },
      pilot: { coreCount: 0 },
      sensors: { coreCount: 0 },
      gunner: { coreCount: 0 },
      ordnance: { coreCount: 0 },
    },
    ...overrides,
  };
}

function engineerState(data) {
  const updates = [];
  return {
    ship: { system: data },
    updates,
    getData: () => data,
    update: async change => updates.push(change),
    withPowerCoreTransaction: callback => callback(),
    getShieldStats: () => ({ maxVoidFlux: 8, fluxToAPRate: 2 }),
    getReactorStats: () => ({ shieldStrengthPerCore: 2, heatCapacity: 10, auxPowerCapacity: 10 }),
  };
}

test("Engineer staging, dispatch, shield, and auxiliary branches emit complete single writes", async () => {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  globalThis.game = { i18n: { localize: key => key } };
  globalThis.ui = { notifications: { warn: () => {} } };
  try {
    const staged = engineerState(engineerData());
    assert.equal(await stagePowerCore.call(staged, "pilot"), true);
    assert.deepEqual(staged.updates[0], {
      "resources.engineer.stagedCores.pilot": true,
      "resources.engineer.powerCores": 2,
    });

    const unstagedData = engineerData();
    unstagedData.resources.engineer.stagedCores.pilot = true;
    const unstaged = engineerState(unstagedData);
    assert.equal(await unstagePowerCore.call(unstaged, "pilot"), true);
    assert.deepEqual(unstaged.updates[0], {
      "resources.engineer.stagedCores.pilot": false,
      "resources.engineer.powerCores": 4,
    });

    const dispatchData = engineerData();
    dispatchData.resources.engineer.stagedCores = { pilot: true, sensors: true };
    dispatchData.resources.engineer.stagedShieldCores = 2;
    dispatchData.resources.engineer.stagedAuxCores = 1;
    const dispatched = engineerState(dispatchData);
    assert.equal(await dispatchStagedCores.call(dispatched), true);
    assert.equal(dispatched.updates.length, 1);
    assert.equal(dispatched.updates[0]["resources.pilot.coreCount"], 1);
    assert.equal(dispatched.updates[0]["resources.captain.coreCount"], 1);
    assert.equal(dispatched.updates[0]["shieldPool.committed"], 3);
    assert.equal(dispatched.updates[0]["resources.engineer.committedAuxCores"], 1);

    const shield = engineerState(engineerData());
    assert.equal(await commitShieldCores.call(shield, 2), true);
    assert.deepEqual(shield.updates[0], {
      "resources.engineer.powerCores": 1,
      "resources.engineer.stagedShieldCores": 2,
    });

    const unshieldData = engineerData();
    unshieldData.resources.engineer.stagedShieldCores = 1;
    const unshield = engineerState(unshieldData);
    assert.equal(await uncommitShieldCore.call(unshield), true);
    assert.equal(unshield.updates[0]["resources.engineer.powerCores"], 4);

    const aux = engineerState(engineerData());
    assert.equal(await commitAuxCore.call(aux), true);
    assert.equal(aux.updates[0]["resources.engineer.stagedAuxCores"], 1);

    const unauxData = engineerData();
    unauxData.resources.engineer.stagedAuxCores = 1;
    const unaux = engineerState(unauxData);
    assert.equal(await uncommitAuxCore.call(unaux), true);
    assert.equal(unaux.updates[0]["resources.engineer.powerCores"], 4);
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
});

test("every Engineer repair and conversion branch commits its full resource effect once", async () => {
  const previous = { adapter: SystemAdapter._current, game: globalThis.game, ui: globalThis.ui };
  SystemAdapter._current = {
    getShipData: actor => actor?.system ?? actor,
    hullDisplayMode: "hpRemaining",
  };
  globalThis.game = { i18n: { localize: key => key } };
  globalThis.ui = { notifications: { warn: () => {} } };
  try {
    const vent = engineerState(engineerData());
    assert.equal(await emergencyVent.call(vent), true);
    assert.deepEqual(vent.updates[0], {
      "resources.engineer.heat": 0,
      internalFire: 4,
      ventPending: true,
    });

    const fireData = engineerData({ internalFire: 6 });
    const fire = engineerState(fireData);
    assert.equal(await reduceInternalFire.call(fire, 5, 2), true);
    assert.deepEqual(fire.updates[0], {
      internalFire: 1,
      "resources.engineer.auxiliaryPower": 3,
      "resources.engineer.fireCoresStaged": 1,
    });

    const heat = engineerState(engineerData());
    assert.equal(await manageHeat.call(heat, 2, 3), true);
    assert.equal(heat.updates[0]["resources.engineer.auxiliaryPower"], 3);
    assert.equal(heat.updates[0]["resources.engineer.heat"], 0);
    assert.equal(heat.updates[0]["resources.engineer.heatCoresStaged"], 1);

    const repair = engineerState(engineerData());
    assert.equal(await repairHull.call(repair, 2, 2), true);
    assert.deepEqual(repair.updates[0], {
      "resources.engineer.auxiliaryPower": 3,
      "resources.engineer.heat": 8,
      "resources.engineer.repairAuxPowerStaged": 1,
      "hull.value": 9,
    });

    const flux = engineerState(engineerData());
    assert.equal(await fluxToCharge.call(flux), true);
    assert.deepEqual(flux.updates[0], {
      "shieldPool.current": 2,
      "resources.engineer.auxiliaryPower": 7,
    });
  } finally {
    SystemAdapter._current = previous.adapter;
    globalThis.game = previous.game;
    globalThis.ui = previous.ui;
  }
});
