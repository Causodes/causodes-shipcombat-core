import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import { SystemAdapter } from "../scripts/systems/SystemAdapter.js";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.dirname(coreRoot);

globalThis.ShipCombat = {
  _api: {
    SystemAdapter,
    createActionRequester: () => async () => false,
  },
};

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
      if (!fs.existsSync(adapterPath)) return;
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
