import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.dirname(coreRoot);
const moduleNames = [
  "causodes-shipcombat-core",
  "causodes-shipcombat-dnd5e",
  "causodes-shipcombat-sf2e",
  "causodes-shipcombat-impmal",
];

test("every module change triggers the shared cross-module suite", () => {
  for (const changedModule of moduleNames) {
    const workflowPath = path.join(modulesRoot, changedModule, ".github/workflows/test.yml");
    assert.equal(fs.existsSync(workflowPath), true, `${changedModule} has no test workflow`);
    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /push:\n\s+branches: \[main\]/);
    assert.match(workflow, /working-directory: modules\/causodes-shipcombat-core/);
    for (const dependency of moduleNames) {
      assert.match(workflow, new RegExp(`path: modules/${dependency}`),
        `${changedModule} does not test with ${dependency}`);
    }
  }
});

test("adapter workflows check out their triggering commit rather than main", () => {
  for (const adapter of moduleNames.filter(name => name !== "causodes-shipcombat-core")) {
    const workflow = fs.readFileSync(
      path.join(modulesRoot, adapter, ".github/workflows/test.yml"),
      "utf8",
    );
    const ownCheckout = workflow.match(/- name: Check out [^\n]+\n[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? "";
    assert.match(ownCheckout, new RegExp(`path: modules/${adapter}`));
    assert.doesNotMatch(ownCheckout, /repository:|ref:/,
      `${adapter} must let actions/checkout select the triggering PR/push commit`);
  }
});
