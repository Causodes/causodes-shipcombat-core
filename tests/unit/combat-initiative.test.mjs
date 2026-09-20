import assert from "node:assert/strict";
import test from "node:test";

import {
  installCombatInitiativeHandler,
  resolveCombatantActorType,
  rollCombatInitiative,
} from "../../scripts/combat-initiative.js";
import { setCombatantInitiative } from "../../scripts/initiative.js";

function fixture() {
  const player = {
    id: "player-ship",
    type: "test-adapter.ship",
    system: { roleSkillOverrides: { captain: "presence|Leadership" } },
  };
  const npcBase = {
    id: "npc-ship",
    type: "test-adapter.npcShip",
  };
  const npc = {
    id: "npc-ship",
    type: "vehicle",
    system: { attributes: { piloting: 37 } },
  };
  const ordinary = { id: "ordinary", type: "character", system: {} };
  const entries = new Map([
    ["player", { id: "player", actor: player }],
    ["npc", { id: "npc", actorId: npcBase.id, actor: npc, token: { baseActor: npcBase } }],
    ["ordinary", { id: "ordinary", actor: ordinary }],
  ]);
  const initiative = new Map();
  const combat = {
    combatants: entries,
    async setInitiative(id, total) {
      initiative.set(id, total);
      entries.get(id).initiative = total;
    },
  };
  return { player, npc, npcBase, ordinary, combat, initiative };
}

function dependencies(state) {
  const crew = { id: "captain" };
  const calls = { player: [], npc: [], recorded: [], delegated: [] };
  const adapter = {
    getShipData: actor => actor.system,
    async rollShipInitiative(actor, skill, options) {
      calls.player.push({ actor, skill, options });
      return { total: 8.41 };
    },
    async rollShipInitiativeFromAttribute(value, label, options) {
      calls.npc.push({ value, label, options });
      return { total: 6.37 };
    },
    toCombatantInitiative: total => total,
  };
  return {
    crew,
    calls,
    adapter,
    resolveCaptain: async () => crew,
    recordPlayerInitiative: async input => {
      calls.recorded.push(input);
      await input.combat.setInitiative(input.combatantId, input.rawTotal);
    },
    localize: key => key,
    getSpeaker: actor => ({ actor: actor.id }),
    warn: () => assert.fail("unexpected warning"),
    delegate: async (ids, options) => {
      calls.delegated.push({ ids, options });
      return state.combat;
    },
  };
}

test("one executable contract rolls player, NPC, and native combatants", async () => {
  const state = fixture();
  const deps = dependencies(state);
  const options = { updateTurn: false };
  const result = await rollCombatInitiative({
    combat: state.combat,
    ids: ["player", "npc", "ordinary"],
    options,
    moduleId: "test-adapter",
    ...deps,
  });

  assert.equal(result, state.combat);
  assert.equal(deps.calls.player.length, 1);
  assert.equal(deps.calls.player[0].actor, deps.crew);
  assert.equal(deps.calls.player[0].skill, "presence|Leadership");
  assert.deepEqual(deps.calls.npc.map(call => call.value), [37]);
  assert.deepEqual([...state.initiative], [["player", 8.41], ["npc", 6.37]]);
  assert.deepEqual(deps.calls.delegated, [{ ids: ["ordinary"], options }]);
});

test("ship routing prefers persisted identity over an unlinked Token's synthetic actor type", () => {
  const state = fixture();
  const actors = new Map([[state.npcBase.id, state.npcBase]]);
  const combatant = state.combat.combatants.get("npc");

  assert.equal(resolveCombatantActorType(combatant, actors), "test-adapter.npcShip");
  assert.equal(resolveCombatantActorType({ ...combatant, actorId: "missing" }), "test-adapter.npcShip");
  assert.equal(resolveCombatantActorType({ actor: state.ordinary }), "character");
});

test("a missing captain does not suppress NPC or native initiative", async () => {
  const state = fixture();
  const deps = dependencies(state);
  const warnings = [];
  deps.resolveCaptain = async () => null;
  deps.warn = message => warnings.push(message);

  await rollCombatInitiative({
    combat: state.combat,
    ids: ["player", "npc", "ordinary"],
    moduleId: "test-adapter",
    ...deps,
  });

  assert.deepEqual(warnings, ["SHIPCOMBAT.Warning.NoCaptainAssigned"]);
  assert.equal(deps.calls.player.length, 0);
  assert.deepEqual([...state.initiative], [["npc", 6.37]]);
  assert.deepEqual(deps.calls.delegated[0].ids, ["ordinary"]);
});

test("the installed handler executes the same contract through the host class", async () => {
  const state = fixture();
  const deps = dependencies(state);
  class FakeCombat {
    constructor() { this.combatants = state.combat.combatants; }
    async setInitiative(id, total) {
      state.initiative.set(id, total);
      this.combatants.get(id).initiative = total;
    }
    async rollInitiative(ids, options) {
      deps.calls.delegated.push({ ids, options, receiver: this });
      return this;
    }
  }
  installCombatInitiativeHandler({
    CombatClass: FakeCombat,
    moduleId: "test-adapter",
    adapter: deps.adapter,
    resolveCaptain: deps.resolveCaptain,
    recordPlayerInitiative: deps.recordPlayerInitiative,
    warn: deps.warn,
    localize: deps.localize,
    getSpeaker: deps.getSpeaker,
  });
  const combat = new FakeCombat();
  await combat.rollInitiative(["player", "npc", "ordinary"], { messageOptions: {} });

  assert.deepEqual([...state.initiative], [["player", 8.41], ["npc", 6.37]]);
  assert.equal(deps.calls.delegated.at(-1).receiver, combat);
  assert.deepEqual(deps.calls.delegated.at(-1).ids, ["ordinary"]);
});

test("initiative persistence compensates for a host setter that returns before its update", async () => {
  let finishHostUpdate;
  const hostUpdate = new Promise(resolve => { finishHostUpdate = resolve; });
  const combatant = {
    id: "npc",
    initiative: null,
    updates: [],
    async update(change) {
      this.updates.push(change);
      this.initiative = change.initiative;
    },
  };
  const combat = {
    combatants: new Map([[combatant.id, combatant]]),
    setInitiative(_id, initiative) {
      // Reproduces SF2e's non-native-actor branch: the host delegates its
      // update but returns before that promise can be awaited by Core.
      void hostUpdate.then(() => { combatant.initiative = initiative; });
    },
  };

  const result = await setCombatantInitiative({ combat, combatantId: "npc", initiative: 17 });

  assert.equal(result, 17);
  assert.equal(combatant.initiative, 17);
  assert.deepEqual(combatant.updates, [{ initiative: 17 }]);
  finishHostUpdate();
  await hostUpdate;
  assert.equal(combatant.initiative, 17);
});
