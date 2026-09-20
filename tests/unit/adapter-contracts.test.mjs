import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulesRoot = path.dirname(coreRoot);

globalThis.ShipCombat = {
  _api: {
    SystemAdapter,
    createActionRequester: () => async () => false,
  },
};
globalThis.CONFIG = {
  DND5E: {
    damageTypes: {
      fire: { label: "Fire", isPhysical: false },
      piercing: { label: "Piercing", isPhysical: true },
    },
  },
  PF2E: {
    skills: { diplomacy: {} },
    damageTypes: { fire: "PF2E.Damage.Fire", piercing: "PF2E.Damage.Piercing" },
  },
};
globalThis.game = { i18n: { lang: "en", localize: key => key } };
globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor?.id }) };

class DeterministicRoll {
  constructor(formula, data = {}) {
    this.formula = formula;
    this.data = data;
    this.total = null;
  }

  async evaluate() {
    const die = this.formula.includes("1d10") ? 6 : 11;
    const literal = this.formula.match(/\+\s*(-?\d+(?:\.\d+)?)\s*$/)?.[1];
    const modifier = literal === undefined
      ? Number(this.data.mod ?? this.data.val ?? 0)
      : Number(literal);
    this.total = die + modifier;
    return this;
  }

  async toMessage(messageData) {
    return { id: "message", messageData, roll: this };
  }
}

globalThis.Roll = DeterministicRoll;

const adapterCases = [
  {
    moduleId: "causodes-shipcombat-dnd5e",
    file: "scripts/systems/dnd5e-adapter.js",
    exportName: "Dnd5eAdapter",
    hullDisplayMode: "hpRemaining",
  },
  {
    moduleId: "causodes-shipcombat-sf2e",
    file: "scripts/systems/sf2e-adapter.js",
    exportName: "Sf2eAdapter",
    hullDisplayMode: "hpRemaining",
  },
  {
    moduleId: "causodes-shipcombat-impmal",
    file: "scripts/systems/impmal-adapter.js",
    exportName: "ImpmalAdapter",
    hullDisplayMode: "damageTaken",
  },
];

test("every companion adapter preserves the shared identity and storage contract", async t => {
  for (const adapterCase of adapterCases) {
    await t.test(adapterCase.moduleId, async () => {
      const adapterPath = path.join(modulesRoot, adapterCase.moduleId, adapterCase.file);
      assert.equal(fs.existsSync(adapterPath), true, `missing adapter under test: ${adapterPath}`);
      const module = await import(pathToFileURL(adapterPath));
      const adapter = new module[adapterCase.exportName]();

      assert.equal(adapter.moduleId, adapterCase.moduleId);
      assert.equal(adapter.hullDisplayMode, adapterCase.hullDisplayMode);
      assert.equal(adapter.systemPath("resources.pilot.bearing"), "system.resources.pilot.bearing");

      const system = { hull: { value: 7 }, resources: { pilot: { bearing: 15 } } };
      assert.equal(adapter.getShipData({ system }), system);
    });
  }
});

test("every companion executes its player and NPC initiative contract", async t => {
  const cases = [
    {
      ...adapterCases[0],
      crew: { id: "crew", system: { skills: { per: { total: 4 } } } },
      expectedPlayerTotal: 15,
      expectedPlayerFormula: "1d20 + @mod",
      npcAttribute: 3,
      expectedNpcTotal: 14,
    },
    {
      ...adapterCases[1],
      crew: { id: "crew", skills: { diplomacy: { check: { mod: 5 } } } },
      expectedPlayerTotal: 16,
      expectedPlayerFormula: "1d20 + @mod",
      npcAttribute: 2,
      expectedNpcTotal: 13,
    },
    {
      ...adapterCases[2],
      crew: {
        id: "crew",
        system: {
          skills: {
            presence: {
              total: 31,
              specialisations: [{ name: "Leadership", system: { total: 41 } }],
            },
          },
        },
        itemTypes: { specialisation: [] },
      },
      expectedPlayerTotal: 6.41,
      expectedPlayerFormula: "1d10 + 0.41",
      npcAttribute: 37,
      expectedNpcTotal: 6.37,
    },
  ];

  for (const adapterCase of cases) {
    await t.test(adapterCase.moduleId, async () => {
      const adapterPath = path.join(modulesRoot, adapterCase.moduleId, adapterCase.file);
      assert.equal(fs.existsSync(adapterPath), true, `missing adapter under test: ${adapterPath}`);
      const module = await import(pathToFileURL(adapterPath));
      const adapter = new module[adapterCase.exportName]();

      const player = await adapter.rollShipInitiative(
        adapterCase.crew,
        "leadership",
        { flavor: "player initiative", speaker: { actor: "crew" } },
      );
      assert.equal(player.roll.formula, adapterCase.expectedPlayerFormula);
      assert.equal(player.total, adapterCase.expectedPlayerTotal);
      assert.equal(player.message.messageData.flavor, "player initiative");

      const npc = await adapter.rollShipInitiativeFromAttribute(
        adapterCase.npcAttribute,
        "NPC initiative",
        { speaker: { actor: "npc" } },
      );
      assert.equal(npc.total, adapterCase.expectedNpcTotal);
      assert.equal(npc.message.messageData.flavor, "NPC initiative");
    });
  }
});

test("every companion executes its component damage and schema-extension contract", async t => {
  const cases = [
    {
      ...adapterCases[0],
      weapon: { system: { diceCount: 2, dieSize: "d8", bonus: "3", damageType: "piercing" } },
      expectedFormula: "2d8 + 3",
      expectedType: "Piercing",
      expectedChoices: ["Fire", "Piercing"],
    },
    {
      ...adapterCases[1],
      weapon: { system: { diceCount: 3, dieSize: "d10", damageType: "fire" } },
      expectedFormula: "3d10",
      expectedType: "PF2E.Damage.Fire",
      expectedChoices: ["PF2E.Damage.Fire", "PF2E.Damage.Piercing"],
    },
    {
      ...adapterCases[2],
      weapon: { system: { damage: "4d6 + 2", damageType: "energy" } },
      expectedFormula: "4d6 + 2",
      expectedType: null,
      expectedChoices: [],
    },
  ];

  for (const adapterCase of cases) {
    await t.test(adapterCase.moduleId, async () => {
      const adapterPath = path.join(modulesRoot, adapterCase.moduleId, adapterCase.file);
      assert.equal(fs.existsSync(adapterPath), true, `missing adapter under test: ${adapterPath}`);
      const module = await import(pathToFileURL(adapterPath));
      const adapter = new module[adapterCase.exportName]();
      assert.equal(adapter.getWeaponDamageFormula(adapterCase.weapon), adapterCase.expectedFormula);
      assert.equal(adapter.getWeaponDamageType(adapterCase.weapon), adapterCase.expectedType);
      assert.deepEqual(adapter.getDamageTypeChoices().map(choice => choice.label), adapterCase.expectedChoices);
      for (const slot of ["weapon", "armour", "engine", "sensor", "reactor", "weaponsBay"]) {
        assert.deepEqual(adapter.getComponentSchemaExtensions(slot), {});
      }
    });
  }
});
