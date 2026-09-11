import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.dirname(coreRoot);
const moduleRoots = fs.readdirSync(modulesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith("causodes-shipcombat-"))
  .map(entry => path.join(modulesRoot, entry.name));
const socketPath = path.join(coreRoot, "scripts/socket.js");
const socketSource = fs.readFileSync(socketPath, "utf8");
const companionApiSource = fs.readFileSync(path.join(coreRoot, "scripts/companion-api.js"), "utf8");
const stateSource = fs.readFileSync(path.join(coreRoot, "scripts/state/ShipCombatState.js"), "utf8");

function jsFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && ![".git", "tests"].includes(entry.name)) visit(entryPath);
      else if (entry.name.endsWith(".js")) files.push(entryPath);
    }
  };
  visit(root);
  return files;
}

function actionContracts() {
  const block = socketSource.match(
    /export const ACTION_CONTRACTS = Object\.freeze\(\{([\s\S]*?)\n\}\);/,
  )?.[1];
  assert.ok(block, "ACTION_CONTRACTS must remain statically discoverable");
  return [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]);
}

function broadcastActions() {
  const block = socketSource.match(
    /const BROADCAST_HANDLERS = Object\.freeze\(\{([\s\S]*?)\n\}\);/,
  )?.[1];
  assert.ok(block, "BROADCAST_HANDLERS must remain statically discoverable");
  return [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]);
}

