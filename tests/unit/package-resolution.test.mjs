import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePackageVersions,
  isFoundryCompatible,
  selectNewestCompatiblePackage,
} from "../integration/package-resolution.mjs";

test("package versions are ordered numerically across tag styles", () => {
  assert.equal(comparePackageVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(comparePackageVersions("5.3.3", "5.3.3"), 0);
});

test("generation-only maximum accepts every build in that generation", () => {
  assert.equal(isFoundryCompatible({ compatibility: { minimum: "13", maximum: "14" } }, "14.368"), true);
  assert.equal(isFoundryCompatible({ compatibility: { minimum: "14.369", maximum: "14" } }, "14.368"), false);
  assert.equal(isFoundryCompatible({ compatibility: { minimum: "13", maximum: "13" } }, "14.368"), false);
});

test("resolver selects the newest release that actually supports the Foundry build", () => {
  const candidate = (version, compatibility) => ({
    manifestUrl: `https://example.invalid/${version}/system.json`,
    manifest: { id: "example", version, compatibility, download: `https://example.invalid/${version}.zip` },
  });
  const selected = selectNewestCompatiblePackage([
    candidate("2.0.0", { minimum: "15" }),
    candidate("1.10.0", { minimum: "14", maximum: "14" }),
    candidate("1.9.0", { minimum: "14", maximum: "14" }),
  ], "example", "14.368");
  assert.equal(selected.manifest.version, "1.10.0");
});

test("resolver fails instead of silently installing an incompatible package", () => {
  assert.throws(() => selectNewestCompatiblePackage([{
    manifestUrl: "https://example.invalid/system.json",
    manifest: { id: "example", version: "2.0.0", compatibility: { minimum: "15" }, download: "x" },
  }], "example", "14.368"), /No example release is compatible/);
});
