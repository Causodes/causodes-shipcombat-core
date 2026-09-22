import assert from "node:assert/strict";
import test from "node:test";

import { CAPTAIN_CARDS } from "../../scripts/constants.js";
import { buildInitialCaptainZones } from "../../scripts/captain/deck-state.js";
import { getCaptainDeckExclusions } from "../../scripts/captain/card-instances.js";
import { mulligan } from "../../scripts/state/captain-state.js";
import { buildCombatStartUpdates } from "../../scripts/state/combat-start.js";
import {
  SHIP_PARTS,
  SHIP_TABS,
  SHIP_TAB_CONTRACTS,
  getCrewLayout,
  isGunnerTab,
  isHelmTab,
} from "../../scripts/actors/ship/parts.js";

const STATIONS = ["captain", "engineer", "pilot", "sensors", "gunner", "ordnance"];
const LAYOUTS = {
  3: { captain: "captain4man", engineer: "engineer3man", gunner: "gunner4man" },
  4: { captain: "captain4man", engineer: "engineer5man", pilot: "pilot", gunner: "gunner4man" },
  5: { captain: "captain5man", engineer: "engineer5man", pilot: "pilot", sensors: "sensors", gunner: "gunner5man" },
  6: { captain: "captain", engineer: "engineer", pilot: "pilot", sensors: "sensors", gunner: "gunner", ordnance: "ordnance" },
};

function eligibleCardIds(crewSize) {
  const { roles, cards } = getCaptainDeckExclusions(crewSize);
  return CAPTAIN_CARDS.flatMap(card => (
    roles.includes(card.targetRole ?? "") || cards.includes(card.id)
      ? []
      : Array(card.copies ?? 1).fill(card.id)
  )).sort();
}

function assertDeckInvariant(crewSize, zones) {
  const all = [...zones.hand, ...zones.drawPile, ...zones.discardPile];
  assert.equal(zones.hand.length, 3, `crew ${crewSize} starting hand`);
  assert.equal(new Set(all.map(card => card.instanceId)).size, all.length, `crew ${crewSize} physical identities`);
  assert.deepEqual(all.map(card => card.cardId).sort(), eligibleCardIds(crewSize), `crew ${crewSize} eligibility`);
}

test("every crew layout assigns every station capability exactly once", () => {
  for (const [crewSize, expectedTabs] of Object.entries(LAYOUTS)) {
    const layout = getCrewLayout(Number(crewSize));
    assert.deepEqual(layout.tabsByRole, expectedTabs, `crew ${crewSize} tab mapping`);
    const capabilities = Object.values(layout.tabsByRole)
      .flatMap(tabId => SHIP_TAB_CONTRACTS[tabId].capabilities)
      .sort();
    assert.deepEqual(capabilities, [...STATIONS].sort(), `crew ${crewSize} station coverage`);
    assert.equal(new Set(capabilities).size, STATIONS.length, `crew ${crewSize} has no duplicate station`);
  }
});

test("every role tab has one template, navigation definition, role, and derived capability", () => {
  const nonRoleTabs = new Set(["header", "tabs", "overview", "config"]);
  assert.deepEqual(Object.keys(SHIP_PARTS).sort(), Object.keys(SHIP_TABS).concat("header", "tabs").sort());
  for (const tabId of Object.keys(SHIP_PARTS)) {
    if (nonRoleTabs.has(tabId)) continue;
    const contract = SHIP_TAB_CONTRACTS[tabId];
    assert.ok(contract, `${tabId} contract`);
    assert.ok(STATIONS.includes(contract.role), `${tabId} canonical role`);
    assert.equal(new Set(contract.capabilities).size, contract.capabilities.length, `${tabId} capabilities unique`);
    assert.equal(isHelmTab(tabId), contract.capabilities.includes("pilot"), `${tabId} Helm routing`);
    assert.equal(isGunnerTab(tabId), contract.capabilities.includes("gunner"), `${tabId} Gunner routing`);
  }
});

test("Captain initialization and Mulligan preserve the complete deck invariant for every crew size", async () => {
  for (const crewSize of [3, 4, 5, 6]) {
    const zones = buildInitialCaptainZones(crewSize);
    assertDeckInvariant(crewSize, zones);
    const data = {
      crewSize,
      resources: { captain: { ...zones, mulligansSpent: 0, allocResolve: 0 } },
    };
    const state = {
      getData: () => data,
      withAllocationTransaction: operation => operation(),
      async update(updates) {
        for (const [path, value] of Object.entries(updates)) {
          const key = path.replace("resources.captain.", "");
          data.resources.captain[key] = value;
        }
      },
    };
    const replaced = zones.hand[0];
    await mulligan.call(state, { cardId: replaced.cardId, cardInstanceId: replaced.instanceId });
    assertDeckInvariant(crewSize, data.resources.captain);
    assert.equal(data.resources.captain.mulligansSpent, 1);
    assert.equal(data.resources.captain.hand.some(card => card.instanceId === replaced.instanceId), false);
    assert.equal(data.resources.captain.discardPile.some(card => card.instanceId === replaced.instanceId), true);
  }
});

test("native combat initialization resets every state family for every crew layout", () => {
  for (const crewSize of [3, 4, 5, 6]) {
    const data = {
      crewSize,
      turnDone: { captain: true, engineer: true },
      overchargeUsed: { captain: true },
      assignedCores: { captain: true },
      reactions: { user: true },
      ordnanceActors: { torpedo: [{}], strikeCraft: [{}] },
      resources: {
        engineer: { stagedCores: { captain: true } },
        sensors: { contacts: { stale: { tier: 2 } } },
      },
    };
    const updates = buildCombatStartUpdates(data, { coreOutput: 7, maxVoidFlux: 11 });
    assert.equal(updates.active, true);
    assert.equal(updates.round, 1);
    assert.equal(updates.internalFire, 0);
    assert.equal(updates["resources.engineer.powerCores"], 7);
    assert.equal(updates["shieldPool.current"], 11);
    assert.equal(updates["shieldPool.committed"], 0);
    assert.equal(updates.ventLocked, false);
    assert.equal(updates.ventPending, false);
    for (const location of ["hull", "engines", "manoeuvring", "coreSystems", "weaponsSensors"]) {
      assert.deepEqual(updates[`conditions.${location}`], { tier: null, lockedRole: null, blindedSectionId: null });
    }
    for (const role of STATIONS) assert.equal(updates[`resources.${role}.coreCount`], 0, `${crewSize}:${role}`);
    for (const role of ["gunner", "pilot", "sensors", "ordnance"]) {
      assert.deepEqual(updates[`resources.${role}.coreActionsPlayed`], [], `${crewSize}:${role}:actions`);
    }
    for (const path of ["turnDone.captain", "turnDone.engineer", "overchargeUsed.captain", "assignedCores.captain", "reactions.user", "resources.engineer.stagedCores.captain"]) {
      assert.equal(updates[path], false, `${crewSize}:${path}`);
    }
    assert.equal(updates["resources.sensors.contacts.-=stale"], null);
    assert.equal(updates["resources.sensors.nextContactOrdinal"], 1);
    assert.equal(updates["resources.sensors.recommendedTargetId"], null);
    assert.equal(updates["resources.ordnance.armedTorpedoes"], 1);
    assert.equal(updates["resources.ordnance.armedCraft"], 1);
    assert.equal(updates["resources.ordnance.availablePayloads"], 1);
    assertDeckInvariant(crewSize, {
      hand: updates["resources.captain.hand"],
      drawPile: updates["resources.captain.drawPile"],
      discardPile: updates["resources.captain.discardPile"],
    });
  }
});
