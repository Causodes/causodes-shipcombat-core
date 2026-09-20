import assert from "node:assert/strict";
import test from "node:test";

import {
  actorTypeHasOrdnanceLifecycle,
  canSetOrdnanceTurnDone,
  getOrdnanceLaunchTurnState,
  getOrdnanceLifecycleTransition,
  processParentOrdnanceLifecycle,
} from "../../scripts/state/ordnance-turn-state.js";
import { setModuleId } from "../../scripts/constants.js";
import { setOrdnanceTurnDone } from "../../scripts/state/ordnance-state.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";
import { installFoundryStateHarness, RecordingDocument } from "./helpers/foundry-state-harness.mjs";

class TestAdapter extends SystemAdapter {}

setModuleId("test-shipcombat");
SystemAdapter.register(new TestAdapter());

test("every ordnance subtype receives its complete launch state", () => {
  assert.deepEqual(getOrdnanceLaunchTurnState("torpedo"), {
    turnComplete: true,
    launchDriftPending: true,
  });
  assert.deepEqual(getOrdnanceLaunchTurnState("strikeCraft"), {
    turnComplete: false,
    launchDriftPending: false,
  });
});

test("turn-completion validation covers the complete Boolean state space", () => {
  for (const subtype of ["torpedo", "strikeCraft"]) {
    for (const turnComplete of [false, true]) {
      for (const launchDriftPending of [false, true]) {
        for (const requestedDone of [false, true]) {
          const expected = !(
            subtype === "torpedo" && launchDriftPending && !requestedDone
          );
          assert.equal(
            canSetOrdnanceTurnDone(
              { subtype, turnComplete, launchDriftPending },
              requestedDone,
            ),
            expected,
            JSON.stringify({ subtype, turnComplete, launchDriftPending, requestedDone }),
          );
        }
      }
    }
  }
});

test("lifecycle transitions cover and clear every persisted turn state", () => {
  for (const subtype of ["torpedo", "strikeCraft"]) {
    for (const turnComplete of [false, true]) {
      for (const launchDriftPending of [false, true]) {
        const transition = getOrdnanceLifecycleTransition({
          subtype,
          turnComplete,
          launchDriftPending,
        });
        assert.deepEqual(transition, {
          wasTurnComplete: turnComplete,
          isLaunchTurn: subtype === "torpedo" && launchDriftPending,
          nextTurnComplete: false,
          nextLaunchDriftPending: false,
        });
      }
    }
  }
});

test("all and only ordnance-launching parent actor types receive lifecycle processing", () => {
  const moduleId = "causodes-shipcombat-core";
  assert.equal(actorTypeHasOrdnanceLifecycle(`${moduleId}.ship`, moduleId), true);
  assert.equal(actorTypeHasOrdnanceLifecycle(`${moduleId}.npcShip`, moduleId), true);
  assert.equal(actorTypeHasOrdnanceLifecycle(`${moduleId}.shipOrdnance`, moduleId), false);
  assert.equal(actorTypeHasOrdnanceLifecycle("pf2e.character", moduleId), false);
  assert.equal(actorTypeHasOrdnanceLifecycle(null, moduleId), false);
});

test("parent lifecycle dispatch invokes the matching player and NPC state exactly once", async () => {
  const moduleId = "causodes-shipcombat-core";
  const calls = [];
  const stateClass = {
    forShip(actor) {
      return {
        async processOrdnanceLifecycle(parentActor) {
          calls.push([actor, parentActor]);
        },
      };
    },
  };
  const player = { id: "player", type: `${moduleId}.ship` };
  const npc = { id: "npc", type: `${moduleId}.npcShip` };
  const ordnance = { id: "torpedo", type: `${moduleId}.shipOrdnance` };

  assert.equal(await processParentOrdnanceLifecycle(player, { moduleId, stateClass }), true);
  assert.equal(await processParentOrdnanceLifecycle(npc, { moduleId, stateClass }), true);
  assert.equal(await processParentOrdnanceLifecycle(ordnance, { moduleId, stateClass }), false);
  assert.equal(await processParentOrdnanceLifecycle(null, { moduleId, stateClass }), false);
  assert.deepEqual(calls, [[player, player], [npc, npc]]);
});

test("authoritative turn handler rejects launch-drift bypass before writing", async () => {
  const actor = new RecordingDocument({
    type: "test-shipcombat.shipOrdnance",
    system: {
      subtype: "torpedo",
      turnComplete: true,
      launchDriftPending: true,
    },
  });
  installFoundryStateHarness([{ id: "ordnance", actor }]);

  assert.equal(await setOrdnanceTurnDone("ordnance", false), false);
  assert.deepEqual(actor.updates, []);

  actor.system.launchDriftPending = false;
  assert.equal(await setOrdnanceTurnDone("ordnance", false), true);
  assert.deepEqual(actor.updates, [{ "system.turnComplete": false }]);
  assert.equal(actor.system.turnComplete, false);
});

test("authoritative state harness exposes failed writes without mutating its snapshot", async () => {
  const actor = new RecordingDocument({
    type: "test-shipcombat.shipOrdnance",
    system: {
      subtype: "strikeCraft",
      turnComplete: false,
      launchDriftPending: false,
    },
  });
  installFoundryStateHarness([{ id: "craft", actor }]);
  actor.failNextUpdate = new Error("simulated persistence failure");

  await assert.rejects(
    setOrdnanceTurnDone("craft", true),
    /simulated persistence failure/,
  );
  assert.equal(actor.system.turnComplete, false);
  assert.deepEqual(actor.updates, []);
});
