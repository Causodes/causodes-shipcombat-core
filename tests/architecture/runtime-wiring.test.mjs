import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulesRoot = path.dirname(coreRoot);

test("architecture: AppV1 and AppV2 popups route live hooks through RenderLifecycle", () => {
  for (const filename of ["BattleClarityPopup.js", "BattleClarityPopupV1.js"]) {
    const source = fs.readFileSync(path.join(coreRoot, "scripts/apps", filename), "utf8");
    assert.match(source, /new RenderLifecycle\(this\)/);
    assert.match(source, /this\._lifecycle\.close\(\)/);
  }

  const appRoot = path.join(coreRoot, "scripts/apps");
  for (const filename of fs.readdirSync(appRoot).filter(name => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(appRoot, filename), "utf8");
    const registered = [...source.matchAll(/Hooks\.on\("([^"]+)"/g)].map(match => match[1]).sort();
    if (!registered.length || filename === "render-lifecycle.js") continue;
    const removed = [...source.matchAll(/Hooks\.off\("([^"]+)"/g)].map(match => match[1]).sort();
    assert.deepEqual(removed, registered, `${filename} leaks or mismatches a live hook`);
  }
});

test("architecture: station Core UI handlers expose only atomic GM actions", () => {
  for (const role of ["gunner", "ordnance"]) {
    const source = fs.readFileSync(path.join(coreRoot, `scripts/roles/${role}.js`), "utf8");
    assert.doesNotMatch(source, /"consumePowerCore"/);
    assert.match(source, new RegExp(`"execute${role === "gunner" ? "Gunner" : "Ordnance"}CoreAction"`));
  }
});

test("architecture: launch and combat entry points use shared transition functions", () => {
  const playerLaunch = fs.readFileSync(path.join(coreRoot, "scripts/state/ordnance-state.js"), "utf8");
  const npcLaunch = fs.readFileSync(
    path.join(coreRoot, "scripts/actors/npc/NpcShipSheetMixin.js"),
    "utf8",
  );
  const entrypoint = fs.readFileSync(path.join(coreRoot, "causodes-shipcombat-core.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(coreRoot, "scripts/state/ShipCombatState.js"), "utf8");

  assert.match(playerLaunch, /Object\.assign\(actorData\.system, getOrdnanceLaunchTurnState\(subtype\)\)/);
  assert.match(npcLaunch, /Object\.assign\(actorData\.system, getOrdnanceLaunchTurnState\(slotKey\)\)/);
  assert.match(playerLaunch, /canSetOrdnanceTurnDone\(ordnanceData, done\)/);
  assert.match(entrypoint, /processParentOrdnanceLifecycle\(prevCombatant\?\.actor/);
  assert.match(entrypoint, /_combatUpdateGate\.run\(key, \(\) => _processCombatUpdate\(combat, changes\)\)/);
  assert.match(entrypoint, /getPlayerTurnConditionUpdates\(/);
  assert.match(entrypoint, /getNpcRoundConditionEffects\(/);
  assert.match(lifecycle, /getPlayerTurnConditionUpdates\(/);
  assert.match(lifecycle, /getNpcRoundConditionEffects\(/);
  assert.match(lifecycle, /getOrdnanceLifecycleTransition\(/);
});

test("architecture: deletion and manual cleanup enter the shared target-reference boundary", () => {
  const entrypoint = fs.readFileSync(path.join(coreRoot, "causodes-shipcombat-core.js"), "utf8");
  const manualOverride = fs.readFileSync(path.join(coreRoot, "scripts/apps/ManualOverride.js"), "utf8");
  assert.match(entrypoint, /Hooks\.on\("deleteToken"[\s\S]*?clearTargetReferences\(tokenDoc\.id\)/);
  assert.match(entrypoint, /Hooks\.on\("deleteActor"[\s\S]*?pruneSceneTargetReferences\(\)/);
  assert.match(entrypoint, /Hooks\.on\("canvasReady"[\s\S]*?pruneSceneTargetReferences\(\)/);
  assert.match(manualOverride, /withAllocationTransaction\([\s\S]*?collectExistingTargetTokenIds\(game\.scenes\)/);
});

test("architecture: every component entry point uses the shared behavioral contracts", () => {
  const controller = fs.readFileSync(path.join(coreRoot, "scripts/actors/ship/ShipController.js"), "utf8");
  const npcSheet = fs.readFileSync(path.join(coreRoot, "scripts/actors/npc/NpcShipSheetMixin.js"), "utf8");
  const state = fs.readFileSync(path.join(coreRoot, "scripts/state/ShipCombatState.js"), "utf8");
  assert.match(controller, /prepareImportedComponentPlacement\(/);
  assert.match(controller, /componentSlotUpdates\(/);
  assert.equal((npcSheet.match(/npcComponentDropError\(/g) ?? []).length, 2);
  assert.equal((npcSheet.match(/componentSlotUpdates\(/g) ?? []).length, 2);
  for (const contract of [
    "assignWeaponComponent", "unassignShipComponent", "assignEquipmentComponent",
    "getReactorComponentStats", "getOrdnanceBayComponentStats",
    "getShieldComponentStats", "getSensorComponentStats",
  ]) assert.match(state, new RegExp(`${contract}\\(`));
});

test("architecture: D&D5e sheets share one upstream warnings-template contract", () => {
  const dndRoot = path.join(modulesRoot, "causodes-shipcombat-dnd5e");
  const compatibility = fs.readFileSync(path.join(dndRoot, "scripts/actors/dnd5e-compat.js"), "utf8");
  assert.match(compatibility, /warnings:\s*"systems\/dnd5e\/templates\/shared\/sheet-warnings-dialog\.hbs"/);

  for (const filename of [
    "scripts/actors/starship/PlayerShipSheet.js",
    "scripts/actors/npc/NpcShipSheet.js",
    "scripts/actors/ordnance/OrdnanceSheet.js",
  ]) {
    const source = fs.readFileSync(path.join(dndRoot, filename), "utf8");
    assert.match(source, /import \{ DND5E_SHEET_TEMPLATES \} from "\.\.\/dnd5e-compat\.js";/);
    assert.match(source, /template:\s*DND5E_SHEET_TEMPLATES\.warnings/);
    assert.doesNotMatch(source, /actor-warnings-dialog\.hbs/);
  }
});
