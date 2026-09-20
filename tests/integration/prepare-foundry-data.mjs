import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolvePackage } from "./package-resolution.mjs";

const SCENARIOS = Object.freeze({
  dnd5e: { adapterId: "dnd5e", systemId: "dnd5e", moduleId: "causodes-shipcombat-dnd5e", dependencies: ["socketlib"] },
  sf2e: { adapterId: "sf2e", systemId: "sf2e", moduleId: "causodes-shipcombat-sf2e", dependencies: ["socketlib"] },
  "sf2e-anachronism": {
    adapterId: "sf2e",
    systemId: "pf2e",
    moduleId: "causodes-shipcombat-sf2e",
    dependencies: ["socketlib", "sf2e-anachronism"],
  },
  impmal: { adapterId: "impmal", systemId: "impmal", moduleId: "causodes-shipcombat-impmal", dependencies: ["socketlib", "warhammer-lib"] },
});

const [scenarioId, checkoutsArg, dataArg] = process.argv.slice(2);
if (!SCENARIOS[scenarioId] || !checkoutsArg || !dataArg) {
  throw new Error("Usage: node prepare-foundry-data.mjs <dnd5e|sf2e|sf2e-anachronism|impmal> <checkouts-dir> <foundry-data-dir>");
}

const checkoutsDir = resolve(checkoutsArg);
const dataDir = resolve(dataArg);
const scenario = SCENARIOS[scenarioId];
const worldId = `shipcombat-integration-${scenarioId}`;
const foundryVersion = process.env.FOUNDRY_VERSION ?? "14.367";

for (const directory of ["Config", "Data/modules", "Data/systems", "Data/worlds"]) {
  mkdirSync(join(dataDir, directory), { recursive: true });
}

function runtimeSourceFilter(source) {
  const name = basename(source);
  return !new Set([".git", ".github", "node_modules", "tests", "integration", "package.json", "package-lock.json"]).has(name);
}

function stageCheckedOutModule(moduleId) {
  const source = join(checkoutsDir, moduleId);
  const destination = join(dataDir, "Data/modules", moduleId);
  if (!existsSync(join(source, "module.json"))) {
    throw new Error(`Checked-out module is missing module.json: ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, filter: runtimeSourceFilter });
}

function findDescriptor(directory, filename) {
  const direct = join(directory, filename);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findDescriptor(join(directory, entry.name), filename);
    if (nested) return nested;
  }
  return null;
}

async function installPackage(definition) {
  const parent = join(dataDir, `Data/${definition.kind}s`);
  const destination = join(parent, definition.id);
  const scratch = mkdtempSync(join(tmpdir(), `shipcombat-${definition.id}-`));
  const archive = join(scratch, "package.zip");
  const extracted = join(scratch, "extracted");
  mkdirSync(extracted);

  try {
    let response;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = undefined;
        response = await fetch(definition.download, { redirect: "follow" });
        if (response.ok) break;
        throw new Error(`${response.status} ${response.statusText}`);
      } catch (error) {
        if (attempt === 4 || (response && response.status < 500)) throw error;
        console.warn(`Download attempt ${attempt} for ${definition.id} failed (${error.message}); retrying.`);
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 2_000));
    }
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    execFileSync("unzip", ["-q", archive, "-d", extracted], { stdio: "inherit" });

    const descriptorName = definition.kind === "system" ? "system.json" : "module.json";
    const descriptor = findDescriptor(extracted, descriptorName);
    if (!descriptor) throw new Error(`${descriptorName} not found in ${definition.download}`);
    const manifest = JSON.parse(readFileSync(descriptor, "utf8"));
    if (manifest.id !== definition.id || manifest.version !== definition.version) {
      throw new Error(`Expected ${definition.id} ${definition.version}, received ${manifest.id} ${manifest.version}`);
    }

    rmSync(destination, { recursive: true, force: true });
    cpSync(dirname(descriptor), destination, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const packageIds = [...new Set([scenario.systemId, ...scenario.dependencies])];
const resolvedPackages = Object.fromEntries(await Promise.all(packageIds.map(async packageId => [
  packageId,
  await resolvePackage(packageId, foundryVersion),
])));

stageCheckedOutModule("causodes-shipcombat-core");
stageCheckedOutModule(scenario.moduleId);
for (const packageId of packageIds) await installPackage(resolvedPackages[packageId]);

const worldDir = join(dataDir, "Data/worlds", worldId);
mkdirSync(worldDir, { recursive: true });
mkdirSync(join(worldDir, "data"), { recursive: true });
mkdirSync(join(worldDir, "scenes"), { recursive: true });
writeFileSync(join(worldDir, "world.json"), `${JSON.stringify({
  id: worldId,
  title: `Ship Combat Integration (${scenarioId})`,
  description: "Disposable CI fixture world.",
  system: scenario.systemId,
  coreVersion: foundryVersion,
  compatibility: { minimum: "14", verified: foundryVersion, maximum: "14" },
  systemVersion: resolvedPackages[scenario.systemId].version,
  joinTheme: "minimal",
  flags: {},
}, null, 2)}\n`);

const resolution = {
  scenarioId,
  foundry: {
    version: foundryVersion,
    image: process.env.FOUNDRY_IMAGE ?? null,
    digest: process.env.FOUNDRY_IMAGE_DIGEST ?? null,
  },
  packages: resolvedPackages,
};
const resolutionPath = process.env.PACKAGE_RESOLUTION_PATH
  ? resolve(process.env.PACKAGE_RESOLUTION_PATH)
  : join(dataDir, `resolved-packages-${scenarioId}.json`);
writeFileSync(resolutionPath, `${JSON.stringify(resolution, null, 2)}\n`);

console.log(JSON.stringify({
  scenarioId,
  adapterId: scenario.adapterId,
  systemId: scenario.systemId,
  moduleId: scenario.moduleId,
  worldId,
  dataDir,
  resolutionPath,
  packages: Object.fromEntries(Object.entries(resolvedPackages).map(([id, definition]) => [id, definition.version])),
}));
