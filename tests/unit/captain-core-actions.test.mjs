import assert from "node:assert/strict";
import test from "node:test";

import {
  beginDeadReckoning,
  cancelDeadReckoning,
  captainCoreAction,
  completeDeadReckoning,
} from "../../scripts/state/captain-state.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

function captainData(overrides = {}) {
  return {
    crewSize: 6,
    conditions: {
      hull: { tier: "low", detail: "hull" },
      engines: { tier: "medium", detail: "engines" },
      coreSystems: { tier: "high", detail: "core" },
    },
    resources: {
      captain: {
        coreCount: 1,
        coreActionsPlayed: [],
        stance: "none",
        pendingStance: "defensive",
        hand: [
          { instanceId: "hand-normal", cardId: "gunsHot", salvaged: false },
          { instanceId: "hand-salvaged", cardId: "hardOver", salvaged: true },
        ],
        drawPile: [
          { instanceId: "draw-a", cardId: "redAlert", salvaged: false },
          { instanceId: "draw-b", cardId: "standDown", salvaged: false },
        ],
        discardPile: [
          { instanceId: "discard-a", cardId: "sensorPriority", salvaged: false },
          { instanceId: "discard-b", cardId: "holdTheLine", salvaged: false },
        ],
        ...overrides,
      },
      sensors: { contacts: {}, nextContactOrdinal: 1 },
    },
  };
}

function stateFor(data, { failWrite = false } = {}) {
  const updates = [];
  const ship = {
    id: "ship",
    uuid: "Actor.ship",
    system: data,
    getActiveTokens: () => [{
      id: "own-token",
      x: 0,
      y: 0,
      document: { id: "own-token", width: 1, height: 1, disposition: 1, actor: null },
    }],
    update: async change => {
      if (failWrite) throw new Error("injected Captain write failure");
      updates.push(change);
    },
  };
  ship.getActiveTokens()[0].document.actor = ship;
  return {
    ship,
    updates,
    getData: () => data,
    update: async change => {
      if (failWrite) throw new Error("injected Captain write failure");
      updates.push(change);
    },
    withAllocationTransaction: callback => callback(),
    withPowerCoreTransaction: callback => callback(),
    getEffectiveLockTier: () => 1,
  };
}

test("every immediate Captain Core action commits its effect and Core spend together", async () => {
  const previous = {
    adapter: SystemAdapter._current,
    game: globalThis.game,
    chatMessage: globalThis.ChatMessage,
    canvas: globalThis.canvas,
    foundry: globalThis.foundry,
    CONST: globalThis.CONST,
  };
  SystemAdapter._current = {
    systemPath: path => path,
    getShipData: actor => actor?.system ?? actor,
  };
  globalThis.game = { i18n: { localize: key => key } };
  globalThis.ChatMessage = { create: async () => ({}) };
  globalThis.foundry = { utils: { deepClone: value => structuredClone(value) } };
  globalThis.CONST = { TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };

  const enemyActor = { id: "enemy" };
  const enemy = {
    id: "enemy-token",
    x: 100,
    y: 0,
    visible: true,
    actor: enemyActor,
    document: {
      id: "enemy-token",
      name: "Enemy",
      width: 1,
      height: 1,
      disposition: -1,
      actor: enemyActor,
    },
  };
  globalThis.canvas = { grid: { size: 100 }, tokens: { get: id => id === enemy.id ? enemy : null } };

  try {
    const cases = [
      ["emergencyProtocols", {}, updates => {
        assert.deepEqual(updates["conditions.hull"], { tier: null });
        assert.equal(updates["conditions.engines"], undefined);
        assert.deepEqual(updates["resources.captain.hand"], []);
      }],
      ["ironCommand", {}, updates => {
        assert.equal(updates["conditions.engines"].tier, "low");
        assert.equal(updates["conditions.coreSystems"].tier, "medium");
        assert.equal(updates["conditions.hull"], undefined);
      }],
      ["battleClarity", { tokenId: enemy.id }, updates => {
        assert.equal(updates["resources.captain.priorityTargetId"], enemy.id);
        assert.equal(updates["resources.sensors.contacts"][enemy.id].confirmed, true);
      }],
      ["emergencySalvage", { cardInstanceId: "discard-a" }, updates => {
        assert.equal(updates["resources.captain.hand"].at(-1).instanceId, "discard-a");
        assert.equal(updates["resources.captain.hand"].at(-1).salvaged, true);
        assert.deepEqual(updates["resources.captain.discardPile"], []);
      }],
      ["commandOverride", {}, updates => {
        assert.equal(updates["resources.captain.stance"], "defensive");
        assert.equal(updates["resources.captain.pendingStance"], "");
      }],
    ];

    for (const [actionId, payload, assertEffect] of cases) {
      const state = stateFor(captainData());
      assert.equal(await captainCoreAction.call(state, { actionId, ...payload }), true, actionId);
      assert.equal(state.updates.length, 1, actionId);
      const updates = state.updates[0];
      assert.equal(updates["resources.captain.coreCount"], 0, actionId);
      assert.deepEqual(updates["resources.captain.coreActionsPlayed"], [actionId], actionId);
      assertEffect(updates);
    }

    const invalid = stateFor(captainData());
    assert.equal(await captainCoreAction.call(invalid, { actionId: "unknown" }), false);
    assert.equal(invalid.updates.length, 0);

    const failed = stateFor(captainData(), { failWrite: true });
    await assert.rejects(
      captainCoreAction.call(failed, { actionId: "commandOverride" }),
      /injected Captain write failure/,
    );
    assert.equal(failed.updates.length, 0);
  } finally {
    SystemAdapter._current = previous.adapter;
    globalThis.game = previous.game;
    globalThis.ChatMessage = previous.chatMessage;
    globalThis.canvas = previous.canvas;
    globalThis.foundry = previous.foundry;
    globalThis.CONST = previous.CONST;
  }
});

