import assert from "node:assert/strict";
import test from "node:test";

class FoundryApplication {}
globalThis.foundry = {
  appv1: { api: { FormApplication: FoundryApplication, Dialog: FoundryApplication } },
  applications: {
    api: {
      ApplicationV2: FoundryApplication,
      DialogV2: FoundryApplication,
      HandlebarsApplicationMixin: Base => class extends Base {},
    },
  },
  utils: {
    deepClone: value => structuredClone(value),
    escapeHTML: value => String(value),
    mergeObject: (left, right) => ({ ...left, ...right }),
  },
};

const {
  buildPilotCoreUpdates,
  pilotFlipAndBurn,
  pilotOverdrive,
  pilotRetrograde,
  pilotStrafe,
} = await import("../../scripts/state/pilot-state.js");

function pilotData(coreCount = 1) {
  return {
    crewSize: 6,
    resources: {
      pilot: {
        coreCount,
        coreActionsPlayed: [],
        fuelBurned: 10,
        driftBurned: 2,
        bearing: 15,
        prevTurnMove: 10,
        velocityX: 2,
        velocityY: 0,
      },
    },
  };
}

function pilotState(data, { tokenFailure = false } = {}) {
  const actorUpdates = [];
  const tokenUpdates = [];
  const document = {
    x: 0,
    y: 0,
    rotation: -90,
    update: async update => {
      tokenUpdates.push(update);
      if (tokenFailure) throw new Error("injected token movement failure");
    },
  };
  return {
    actorUpdates,
    tokenUpdates,
    ship: { getActiveTokens: () => [{ document }] },
    getData: () => data,
    update: async update => actorUpdates.push(update),
    withAllocationTransaction: callback => callback(),
    withPowerCoreTransaction: callback => callback(),
  };
}

test("Pilot Core projection couples cost, telemetry, and effect", () => {
  assert.deepEqual(buildPilotCoreUpdates(pilotData(), "overdrive", {
    "resources.pilot.overdrive": true,
  }), {
    "resources.pilot.overdrive": true,
    "resources.pilot.coreCount": 0,
    "resources.pilot.coreActionsPlayed": ["overdrive"],
  });
  assert.equal(buildPilotCoreUpdates(pilotData(0), "overdrive", {}), null);
});

test("every Pilot Core branch commits actor state and Core cost in one write", async () => {
  const previousGame = globalThis.game;
  const previousCanvas = globalThis.canvas;
  globalThis.canvas = { grid: { size: 100 } };
  try {
    globalThis.game = { settings: { get: () => "simplified" } };
    const retro = pilotState(pilotData());
    assert.equal(await pilotRetrograde.call(retro, "user", 2), true);
    assert.equal(retro.actorUpdates.length, 1);
    assert.equal(retro.actorUpdates[0]["resources.pilot.prevTurnMove"], 6);
    assert.equal(retro.actorUpdates[0]["resources.pilot.coreCount"], 0);

    const overdrive = pilotState(pilotData());
    assert.equal(await pilotOverdrive.call(overdrive, "user"), true);
    assert.deepEqual(overdrive.actorUpdates, [{
      "resources.pilot.overdrive": true,
      "resources.pilot.coreCount": 0,
      "resources.pilot.coreActionsPlayed": ["overdrive"],
    }]);

    globalThis.game = { settings: { get: () => "realistic" } };
    const strafe = pilotState(pilotData());
    assert.equal(await pilotStrafe.call(strafe, "user", 100, 0, -90, 1, []), true);
    assert.equal(strafe.actorUpdates.length, 1);
    assert.equal(strafe.actorUpdates[0]["resources.pilot.coreCount"], 0);
    assert.deepEqual(strafe.actorUpdates[0]["resources.pilot.coreActionsPlayed"], ["strafe"]);
    assert.deepEqual(strafe.tokenUpdates, [{ x: 100, y: 0, rotation: -90 }]);

    const flip = pilotState(pilotData());
    assert.equal(await pilotFlipAndBurn.call(flip, "user", 3, 300, 0, 90, []), true);
    assert.equal(flip.actorUpdates.length, 1);
    assert.equal(flip.actorUpdates[0]["resources.pilot.fuelBurned"], 60);
    assert.equal(flip.actorUpdates[0]["resources.pilot.velocityX"], 0);
    assert.equal(flip.actorUpdates[0]["resources.pilot.velocityY"], 0);
    assert.equal(flip.actorUpdates[0]["resources.pilot.coreCount"], 0);
  } finally {
    globalThis.game = previousGame;
    globalThis.canvas = previousCanvas;
  }
});

test("failed immediate Pilot token movement compensates the actor-state commit", async () => {
  const previousGame = globalThis.game;
  const previousCanvas = globalThis.canvas;
  globalThis.game = { settings: { get: () => "realistic" } };
  globalThis.canvas = { grid: { size: 100 } };
  try {
    const state = pilotState(pilotData(), { tokenFailure: true });
    await assert.rejects(
      pilotStrafe.call(state, "user", 100, 0, -90, 1, []),
      /injected token movement failure/,
    );
    assert.equal(state.actorUpdates.length, 2);
    assert.equal(state.actorUpdates[0]["resources.pilot.coreCount"], 0);
    assert.equal(state.actorUpdates[1]["resources.pilot.coreCount"], 1);
    assert.deepEqual(state.actorUpdates[1]["resources.pilot.coreActionsPlayed"], []);
    assert.equal(state.actorUpdates[1]["resources.pilot.fuelBurned"], 10);
    assert.equal(state.actorUpdates[1]["resources.pilot.bearing"], 15);
  } finally {
    globalThis.game = previousGame;
    globalThis.canvas = previousCanvas;
  }
});