function versionAtLeast(actual, required) {
  const parts = version => String(version ?? "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const actualParts = parts(actual);
  const requiredParts = parts(required);
  const length = Math.max(actualParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (actualParts[index] ?? 0) - (requiredParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function companionRoots() {
  return moduleRoots.filter(root => root !== coreRoot);
}

function companionApiExports() {
  const names = new Set();
  for (const match of companionApiSource.matchAll(/export\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const entry of match[1].split(",")) {
      const name = entry.trim().split(/\s+as\s+/).at(-1);
      if (name) names.add(name);
    }
  }
  return names;
}

test("all Core and companion JavaScript parses", () => {
  const failures = [];
  for (const file of moduleRoots.flatMap(jsFiles)) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(`${path.relative(coreRoot, file)}: ${result.stderr.trim()}`);
    }
  }
  assert.deepEqual(failures, [], "JavaScript syntax regression");
});

test("every GM action contract has exactly one handler case", () => {
  const contracts = actionContracts();
  const cases = [...socketSource.matchAll(/case "([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(contracts).size, contracts.length, "duplicate action contract");
  assert.deepEqual([...new Set(cases)].sort(), [...contracts].sort());
});

test("every factory request gets an identity and every socket handler is deduplicated", () => {
  assert.match(socketSource, /requestId:\s*payload\.requestId\s*\?\?\s*foundry\.utils\.randomID\(\)/);
  assert.match(socketSource, /_socket\.register\(action, \(payload = \{\}\) => _handleActionOnce\(action, payload\)\)/);
  assert.match(socketSource, /return _requestGate\.run\(key, \(\) => _handleAction\(action, payload\)\)/);
});

test("every socket state-handler target exists", () => {
  const methods = new Set([
    ...[...stateSource.matchAll(/\bstatic\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)]
      .map(match => match[1]),
    ...[...stateSource.matchAll(/\bShipCombatState\.([A-Za-z_$][\w$]*)\s*=/g)]
      .map(match => match[1]),
  ]);
  const missing = [...socketSource.matchAll(/\b(?:state|ShipCombatState)\.([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(match => match[1])
    .filter(name => !methods.has(name));
  assert.deepEqual([...new Set(missing)], [], "socket handler calls a missing state method");
});

test("standalone target-reference creators share cleanup's ship mutation queue", () => {
  for (const method of ["registerSensorContacts", "setRecommendedTarget", "resolveBDA"]) {
    assert.match(
      stateSource,
      new RegExp(`ShipCombatState\\.${method}\\s*=\\s*allocationSerialized\\(SensorsState\\.${method}\\)`),
      `${method} can race target cleanup`,
    );
  }
});

test("every action uses a recognized scope contract", () => {
  const block = socketSource.match(
    /export const ACTION_CONTRACTS = Object\.freeze\(\{([\s\S]*?)\n\}\);/,
  )?.[1];
  const helpers = new Set(["_shipAction", "_parentShipAction", "_sourceAction", "_ordnanceAction"]);
  const unknown = [...block.matchAll(/^\s{2}[A-Za-z][A-Za-z0-9]*:\s*([A-Za-z][A-Za-z0-9]*)/gm)]
    .map(match => match[1])
    .filter(helper => !helpers.has(helper));
  assert.deepEqual(unknown, []);
});

test("all repository request sites use the scoped request factory", () => {
  const violations = [];
  for (const file of moduleRoots.flatMap(jsFiles)) {
    if (file === socketPath) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/\bemitToGM\s*\(/.test(source) || /\brequestGMAction\s*\(/.test(source)) {
      violations.push(path.relative(coreRoot, file));
    }
  }
  assert.deepEqual(violations, [], "raw GM requests bypass actor-scope injection");
});

test("persistent document mutations are never silently fire-and-forget", () => {
  const violations = [];
  const mutationCall = /\.(?:update|setFlag|unsetFlag|createEmbeddedDocuments|deleteEmbeddedDocuments)\s*\(/;
  for (const file of moduleRoots.flatMap(jsFiles)) {
    const source = fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ""));
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].replace(/\/\/.*$/, "");
      const callAt = line.search(mutationCall);
      if (callAt < 0) continue;
      const prefix = line.slice(0, callAt);
      const nearbyStatement = lines.slice(index, index + 4).join(" ");
      const handled = /\b(?:await|return|void)\b/.test(prefix)
        || /=>\s*[^;]*\.(?:update|setFlag|unsetFlag|createEmbeddedDocuments|deleteEmbeddedDocuments)\s*\(/.test(line)
        || /\.catch\s*\(/.test(nearbyStatement);
      if (!handled) violations.push(`${path.relative(coreRoot, file)}:${index + 1}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "await, return, or explicitly void/catch every persistent document mutation",
  );
});

test("every scoped request site declares its file-local factory", () => {
  const violations = [];
  for (const file of moduleRoots.flatMap(jsFiles)) {
    if (file === socketPath) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/\brequestGM\s*\(/.test(source)
      && !/const\s+requestGM\s*=\s*createActionRequester\s*\(/.test(source)) {
      violations.push(path.relative(coreRoot, file));
    }
  }
  assert.deepEqual(violations, [], "requestGM is used without a local actor resolver");
});

test("every literal scoped request names a declared action", () => {
  const contracts = new Set(actionContracts());
  const unknown = [];
  for (const file of moduleRoots.flatMap(jsFiles)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\brequestGM\([^,]+,\s*"([^"]+)"/g)) {
      if (!contracts.has(match[1])) unknown.push(`${path.relative(coreRoot, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(unknown, [], "scoped request uses an undeclared action");
});

test("request and broadcast action names remain statically auditable", () => {
  const violations = [];
  for (const file of moduleRoots.flatMap(jsFiles)) {
    const source = fs.readFileSync(file, "utf8");
    const patterns = [
      ["requestGM", /\brequestGM\(\s*[^,\n]+,\s*([^\s])/g],
      ["emitToAll", /\bemitToAll\(\s*([^\s])/g],
    ];
    for (const [functionName, pattern] of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
        if (match[1] !== '"') violations.push(`${path.relative(coreRoot, file)}: ${functionName}`);
      }
    }
  }
  assert.deepEqual(violations, [], "dynamic action names bypass sender/receiver checks");
});

test("every literal broadcast request has a registered handler", () => {
  const registered = new Set(broadcastActions());
  const missing = [];
  for (const file of moduleRoots.flatMap(jsFiles)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bemitToAll\("([^"]+)"/g)) {
      if (!registered.has(match[1])) {
        missing.push(`${path.relative(coreRoot, file)}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], "broadcast request has no registered receiver");

  const handlerBlock = socketSource.match(
    /const BROADCAST_HANDLERS = Object\.freeze\(\{([\s\S]*?)\n\}\);/,
  )?.[1] ?? "";
  const missingFunctions = [...handlerBlock.matchAll(/^\s{2}[A-Za-z][A-Za-z0-9]*:\s*([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1])
    .filter(name => !new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).test(socketSource));
  assert.deepEqual(missingFunctions, [], "broadcast catalog references a missing handler function");
});

test("every companion waits for the Core API before importing consumers", () => {
  const violations = [];
  for (const root of companionRoots()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
    const entryPath = path.join(root, manifest.esmodules?.[0] ?? "");
    const source = fs.readFileSync(entryPath, "utf8");
    const waitIndex = source.indexOf("const ShipCombat = await new Promise");
    const readyHookIndex = source.indexOf('Hooks.once("shipCombatApiReady"');
    const importIndex = source.indexOf('import("./scripts/');
    const configureCount = [...source.matchAll(/^\s*ShipCombat\.configure\s*\(/gm)].length;
    const requiresCore = manifest.relationships?.requires?.some(
      dependency => dependency.id === "causodes-shipcombat-core",
    );
    if (!requiresCore || waitIndex < 0 || readyHookIndex < waitIndex
      || importIndex < readyHookIndex || configureCount !== 1) {
      violations.push(path.basename(root));
    }
  }
  assert.deepEqual(violations, [], "companion Core-API startup handshake is incomplete");
});

test("every companion API symbol consumed at module scope is exported by Core", () => {
  const exports = companionApiExports();
  const missing = [];
  for (const root of companionRoots()) {
    for (const file of jsFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      const consumed = new Set();
      for (const match of source.matchAll(/\{([^{}]*?)\}\s*=\s*globalThis\.ShipCombat\._api/g)) {
        for (const entry of match[1].split(",")) {
          const name = entry.trim().split(/\s*:\s*/)[0];
          if (/^[A-Za-z_$][\w$]*$/.test(name)) consumed.add(name);
        }
      }
      for (const match of source.matchAll(/globalThis\.ShipCombat\._api(?:\?\.|\.)([A-Za-z_$][\w$]*)/g)) {
        consumed.add(match[1]);
      }
      for (const name of consumed) {
        if (!exports.has(name)) missing.push(`${path.relative(coreRoot, file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(missing, [], "companion consumes a missing Core API export");
});

test("companions do not bypass the published Core API with cross-module imports", () => {
  const violations = [];
  for (const root of companionRoots()) {
    for (const file of jsFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      if (/(?:from\s+|import\s*\()["'][^"']*causodes-shipcombat-core/.test(source)) {
        violations.push(path.relative(coreRoot, file));
      }
    }
  }
  assert.deepEqual(violations, [], "cross-module import can duplicate Core module instances");
});

test("companions using the scoped factory require a compatible Core", () => {
  const violations = [];
  for (const root of companionRoots()) {
    const usesFactory = jsFiles(root).some(file =>
      fs.readFileSync(file, "utf8").includes("createActionRequester"),
    );
    if (!usesFactory) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
    const coreDependency = manifest.relationships?.requires?.find(
      dependency => dependency.id === "causodes-shipcombat-core",
    );
    if (!versionAtLeast(coreDependency?.compatibility?.minimum, "2.4.1")) {
      violations.push(path.basename(root));
    }
  }
  assert.deepEqual(violations, [], "factory consumers must require Core 2.4.1");
});
