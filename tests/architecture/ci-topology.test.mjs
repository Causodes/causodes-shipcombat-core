import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulesRoot = path.dirname(coreRoot);
const moduleNames = [
  "causodes-shipcombat-core",
  "causodes-shipcombat-dnd5e",
  "causodes-shipcombat-sf2e",
  "causodes-shipcombat-impmal",
];

test("every integration harness module passes a syntax check", () => {
  const integrationRoot = path.join(coreRoot, "tests/integration");
  for (const filename of fs.readdirSync(integrationRoot).filter(name => name.endsWith(".mjs"))) {
    const result = childProcess.spawnSync(process.execPath, ["--check", path.join(integrationRoot, filename)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${filename}: ${result.stderr || result.stdout}`);
  }
});

test("every module pull request triggers the shared cross-module suite", () => {
  for (const changedModule of moduleNames) {
    const workflowPath = path.join(modulesRoot, changedModule, ".github/workflows/test.yml");
    assert.equal(fs.existsSync(workflowPath), true, `${changedModule} has no test workflow`);
    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /pull_request:/);
    assert.doesNotMatch(workflow, /push:/,
      `${changedModule}'s lightweight suite must not duplicate its trusted-push integration run`);
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

test("trusted pushes run the real-Foundry harness without forwarding unrelated secrets", () => {
  const coreWorkflow = fs.readFileSync(
    path.join(coreRoot, ".github/workflows/foundry-integration.yml"),
    "utf8",
  );
  assert.match(coreWorkflow, /workflow_call:/);
  assert.match(coreWorkflow, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(coreWorkflow, /pull_request:/);
  assert.match(coreWorkflow, /contracts:\n\s+runs-on: ubuntu-latest/);
  assert.match(coreWorkflow, /Run contract and architecture tests/);
  assert.match(coreWorkflow, /run: npm test/);
  assert.match(coreWorkflow, /needs: \[contracts, credentials\]/);
  assert.match(coreWorkflow, /foundry-compatibility\.mjs generation/);
  assert.match(coreWorkflow, /com\.foundryvtt\.version/);
  assert.match(coreWorkflow, /FOUNDRY_VERSION: \$\{\{ needs\.resolve-foundry\.outputs\.version \}\}/);
  assert.match(coreWorkflow, /org\.opencontainers\.image\.version/);
  assert.match(coreWorkflow, /image="ghcr\.io\/felddy\/foundryvtt:\$\{container_version\}"/);
  assert.match(coreWorkflow, /uses: actions\/cache@v4/);
  assert.match(coreWorkflow, /foundry-distribution-\$\{\{ runner\.os \}\}-\$\{\{ env\.FOUNDRY_VERSION \}\}-v1/);
  assert.match(coreWorkflow, /foundryvtt-\$\{FOUNDRY_VERSION\}\.zip\.gpg/);
  assert.match(coreWorkflow, /--symmetric --cipher-algo AES256/);
  assert.match(coreWorkflow, /distribution_args=\(--env CONTAINER_CACHE=\/data\/container_cache\)/);
  assert.match(coreWorkflow, /if \[\[ "\$\{\{ steps\.foundry-cache\.outputs\.cache-hit \}\}" != "true" \]\]/);
  assert.match(coreWorkflow, /max-parallel: 1/);
  assert.match(coreWorkflow, /\["dnd5e","sf2e","sf2e-anachronism","impmal"\]/);
  assert.match(coreWorkflow, /matrix\.scenario == 'sf2e' \|\| matrix\.scenario == 'sf2e-anachronism'/);
  assert.match(coreWorkflow, /SHIPCOMBAT_SCENARIO: \$\{\{ matrix\.scenario \}\}/);
  assert.match(coreWorkflow, /npm run test:foundry/);
  assert.match(coreWorkflow, /if: failure\(\)/);
  assert.match(coreWorkflow, /needs\.integration\.result == 'success'/);
  assert.match(coreWorkflow, /inputs\.adapter == '' \|\| inputs\.adapter == 'all'/);
  assert.match(coreWorkflow, /foundry-compatibility\.mjs \\\n+\s+promote/);
  assert.match(coreWorkflow, /COMPATIBILITY_BOT_TOKEN/);
  assert.match(coreWorkflow, /PACKAGE_RESOLUTION_PATH/);
  assert.match(coreWorkflow, /resolved-packages-\$\{\{ matrix\.scenario \}\}/);

  const smokeTest = fs.readFileSync(
    path.join(coreRoot, "tests/integration/foundry-smoke.spec.mjs"),
    "utf8",
  );
  assert.match(smokeTest, /PACKAGE_RESOLUTION_PATH/);
  assert.match(smokeTest, /packageResolution\.packages/);
  assert.doesNotMatch(smokeTest, /systemVersion:\s*["'][0-9]/,
    "integration expectations must come from the resolved-package artifact");

  for (const adapter of moduleNames.filter(name => name !== "causodes-shipcombat-core")) {
    const workflow = fs.readFileSync(
      path.join(modulesRoot, adapter, ".github/workflows/foundry-integration.yml"),
      "utf8",
    );
    assert.match(workflow, /foundry-integration\.yml@main/);
    assert.match(workflow, /changed_ref: \$\{\{ github\.sha \}\}/);
    assert.doesNotMatch(workflow, /secrets: inherit/);
    for (const secret of ["FOUNDRY_USERNAME", "FOUNDRY_PASSWORD", "FOUNDRY_LICENSE_KEY", "FOUNDRY_ADMIN_KEY"]) {
      assert.match(workflow, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`));
    }
  }
});

test("every release upload is gated by licensed Foundry integration", () => {
  for (const moduleName of moduleNames) {
    const workflow = fs.readFileSync(
      path.join(modulesRoot, moduleName, ".github/workflows/publish-manifest.yml"),
      "utf8",
    );
    assert.match(workflow, /require_credentials: true/);
    assert.match(workflow, /publish-manifest:\n\s+needs: foundry-integration/);
    assert.doesNotMatch(workflow, /secrets: inherit/);
  }
});

test("personal-account secret setup updates every repository without command-line secret values", () => {
  const setupScript = fs.readFileSync(
    path.join(coreRoot, ".github/scripts/set-foundry-integration-secrets.zsh"),
    "utf8",
  );
  for (const moduleName of moduleNames) {
    assert.match(setupScript, new RegExp(`Causodes/${moduleName}`));
  }
  for (const secret of ["FOUNDRY_USERNAME", "FOUNDRY_PASSWORD", "FOUNDRY_LICENSE_KEY", "FOUNDRY_ADMIN_KEY"]) {
    assert.match(setupScript, new RegExp(`set_secret "${secret}"`));
  }
  assert.match(setupScript, /print -rn -- "\$value" \| gh secret set/);
  assert.doesNotMatch(setupScript, /gh secret set[^\n]+--body/);
});
