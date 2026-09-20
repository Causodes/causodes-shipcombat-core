import assert from "node:assert/strict";
import test from "node:test";

import { buildPowerCorePips } from "../../scripts/actors/ship/power-core-pips.js";
import {
  buildNpcOrdnanceTemplateContext,
  selectNpcOrdnanceTemplate,
} from "../../scripts/actors/npc/npc-ordnance-selection.js";
import {
  buildRecordDeletionUpdates,
  buildTargetReferenceCleanup,
  collectExistingTargetTokenIds,
  collectTargetReferenceIds,
} from "../../scripts/state/target-references.js";

const states = pips => pips.map(pip => pip.state);

test("object-valued state is cleared with Foundry deletion operators", () => {
  assert.deepEqual(buildRecordDeletionUpdates("resources.state", { first: 1, last: 2 }), {
    "resources.state.-=first": null,
    "resources.state.-=last": null,
  });
  assert.deepEqual(
    buildRecordDeletionUpdates("resources.state", { keep: 1, remove: 2 }, (_key, value) => value === 2),
    { "resources.state.-=remove": null },
  );
});

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
    "resources.sensors.contacts.-=deleted": null,
    "resources.sensors.bdaAttacks.-=old": null,
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
