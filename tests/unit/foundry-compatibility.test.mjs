import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareFoundryVersions,
  promoteVerifiedVersion,
  resolveSupportedGeneration,
} from "../../.github/scripts/foundry-compatibility.mjs";

function fixtureManifests(compatibilities) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shipcombat-foundry-compatibility-"));
  return compatibilities.map((compatibility, index) => {
    const manifestPath = path.join(directory, `module-${index}.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify({ id: `module-${index}`, compatibility }, null, 2)}\n`);
    return manifestPath;
  });
}

test("Foundry versions are compared numerically rather than lexically", () => {
  assert.equal(compareFoundryVersions("14.368", "14.99"), 1);
  assert.equal(compareFoundryVersions("14.368", "14.368.0"), 0);
  assert.equal(compareFoundryVersions("14.367", "14.368"), -1);
});

test("supported generation is the newest generation accepted by every manifest", () => {
  const manifests = fixtureManifests([
    { minimum: "13", verified: "14.367", maximum: "14" },
    { minimum: "14", verified: "14.367", maximum: "14" },
    { minimum: "13", verified: "13.350", maximum: "15" },
  ]);
  assert.equal(resolveSupportedGeneration(manifests), 14);
});

test("incompatible manifest ranges stop resolution", () => {
  const manifests = fixtureManifests([
    { minimum: "14", verified: "14.367", maximum: "14" },
    { minimum: "15", verified: "15.1", maximum: "15" },
  ]);
  assert.throws(() => resolveSupportedGeneration(manifests), /no mutually supported Foundry generation/);
});

test("promotion only raises verified within the mutually supported generation", () => {
  const manifests = fixtureManifests([
    { minimum: "13", verified: "14.367", maximum: "14" },
    { minimum: "14", verified: "14.368", maximum: "14" },
  ]);

  assert.deepEqual(promoteVerifiedVersion("14.368", manifests), [manifests[0]]);
  assert.equal(JSON.parse(fs.readFileSync(manifests[0], "utf8")).compatibility.verified, "14.368");
  assert.equal(JSON.parse(fs.readFileSync(manifests[1], "utf8")).compatibility.verified, "14.368");
  assert.deepEqual(promoteVerifiedVersion("14.367", manifests), []);
  assert.throws(() => promoteVerifiedVersion("15.1", manifests), /Refusing to promote/);
});
