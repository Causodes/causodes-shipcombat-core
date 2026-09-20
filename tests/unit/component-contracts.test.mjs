import assert from "node:assert/strict";
import test from "node:test";

import { setModuleId } from "../../scripts/constants.js";
import {
  applyComponentSlotToItemData,
  componentSlotUpdates,
  npcComponentDropError,
  playerComponentDropError,
  prepareImportedComponentPlacement,
} from "../../scripts/actors/ship/component-contracts.js";
import { ShipComponentSchemaMixin } from "../../scripts/items/ShipComponentSchema.js";
import { buildComponentTraitUpdates } from "../../scripts/items/component-traits.js";
import { ShipSchemaMixin } from "../../scripts/actors/ship/ShipSchema.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";
import { computeComponentAC } from "../../../causodes-shipcombat-dnd5e/scripts/actors/dnd5e-compat.js";
import { computeComponentArmorClass } from "../../../causodes-shipcombat-sf2e/scripts/actors/ship/component-armor-class.js";
import {
  assignEquipmentComponent,
  assignWeaponComponent,
  getOrdnanceBayComponentStats,
  getReactorComponentStats,
  getSensorComponentStats,
  unassignComponent,
} from "../../scripts/state/component-state.js";

const MODULE_ID = "test-shipcombat";
setModuleId(MODULE_ID);

class TestAdapter extends SystemAdapter {}
SystemAdapter.register(new TestAdapter());

class Field {
  constructor(...args) {
    this.field = args[0] instanceof Field ? args[0] : null;
    this.fields = args[0] && !(args[0] instanceof Field) ? args[0] : null;
    this.options = args.at(-1) ?? {};
    Object.assign(this, this.options);
  }
}

globalThis.foundry = {
  data: {
    fields: new Proxy({}, { get: () => Field }),
  },
};
globalThis.game = { i18n: { localize: key => key } };
globalThis.ui = { notifications: { error() {} } };

test("component schema exposes constrained defaults for every supported subsystem", () => {
  class Base { static defineSchema() { return {}; } }
  const schema = ShipComponentSchemaMixin(Base).defineSchema();

  assert.deepEqual(Object.keys(schema.slot.choices), [
    "weapon", "shields", "armour", "engine", "sensor", "reactor", "weaponsBay",
  ]);
  assert.equal(schema.slot.initial, "weapon");
  assert.equal(schema.equipped.initial, true);
  assert.equal(schema.salvoSize.min, 1);
  assert.equal(schema.degreeOfFire.max, 360);
  assert.equal(schema.apCostMultiplier.initial, 1);
  assert.equal(schema.bayTorpedoSalvoSize.min, 1);
  assert.equal(schema.craftFlightSize.min, 1);
  assert.equal(schema.extended.initial instanceof Object, true);
});

test("component resource and trait projections execute the production model", async () => {
  class Base { static defineSchema() { return {}; } }
  const Model = ShipComponentSchemaMixin(Base);
  assert.equal(Model.resourceForType("macroCannon"), "ammo");
  assert.equal(Model.resourceForType("plasmaCannon"), "heat");
  assert.equal(Model.resourceForType("lanceBattery"), "power");
  assert.equal(Model.resourceForType("pointDefense"), "none");
  assert.equal(Model.resourceForType("unknown"), "ammo");

  const component = Object.assign(Object.create(Model.prototype), {
    slot: "weapon",
    resourceType: "power",
    notes: { player: "crew", gm: "secret" },
    traits: {
      shieldBypass: true,
      rend: 3,
      rendEnabled: true,
      devastating: 4,
      devastatingEnabled: false,
    },
  });
  assert.equal(component.resource, "power");
  assert.equal(
    component.traitsHtml,
    "SHIPCOMBAT.Trait.ShieldBypass, SHIPCOMBAT.Trait.Rend (3)",
  );
  assert.deepEqual(await component.summaryData(), {
    notes: "crew",
    gmnotes: "secret",
    details: { physical: "", item: {} },
    tags: [],
    summaryLabel: "SHIPCOMBAT.Component.Summary",
  });
});

test("trait editor results map to the correct weapon and ordnance paths", () => {
  const weapon = buildComponentTraitUpdates("weapon", {
    shieldBypass: "on",
    "rend-value": "3",
    rendEnabled: true,
    "hitRatingModifier-value": "-2",
    hitRatingModifierEnabled: "on",
  });
  assert.equal(weapon["system.traits.shieldBypass"], true);
  assert.equal(weapon["system.traits.rend"], 3);
  assert.equal(weapon["system.traits.rendEnabled"], true);
  assert.equal(weapon["system.traits.hitRatingModifier"], -2);
  assert.equal(weapon["system.traits.hitRatingModifierEnabled"], true);
  assert.equal(weapon["system.traits.overcharge"], false);

  const torpedo = buildComponentTraitUpdates("torpedo", {
    "shieldBurn-value": "4",
    shieldBurnEnabled: "on",
  });
  assert.equal(torpedo["system.torpedoTraits.shieldBurn"], 4);
  assert.equal(torpedo["system.torpedoTraits.shieldBurnEnabled"], true);
  assert.equal("system.torpedoTraits.unlimitedRof" in torpedo, false);

  const craft = buildComponentTraitUpdates("strikeCraft", { shieldBypass: true });
  assert.equal(craft["system.craftTraits.shieldBypass"], true);
});

