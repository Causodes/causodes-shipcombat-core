import assert from "node:assert/strict";
import test from "node:test";

function apply(document, updates) {
  document.updates.push(structuredClone(updates));
  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split(".");
    let cursor = document;
    while (parts.length > 1) cursor = cursor[parts.shift()] ??= {};
    cursor[parts[0]] = value;
  }
}

test("ImpMal legacy actor/item snapshots migrate without touching current documents", async () => {
  const actors = [
    { name: "Legacy ship", type: "impmal-shipcombat.ship", updates: [], async update(u) { apply(this, u); } },
    { name: "Current ship", type: "causodes-shipcombat-impmal.ship", updates: [], async update(u) { apply(this, u); } },
  ];
  const items = [
    { name: "Legacy component", type: "impmal-shipcombat.component", updates: [], async update(u) { apply(this, u); } },
    { name: "Weapon", type: "weapon", updates: [], async update(u) { apply(this, u); } },
  ];
  globalThis.game = { user: { isGM: true }, actors, items };
  const { migrateActorTypes, migrateItemTypes } = await import("../../causodes-shipcombat-impmal/scripts/migrations.js");

  assert.equal(await migrateActorTypes(), 1);
  assert.equal(await migrateItemTypes(), 1);
  assert.equal(actors[0].type, "causodes-shipcombat-impmal.ship");
  assert.equal(items[0].type, "causodes-shipcombat-impmal.component");
  assert.deepEqual(actors[1].updates, []);
  assert.deepEqual(items[1].updates, []);
});

test("ImpMal fractional NPC snapshot normalizes every legacy integer field", async () => {
  const npc = {
    name: "Old NPC",
    type: "causodes-shipcombat-impmal.npcShip",
    _source: { type: "causodes-shipcombat-impmal.npcShip", system: {
      hull: { value: 9.6, max: 20.2 }, movement: { speed: 5.5 }, armour: { bow: 2.4 },
    } },
    system: {}, updates: [], async update(u) { apply(this, u); },
  };
  globalThis.game = { user: { isGM: true }, actors: [npc], items: [] };
  const { migrateNpcIntegerFields } = await import("../../causodes-shipcombat-impmal/scripts/migrations.js");
  assert.equal(await migrateNpcIntegerFields(), 1);
  assert.deepEqual(npc.updates, [{
    "system.hull.value": 10,
    "system.hull.max": 20,
    "system.movement.speed": 6,
    "system.armour.bow": 2,
  }]);
});

test("D&D5e component migration preserves partial diffs and snapshots legacy AC", async () => {
  class TypeDataModel { static migrateData(source) { return source; } }
  class Field { constructor(options) { this.options = options; } }
  globalThis.foundry = {
    abstract: { TypeDataModel },
    data: { fields: new Proxy({}, { get: () => Field }) },
  };
  globalThis.ShipCombat = { _api: { ShipComponentSchemaMixin: Base => class extends Base {} } };
  const { ShipComponentModel } = await import("../../causodes-shipcombat-dnd5e/scripts/items/ShipComponentModel.js");

  assert.deepEqual(ShipComponentModel.migrateData({ acContribution: 3 }), {
    acContribution: 3, acContributionArmor: 3, acContributionEngine: 3,
  });
  assert.deepEqual(ShipComponentModel.migrateData({ equipped: true }), { equipped: true });
  assert.deepEqual(ShipComponentModel.migrateData({ acContributionArmor: null, acContributionEngine: "bad" }), {
    acContributionArmor: 0, acContributionEngine: 0,
  });
});

test("D&D5e unified starship snapshots migrate to each split schema", async () => {
  const { buildLegacyStarshipMigration } = await import(
    "../../causodes-shipcombat-dnd5e/scripts/migrations.js"
  );
  const prefix = "causodes-shipcombat-dnd5e";
  const keys = {
    [`${prefix}.ship`]: ["hull", "traits", "resources", "nameplate"],
    [`${prefix}.npcShip`]: ["hull", "traits", "resources", "nameplate"],
    [`${prefix}.shipOrdnance`]: ["hull", "traits", "resources", "subtype"],
  };
  const base = {
    hull: { value: 50, max: 50 },
    traits: { rend: 2, armourPenetration: 3, shieldBurn: 1, shieldBypass: true, custom: "keep" },
    resources: { pilot: { fuelBurned: 20 } },
    nameplate: "keep",
    obsolete: "drop",
  };

  const player = buildLegacyStarshipMigration({ ...base, shipMode: "player" }, keys);
  assert.equal(player.newType, `${prefix}.ship`);
  assert.deepEqual(player.system.traits, { custom: "keep" });
  assert.deepEqual(player.system.resources, base.resources);
  assert.equal("obsolete" in player.system, false);

  const npc = buildLegacyStarshipMigration({ ...base, shipMode: "npc" }, keys);
  assert.equal(npc.newType, `${prefix}.npcShip`);
  assert.equal("resources" in npc.system, false);
  assert.deepEqual(npc.system.traits, { custom: "keep" });

  const ordnance = buildLegacyStarshipMigration({ ...base, shipMode: "ordnance", subtype: "torpedo" }, keys);
  assert.equal(ordnance.newType, `${prefix}.shipOrdnance`);
  assert.deepEqual(ordnance.system.hull, { value: 1, max: 1 });
  assert.equal(ordnance.system.traits.shieldBypass, true);
});
