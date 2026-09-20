import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const unitRoot = path.join(coreRoot, "tests/unit");
const architectureRoot = path.join(coreRoot, "tests/architecture");
const integrationRoot = path.join(coreRoot, "tests/integration");

function moduleFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith(".mjs")) files.push(entryPath);
    }
  };
  visit(root);
  return files;
}

test("architecture: behavioral unit tests do not inspect production source text", () => {
  for (const file of moduleFiles(unitRoot)) {
    const filename = path.relative(unitRoot, file);
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /readFileSync\([^\n]*(?:scripts|templates|styles|\.github|causodes-shipcombat-core\.js)/,
      `${filename} inspects implementation text; move structural rules to tests/architecture or execute the behavior`,
    );
    assert.doesNotMatch(
      source,
      /assert\.(?:match|doesNotMatch)\([^\n]*(?:source|entrypoint|template|styles|workflow)/,
      `${filename} makes a source-pattern assertion; move it to tests/architecture`,
    );
    for (const match of source.matchAll(/(?:readFileSync|readFile)\s*\(([\s\S]*?),\s*["']utf8["']\s*\)/g)) {
      assert.doesNotMatch(
        match[1],
        /["'`](?:\.\.\/)*(?:scripts|templates|styles|\.github)(?:\/|["'`])/,
        `${filename} reads production implementation text`,
      );
    }
    assert.doesNotMatch(
      source,
      /from\s+["']node:child_process["']/,
      `${filename} executes tooling and belongs in tests/architecture`,
    );
  }
});

test("architecture: required suites contain no focused, skipped, or todo tests", () => {
  for (const root of [unitRoot, architectureRoot, integrationRoot]) {
    for (const file of moduleFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /\b(?:test|describe)\.(?:only|skip|todo|fixme)\s*\(/,
        `${file} contains a focused or disabled test`,
      );
      assert.doesNotMatch(
        source,
        /if\s*\(\s*!fs\.existsSync\([^)]*\)\s*\)\s*(?:return|continue)\b/,
        `${file} silently skips a missing fixture or companion`,
      );
    }
  }
});

test("architecture: behavioral and structural suites are both mandatory", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:unit"], "node --test tests/unit/*.test.mjs");
  assert.equal(pkg.scripts["test:architecture"], "node --test tests/architecture/*.test.mjs");
  assert.equal(pkg.scripts.test, "npm run test:unit && npm run test:architecture");
});