test("slot projections are identical for existing and imported components", () => {
  assert.deepEqual(componentSlotUpdates("weapon", "port"), {
    "system.slot": "weapon",
    "system.weaponPosition": "flank",
    "system.weaponBay": "port",
  });
  assert.deepEqual(componentSlotUpdates("weapon", "prow"), {
    "system.slot": "weapon",
    "system.weaponPosition": "prow",
  });
  assert.deepEqual(componentSlotUpdates("engine"), { "system.slot": "engine" });
  assert.deepEqual(componentSlotUpdates(null), {});

  const data = { system: { equipped: true } };
  assert.equal(applyComponentSlotToItemData(data, "weapon", "starboard"), data);
  assert.deepEqual(data.system, {
    equipped: true,
    slot: "weapon",
    weaponPosition: "flank",
    weaponBay: "starboard",
  });
});

test("NPC component validation covers document type, subsystem, and every weapon arc", () => {
  const component = position => ({
    type: `${MODULE_ID}.component`,
    system: { slot: "weapon", weaponPosition: position },
  });
  assert.equal(npcComponentDropError({ type: "weapon" }, "weapon", "prow", MODULE_ID), "SHIPCOMBAT.Warning.OnlyComponents");
  assert.equal(npcComponentDropError({ type: `${MODULE_ID}.component`, system: { slot: "engine" } }, "weapon", "prow", MODULE_ID), "SHIPCOMBAT.Warning.NpcWeaponsOnly");
  assert.equal(npcComponentDropError(component("prow"), "weapon", "port", MODULE_ID), "SHIPCOMBAT.Warning.WrongWeaponSlot");
  assert.equal(npcComponentDropError(component("prow"), "weapon", "prow", MODULE_ID), null);
  assert.equal(npcComponentDropError(component("flank"), "weapon", "port", MODULE_ID), null);
  assert.equal(npcComponentDropError(component("flank"), "weapon", "starboard", MODULE_ID), null);
  assert.equal(npcComponentDropError(component("flank"), "weapon", "stern", MODULE_ID), "SHIPCOMBAT.Warning.WrongWeaponSlot");
});

test("player component validation rejects every non-component Item type", () => {
  assert.equal(playerComponentDropError({ type: `${MODULE_ID}.component` }, MODULE_ID), null);
  for (const type of ["weapon", "equipment", `${MODULE_ID}.payload`, null]) {
    assert.equal(
      playerComponentDropError({ type }, MODULE_ID),
      "SHIPCOMBAT.Warning.OnlyComponents",
    );
  }
});

test("component placement fills capacity deterministically and preserves overflow as inventory", () => {
  const shipData = {
    weaponSlots: { prow: 1, port: 1, starboard: 2 },
    equipmentSlots: { engine: 1 },
  };
  const item = (id, system) => ({ id, type: `${MODULE_ID}.component`, system });
  const existing = [
    item("prow", { slot: "weapon", weaponPosition: "prow", equipped: true }),
    item("port", { slot: "weapon", weaponPosition: "flank", weaponBay: "port", equipped: true }),
    item("engine", { slot: "engine", equipped: true }),
    item("spare", { slot: "engine", equipped: false }),
  ];

  const flank = { system: { slot: "weapon", weaponPosition: "flank" } };
  assert.equal(prepareImportedComponentPlacement(shipData, existing, flank, { moduleId: MODULE_ID }), true);
  assert.equal(flank.system.weaponBay, "starboard");

  const prow = { system: { slot: "weapon", weaponPosition: "prow" } };
  assert.equal(prepareImportedComponentPlacement(shipData, existing, prow, { moduleId: MODULE_ID }), false);
  assert.equal(prow.system.equipped, false);

  const engine = { system: { slot: "engine" } };
  assert.equal(prepareImportedComponentPlacement(shipData, existing, engine, { moduleId: MODULE_ID }), false);
  assert.equal(engine.system.equipped, false);
});