test("Dead Reckoning spends once, validates its reservation, and cannot replay", async () => {
  const previous = {
    adapter: SystemAdapter._current,
    game: globalThis.game,
    chatMessage: globalThis.ChatMessage,
    foundry: globalThis.foundry,
  };
  let nextId = 0;
  SystemAdapter._current = { getShipData: actor => actor?.system ?? actor };
  globalThis.game = { i18n: { localize: key => key } };
  globalThis.ChatMessage = { create: async () => ({}) };
  globalThis.foundry = { utils: { randomID: () => `reservation-${++nextId}` } };
  try {
    const data = captainData({ hand: [], coreCount: 1 });
    const state = stateFor(data);
    const reservation = await beginDeadReckoning.call(state);
    assert.equal(reservation.ok, true);
    assert.deepEqual(reservation.cards.map(card => card.instanceId), ["draw-a", "draw-b"]);
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0]["resources.captain.coreCount"], 0);
    assert.deepEqual(state.updates[0]["resources.captain.coreActionsPlayed"], ["deadReckoning"]);

    assert.deepEqual(await completeDeadReckoning.call(state, {
      reservationId: reservation.reservationId,
      orderedInstanceIds: ["draw-b", "draw-a"],
    }), { ok: true });
    assert.deepEqual(
      state.updates[1]["resources.captain.drawPile"].map(card => card.instanceId),
      ["draw-b", "draw-a"],
    );
    assert.deepEqual(await completeDeadReckoning.call(state, {
      reservationId: reservation.reservationId,
      orderedInstanceIds: ["draw-a", "draw-b"],
    }), { ok: false });

    const cancellation = await beginDeadReckoning.call(state);
    assert.equal(cancellation.ok, true);
    assert.deepEqual(await cancelDeadReckoning.call(state, {
      reservationId: cancellation.reservationId,
    }), { ok: true });
    assert.deepEqual(await completeDeadReckoning.call(state, {
      reservationId: cancellation.reservationId,
      orderedInstanceIds: ["draw-a", "draw-b"],
    }), { ok: false });

    const empty = stateFor(captainData({ hand: [], drawPile: [], coreCount: 1 }));
    assert.deepEqual(await beginDeadReckoning.call(empty), { ok: false, reason: "emptyPile" });
    assert.equal(empty.updates.length, 0);
  } finally {
    SystemAdapter._current = previous.adapter;
    globalThis.game = previous.game;
    globalThis.ChatMessage = previous.chatMessage;
    globalThis.foundry = previous.foundry;
  }
});
