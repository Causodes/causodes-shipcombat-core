import assert from "node:assert/strict";
import test from "node:test";

import {
  DND5E_SHEET_TEMPLATES,
  extendSchemaFields,
} from "../../../causodes-shipcombat-dnd5e/scripts/actors/dnd5e-compat.js";

test("D&D5e schema extension delegates unchanged to the native v14 API", () => {
  const additions = { hp: {} };
  let calls = 0;
  const schema = {
    extendFields(fields) {
      assert.equal(this, schema);
      assert.equal(fields, additions);
      calls++;
    },
    _initialize() { assert.fail("v14 must not use the v13 fallback"); },
  };
  assert.equal(extendSchemaFields(schema, additions), schema);
  assert.equal(calls, 1);
});

test("D&D5e v13 schema extension initializes only additions and retains bound fields", () => {
  const existing = {};
  const added = {};
  const options = { required: false, label: "Attributes" };
  const schema = {
    fields: { piloting: existing },
    options,
    _initialize(fields) {
      assert.equal(this, schema);
      assert.deepEqual(Object.keys(fields), ["hp"]);
      assert.equal(fields.hp, added);
      assert.equal(existing.parent, schema);
      added.parent = this;
      added.name = "hp";
      return fields;
    },
  };
  existing.parent = schema;
  assert.equal(extendSchemaFields(schema, { hp: added }), schema);
  assert.equal(schema.fields.piloting, existing);
  assert.equal(schema.fields.hp, added);
  assert.equal(added.parent, schema);
  assert.equal(added.name, "hp");
  assert.equal(schema.options, options);
});

test("D&D5e warnings template resolves lazily from each native sheet version", t => {
  const previous = globalThis.dnd5e;
  t.after(() => {
    if (previous === undefined) delete globalThis.dnd5e;
    else globalThis.dnd5e = previous;
  });
  for (const template of [
    "systems/dnd5e/templates/actors/parts/actor-warnings-dialog.hbs",
    "systems/dnd5e/templates/shared/sheet-warnings-dialog.hbs",
  ]) {
    globalThis.dnd5e = {
      applications: { actor: { NPCActorSheet: { PARTS: { warnings: { template } } } } },
    };
    assert.equal(DND5E_SHEET_TEMPLATES.warnings, template);
  }
});