test("only equipped engine and armour components contribute to derived ship statistics", () => {
  class Base {}
  const ShipModel = ShipSchemaMixin(Base);
  const component = (slot, system, equipped = true) => ({
    type: `${MODULE_ID}.component`,
    system: { slot, equipped, ...system },
  });
  const model = Object.assign(Object.create(ShipModel.prototype), {
    parent: { items: [
      component("engine", { speed: 8, maneuverability: 5 }, false),
      component("engine", { speed: 6, maneuverability: 4 }),
      component("armour", { armourValues: { bow: 5, stern: 4, port: 3, starboard: 2 } }),
      component("armour", { armourValues: { bow: 100, stern: 100, port: 100, starboard: 100 } }, false),
    ] },
    movement: { speed: 0, maneuverability: 0 },
    conditions: { engines: { tier: "low" }, manoeuvring: { tier: "medium" } },
    armour: { bow: 0, stern: 0, port: 0, starboard: 0 },
    armourRend: { bow: 1, stern: 0, port: 4, starboard: 0 },
  });
  model.computeDerived();
  assert.deepEqual(model.movement, { speed: 5, maneuverability: 2 });
  assert.deepEqual(model.armour, { bow: 4, stern: 4, port: 0, starboard: 2 });
});

test("component assignment mutations update the intended embedded documents once", async () => {
  const writes = [];
  const items = [
    { id: "engine-a", type: `${MODULE_ID}.component`, system: { slot: "engine" } },
    { id: "engine-b", type: `${MODULE_ID}.component`, system: { slot: "engine" } },
    { id: "sensor", type: `${MODULE_ID}.component`, system: { slot: "sensor" } },
  ];
  const ship = {
    items,
    async updateEmbeddedDocuments(type, updates) {
      writes.push({ type, updates });
      return updates;
    },
  };

  await assignWeaponComponent(ship, { itemId: "weapon", weaponPosition: "flank", weaponBay: "port" });
  await unassignComponent(ship, { itemId: "engine-a" });
  await assignEquipmentComponent(ship, { slotId: "engine", newItemId: "engine-b" });
  assert.deepEqual(writes, [
    { type: "Item", updates: [{ _id: "weapon", "system.equipped": true, "system.weaponPosition": "flank", "system.weaponBay": "port" }] },
    { type: "Item", updates: [{ _id: "engine-a", "system.equipped": false }] },
    { type: "Item", updates: [
      { _id: "engine-a", "system.equipped": false },
      { _id: "engine-b", "system.equipped": true },
    ] },
  ]);
});

test("component stat readers ignore inventory and support adapter-specific reactor output", () => {
  const item = (slot, system, equipped = true) => ({
    type: `${MODULE_ID}.component`, system: { slot, equipped, ...system },
  });
  const ship = { type: `${MODULE_ID}.ship`, system: { resources: { sensors: { effects: [] }, gunner: {} } }, items: [
    item("reactor", { coreOutput: 4, rating: 99, shieldStrengthPerCore: 3, heatCapacity: 8, bankCapacity: 6, reserveMultiplier: 2 }),
    item("reactor", { coreOutput: 100 }, false),
    item("sensor", { rating: 7, bandSize: 2, autoScanRange: 10, maxRange: 20, apCostMultiplier: 0.5 }),
    item("weaponsBay", { bayAmmoCapacity: 12, bayChargeCapacity: 9, bayManpower: 8, bayTorpedoCapacity: 5, bayMaxFlights: 3, bayStrikeCraftCapacity: 7 }),
  ] };
  assert.deepEqual(getReactorComponentStats(ship), {
    coreOutput: 4,
    shieldStrengthPerCore: 3,
    heatCapacity: 8,
    auxPowerCapacity: 6,
    reserveMultiplier: 2,
  });
  assert.deepEqual(getOrdnanceBayComponentStats(ship), {
    ammoCapacity: 12,
    chargeCapacity: 9,
    manpower: 8,
    torpedoCapacity: 5,
    maxFlights: 3,
    strikeCraftCapacity: 7,
  });
  assert.deepEqual(getSensorComponentStats(ship), {
    rating: 7,
    bandSize: 2,
    autoScanRange: 10,
    maxRange: 20,
    apCostMultiplier: 0.5,
  });
});

test("D&D5e component AC includes only equipped armour and engines", () => {
  const model = {
    parent: { items: [
      { type: "causodes-shipcombat-dnd5e.component", system: { slot: "armour", equipped: true, acContributionArmor: 3 } },
      { type: "causodes-shipcombat-dnd5e.component", system: { slot: "engine", equipped: true, acContributionEngine: 2 } },
      { type: "causodes-shipcombat-dnd5e.component", system: { slot: "armour", equipped: false, acContributionArmor: 100 } },
      { type: "weapon", system: { acContributionArmor: 100 } },
    ] },
    attributes: { ac: {} },
  };
  computeComponentAC(model);
  assert.deepEqual(model.attributes.ac, { flat: 5, value: 5 });
});

test("SF2e component AC includes only equipped armour and engines", () => {
  const componentType = "causodes-shipcombat-sf2e.component";
  const items = [
    { type: componentType, system: { slot: "armour", equipped: true, armourClassContribution: 4 } },
    { type: componentType, system: { slot: "engine", equipped: true, armourClassContribution: 2 } },
    { type: componentType, system: { slot: "engine", equipped: false, armourClassContribution: 100 } },
    { type: componentType, system: { slot: "sensor", equipped: true, armourClassContribution: 100 } },
  ];
  assert.equal(computeComponentArmorClass(items), 6);
});
