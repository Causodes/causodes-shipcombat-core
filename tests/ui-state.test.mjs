import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPowerCorePips } from "../scripts/actors/ship/power-core-pips.js";
import {
  buildNpcOrdnanceTemplateContext,
  selectNpcOrdnanceTemplate,
} from "../scripts/actors/npc/npc-ordnance-selection.js";
import {
  buildTargetReferenceCleanup,
  collectExistingTargetTokenIds,
  collectTargetReferenceIds,
} from "../scripts/state/target-references.js";

const states = pips => pips.map(pip => pip.state);
const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a newly overclocked core remains the rightmost pip when staged", () => {
  const committed = {
    assigned: 2,
    shieldCommitted: 1,
    auxiliaryCommitted: 1,
  };
  assert.deepEqual(states(buildPowerCorePips({ ...committed, available: 1 })), [
    "assigned", "assigned", "shield-committed", "aux-committed", "available",
  ]);
  assert.deepEqual(states(buildPowerCorePips({ ...committed, staged: 1 })), [
    "assigned", "assigned", "shield-committed", "aux-committed", "staged",
  ]);
});

test("all staged core types follow committed cores and precede available cores", () => {
  assert.deepEqual(states(buildPowerCorePips({
    assigned: 1,
    shieldCommitted: 1,
    auxiliaryCommitted: 1,
    staged: 1,
    shieldStaged: 1,
    auxiliaryStaged: 1,
    available: 1,
  })), [
    "assigned", "shield-committed", "aux-committed",
    "staged", "shield-staged", "aux-staged", "available",
  ]);
});

test("NPC ordnance launch resolves the selected template instead of the first template", () => {
  const templates = [
    { id: "first", actorData: { system: { hull: { max: 2 } } } },
    { id: "selected", actorData: { system: { hull: { max: 5 } } } },
  ];
  assert.equal(selectNpcOrdnanceTemplate(templates, "selected"), templates[1]);
  assert.equal(selectNpcOrdnanceTemplate(templates, "missing"), null);
  assert.equal(selectNpcOrdnanceTemplate(templates), templates[0]);

  const context = buildNpcOrdnanceTemplateContext({ torpedo: templates }, { torpedo: "selected" });
  assert.deepEqual(context.torpedoTemplates.map(template => template.selected), [false, true]);
  assert.deepEqual(context.selectedTorpedoTemplate, { id: "selected", torpedoCount: 5 });
});

test("target cleanup removes every persisted reference to a deleted token", () => {
  const data = {
    resources: {
      captain: { priorityTargetId: "deleted" },
      sensors: {
        recommendedTargetId: "deleted",
        fireCorrection: { targetTokenId: "deleted", type: "accuracy" },
        locks: [{ targetTokenId: "deleted", tier: 2 }, { targetTokenId: "kept", tier: 1 }],
        effects: [{ targetTokenId: "deleted" }, { targetTokenId: "__self__" }],
        contacts: { deleted: { ordinal: 1 }, kept: { ordinal: 2 } },
        bdaAttacks: {
          old: { targetTokenId: "deleted" },
          active: { targetTokenId: "kept" },
        },
      },
    },
  };

  assert.deepEqual(collectTargetReferenceIds(data), new Set(["deleted", "kept"]));
  assert.deepEqual(buildTargetReferenceCleanup(data, ["deleted"]), {
    "resources.sensors.recommendedTargetId": null,
    "resources.captain.priorityTargetId": null,
    "resources.sensors.fireCorrection": null,
    "resources.sensors.locks": [{ targetTokenId: "kept", tier: 1 }],
    "resources.sensors.effects": [{ targetTokenId: "__self__" }],
    "resources.sensors.contacts": { kept: { ordinal: 2 } },
    "resources.sensors.bdaAttacks": { active: { targetTokenId: "kept" } },
  });
});

test("stale-target pruning preserves valid Tokens on scenes the GM is not viewing", () => {
  const activeScene = { tokens: [{ id: "active", actor: {} }, { id: "orphan", actor: null }] };
  const inactiveScene = { tokens: [{ id: "elsewhere", actor: {} }] };
  assert.deepEqual(
    collectExistingTargetTokenIds([activeScene, inactiveScene]),
    ["active", "elsewhere"],
  );
});

test("UI helpers remain wired into both sheet generations and deletion lifecycles", () => {
  const controller = fs.readFileSync(path.join(coreRoot, "scripts/actors/ship/ShipController.js"), "utf8");
  const npcMixin = fs.readFileSync(path.join(coreRoot, "scripts/actors/npc/NpcShipSheetMixin.js"), "utf8");
  const npcTemplate = fs.readFileSync(
    path.join(coreRoot, "templates/actor/tabs/npc/npc-ship-ordnance.hbs"),
    "utf8",
  );
  const npcStyles = fs.readFileSync(path.join(coreRoot, "styles/npc.css"), "utf8");
  const entrypoint = fs.readFileSync(path.join(coreRoot, "causodes-shipcombat-core.js"), "utf8");
  const manualOverride = fs.readFileSync(path.join(coreRoot, "scripts/apps/ManualOverride.js"), "utf8");

  assert.match(controller, /powerCorePips:\s*buildPowerCorePips\(/);
  assert.equal((npcMixin.match(/buildNpcOrdnanceTemplateContext\(/g) ?? []).length, 2);
  assert.equal((npcTemplate.match(/class="shipcombat-npc-launch-template"/g) ?? []).length, 2);
  assert.equal((npcTemplate.match(/class="shipcombat-npc-launch-controls"/g) ?? []).length, 2);
  assert.doesNotMatch(npcTemplate, /data-template-id="\{\{(?:torpedo|craft)Templates\.\[0\]/);
  assert.doesNotMatch(npcTemplate, /shipcombat-battery-fire-btn" data-action="npcLaunch/);
  assert.match(npcStyles, /\.shipcombat-npc-launch-template\s*\{[\s\S]*?width:\s*100%\s*!important/);
  assert.match(npcStyles, /\.shipcombat-npc-launch-btn\s*\{[\s\S]*?width:\s*auto\s*!important/);
  assert.match(entrypoint, /Hooks\.on\("deleteToken"[\s\S]*?clearTargetReferences\(tokenDoc\.id\)/);
  assert.match(entrypoint, /Hooks\.on\("deleteActor"[\s\S]*?pruneSceneTargetReferences\(\)/);
  assert.match(entrypoint, /Hooks\.on\("canvasReady"[\s\S]*?pruneSceneTargetReferences\(\)/);
  assert.match(manualOverride, /withAllocationTransaction\([\s\S]*?collectExistingTargetTokenIds\(game\.scenes\)/);
});
