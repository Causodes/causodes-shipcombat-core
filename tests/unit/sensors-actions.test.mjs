import test from "node:test";
import assert from "node:assert/strict";

import { AUGUR_CORE_ACTIONS, AUGUR_LOCK_ACTIONS, AUGUR_UTILITY_ACTIONS } from "../../scripts/constants.js";
import { executeSensorAction, executeSensorCoreAction } from "../../scripts/state/sensors-state.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

function installFoundryBoundary() {
  const previous = {
    game: globalThis.game,
    canvas: globalThis.canvas,
    CONST: globalThis.CONST,
    adapter: SystemAdapter._current,
  };
  const targetActor = { id: "target-actor", type: "test.npcShip", system: {} };
  const target = {
    id: "target-token",
    x: 100,
    y: 0,
    visible: true,
    actor: targetActor,
    document: { id: "target-token", name: "Target", width: 1, height: 1, disposition: -1, actor: targetActor },
  };
  const own = {
    id: "own-token",
    x: 0,
    y: 0,
    document: { id: "own-token", width: 1, height: 1, disposition: 1 },
  };
  globalThis.CONST = { TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
  globalThis.game = { user: { isGM: true } };
  globalThis.canvas = {
    grid: { size: 100 },
    tokens: {
      get: id => id === target.id ? target : null,
      placeables: [target],
    },
  };
  SystemAdapter._current = { getShipData: actor => actor?.system ?? {} };
  return {
    target,
    own,
    restore() {
      globalThis.game = previous.game;
      globalThis.canvas = previous.canvas;
      globalThis.CONST = previous.CONST;
      SystemAdapter._current = previous.adapter;
    },
  };
}

function sensorState({ tier = 0, effectResult = true } = {}) {
  const data = {
    crewSize: 6,
    resources: {
      engineer: { auxiliaryPower: 100 },
      sensors: { actionUsed: false, coreCount: 1, coreActionsPlayed: [] },
    },
  };
  const updates = [];
  const effects = [];
  const ship = { id: "ship", system: data, getActiveTokens: () => [globalThis.__sensorOwnToken] };
  return {
    ship,
    data,
    updates,
    effects,
    withAllocationTransaction: callback => callback(),
    withPowerCoreTransaction: callback => callback(),
    withActorActionTransaction: (_actor, callback) => callback(),
    getData: () => data,
    getSensorStats: () => ({ apCostMultiplier: 1 }),
    getEffectiveLockTier: () => tier,
    hasEffectiveLock: () => true,
    update: async change => { updates.push(change); return true; },
    upgradeLock: async payload => { effects.push(["upgradeLock", payload]); return effectResult; },
    addSensorEffect: async payload => { effects.push(["addSensorEffect", payload]); return effectResult; },
    torpedoPowerBoost: async tokenId => { effects.push(["torpedoPowerBoost", tokenId]); return effectResult; },
    designateHostileTorpedo: async tokenId => { effects.push(["designateHostileTorpedo", tokenId]); return effectResult; },
    stripQuadrantShields: async payload => { effects.push(["stripQuadrantShields", payload]); return effectResult; },
    upgradeAllLocks: async payload => { effects.push(["upgradeAllLocks", payload]); return effectResult; },
  };
}

test("every normal Sensors action reserves AP and resolves its production branch", async () => {
  const boundary = installFoundryBoundary();
  globalThis.__sensorOwnToken = boundary.own;
  try {
    for (const action of [...AUGUR_LOCK_ACTIONS, ...AUGUR_UTILITY_ACTIONS]) {
      const tier = action.requiresTier ?? 1;
      const state = sensorState({ tier });
      const targetTokenId = action.targeted === false || action.requiresAnyLock ? null : boundary.target.id;
      const result = await executeSensorAction.call(state, { actionId: action.id, targetTokenId });
      assert.deepEqual(result, { ok: true, apCost: action.cost }, action.id);
      assert.equal(state.updates[0]["resources.engineer.auxiliaryPower"], 100 - action.cost, action.id);
      assert.equal(state.updates[0]["resources.sensors.actionUsed"], true, action.id);
      assert.equal(state.effects.length, 1, `${action.id} effect count`);
    }
  } finally {
    delete globalThis.__sensorOwnToken;
    boundary.restore();
  }
});

test("every Sensors Core action atomically reserves its core and AP before its effect", async () => {
  const boundary = installFoundryBoundary();
  globalThis.__sensorOwnToken = boundary.own;
  try {
    for (const action of AUGUR_CORE_ACTIONS) {
      const state = sensorState({ tier: 1 });
      const result = await executeSensorCoreAction.call(state, {
        actionId: action.id,
        targetTokenId: action.targeted ? boundary.target.id : null,
      });
      assert.deepEqual(result, { ok: true, apCost: action.ap }, action.id);
      assert.equal(state.updates[0]["resources.sensors.coreCount"], 0, action.id);
      assert.equal(state.updates[0]["resources.engineer.auxiliaryPower"], 100 - action.ap, action.id);
      assert.deepEqual(state.updates[0]["resources.sensors.coreActionsPlayed"], [action.id], action.id);
      const expectedEffectCount = action.targeted ? 2 : 1;
      assert.equal(state.effects.length, expectedEffectCount, `${action.id} effect count`);
    }
  } finally {
    delete globalThis.__sensorOwnToken;
    boundary.restore();
  }
});

test("Sensors effect failure restores every reserved resource", async () => {
  const boundary = installFoundryBoundary();
  globalThis.__sensorOwnToken = boundary.own;
  try {
    const normal = sensorState({ tier: 0, effectResult: false });
    assert.deepEqual(await executeSensorAction.call(normal, {
      actionId: "activePing",
      targetTokenId: boundary.target.id,
    }), { ok: false, reason: "effectFailed", rolledBack: true });
    assert.deepEqual(normal.updates.at(-1), {
      "resources.engineer.auxiliaryPower": 100,
      "resources.sensors.actionUsed": false,
    });

    const core = sensorState({ tier: 1, effectResult: false });
    assert.deepEqual(await executeSensorCoreAction.call(core, {
      actionId: "signalInversion",
      targetTokenId: boundary.target.id,
    }), { ok: false, reason: "effectFailed", rolledBack: true });
    assert.deepEqual(core.updates.at(-1), {
      "resources.sensors.coreCount": 1,
      "resources.engineer.auxiliaryPower": 100,
      "resources.sensors.coreActionsPlayed": [],
    });
  } finally {
    delete globalThis.__sensorOwnToken;
    boundary.restore();
  }
});
