import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyLangSubstitutions, registerLangSubstitution } from "../../scripts/lang.js";
import { SystemAdapter } from "../../scripts/systems/SystemAdapter.js";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulesRoot = path.dirname(coreRoot);

function mergeTree(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] ??= {};
      mergeTree(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function unresolvedTokens(value, pathLabel = "") {
  if (typeof value === "string") {
    return /\{\{SHIPCOMBAT\.[\w.-]+\}\}/.test(value)
      ? [{ path: pathLabel, value }]
      : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => (
    unresolvedTokens(child, pathLabel ? `${pathLabel}.${key}` : key)
  ));
}

test("merged companion catalogs resolve every shared localization token", () => {
  const previousGame = globalThis.game;
  const previousAdapter = SystemAdapter._current;
  try {
    const resolved = {};
    for (const moduleId of [
      "causodes-shipcombat-dnd5e",
      "causodes-shipcombat-sf2e",
      "causodes-shipcombat-impmal",
    ]) {
      const tree = JSON.parse(fs.readFileSync(path.join(coreRoot, "lang/en.json"), "utf8"));
      const companionPath = path.join(modulesRoot, moduleId, "lang/en.json");
      assert.equal(fs.existsSync(companionPath), true, `missing companion catalog: ${companionPath}`);
      mergeTree(tree, JSON.parse(fs.readFileSync(companionPath, "utf8")));
      SystemAdapter._current = {
        englishVariant: moduleId === "causodes-shipcombat-sf2e" ? "american" : "british",
        allocationUnitTerms: { singular: "SL", plural: "SL" },
        getModifierStepSize: () => 10,
        getHitBonusStep: () => 10,
        getAccuracyAllocationStep: () => 10,
        formatModifier: value => value >= 0 ? `+${value}` : `${value}`,
      };
      globalThis.game = { i18n: { translations: tree } };
      applyLangSubstitutions();
      assert.deepEqual(unresolvedTokens(tree.SHIPCOMBAT), [], moduleId);
      resolved[moduleId] = tree.SHIPCOMBAT;
    }

    const impmal = resolved["causodes-shipcombat-impmal"];
    assert.match(impmal.Sensors.TargetingSolutionDesc, /Gunnery Officer/);
    assert.match(impmal.Sensors.TargetingSolutionDesc, /\+10/);
    assert.equal(impmal.Sensors.SensorOvercharge, "Sensor Overcharge");
    assert.equal(impmal.Sensors.DesignateTorpedo, "Designate Torpedo");
    assert.match(impmal.Sensors.DesignateTorpedoDesc, /Augur/);
    assert.equal(impmal.NpcShip.TorpedoTemplates, "Torpedo Loadout");
    assert.equal(impmal.NpcShip.StrikeCraftTemplates, "Strike Craft Loadout");
  } finally {
    globalThis.game = previousGame;
    SystemAdapter._current = previousAdapter;
  }
});

test("localization hardening runs at both i18nInit and init", () => {
  const previousHooks = globalThis.Hooks;
  const registrations = [];
  globalThis.Hooks = { once: (event, callback) => registrations.push({ event, callback }) };
  try {
    registerLangSubstitution();
    assert.deepEqual(registrations.map(entry => entry.event), ["i18nInit", "init"]);
    assert.equal(registrations.every(entry => entry.callback === applyLangSubstitutions), true);
  } finally {
    globalThis.Hooks = previousHooks;
  }
});
