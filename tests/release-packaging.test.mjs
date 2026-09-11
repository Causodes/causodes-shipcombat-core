import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.dirname(coreRoot);
const moduleRoots = fs.readdirSync(modulesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith("causodes-shipcombat-"))
  .map(entry => path.join(modulesRoot, entry.name));
const runtimeDirectories = ["lang", "scripts", "styles", "templates"];
const forbiddenEntries = /(^|\/)(?:tests|\.github|node_modules|package\.json|package-lock\.json)(?:\/|$)/;

function manifestAt(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
}

test("every module downloads its named release asset instead of a source archive", () => {
  for (const root of moduleRoots) {
    const manifest = manifestAt(root);
    assert.equal(
      manifest.download,
      `https://github.com/Causodes/${manifest.id}/releases/download/v${manifest.version}/${manifest.id}.zip`,
      manifest.id,
    );
  }
});

test("every release workflow builds and uploads an allowlisted runtime package", () => {
  for (const root of moduleRoots) {
    const workflowPath = path.join(root, ".github/workflows/publish-manifest.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /zip -r "dist\/\$\{module_id\}\.zip" module\.json \$entrypoints lang scripts styles templates/);
    const packageUpload = workflow.indexOf('gh release upload "$RELEASE_TAG" "dist/${module_id}.zip"');
    const manifestUpload = workflow.indexOf('gh release upload "$RELEASE_TAG" module.json');
    assert.ok(packageUpload >= 0, `${path.basename(root)}: missing package upload`);
    assert.ok(manifestUpload > packageUpload, `${path.basename(root)}: manifest must upload after package`);
    assert.doesNotMatch(workflow, /archive\/refs\/tags/);
  }
});

test("the runtime allowlist produces installable archives without development files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shipcombat-package-"));
  try {
    for (const root of moduleRoots) {
      const manifest = manifestAt(root);
      const archive = path.join(tempRoot, `${manifest.id}.zip`);
      const inputs = [
        "module.json",
        ...(manifest.esmodules ?? []),
        ...runtimeDirectories.filter(directory => fs.existsSync(path.join(root, directory))),
      ];
      const zipped = spawnSync("zip", ["-q", "-r", archive, ...inputs], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(zipped.status, 0, `${manifest.id}: ${zipped.stderr}`);

      const listed = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
      assert.equal(listed.status, 0, `${manifest.id}: ${listed.stderr}`);
      const entries = listed.stdout.trim().split("\n").filter(Boolean);
      assert.ok(entries.includes("module.json"), `${manifest.id}: missing module.json`);
      for (const entrypoint of manifest.esmodules ?? []) {
        assert.ok(entries.includes(entrypoint), `${manifest.id}: missing ${entrypoint}`);
      }
      assert.equal(entries.some(entry => forbiddenEntries.test(entry)), false, manifest.id);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
