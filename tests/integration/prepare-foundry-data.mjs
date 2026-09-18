import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const PACKAGE_CATALOG = Object.freeze({
  dnd5e: {
    id: "dnd5e",
    kind: "system",
    version: "5.3.3",
    download: "https://github.com/foundryvtt/dnd5e/releases/download/release-5.3.3/dnd5e-release-5.3.3.zip",
  },
  sf2e: {
    id: "sf2e",
    kind: "system",
    version: "1.4.1",
    download: "https://github.com/foundryvtt/pf2e/releases/download/sf2e-1.4.1/system.zip",
  },
  impmal: {
    id: "impmal",
    kind: "system",
    version: "4.0.0",
    download: "https://github.com/moo-man/ImpMal-FoundryVTT/releases/download/4.0.0/impmal.zip",
  },
  socketlib: {
    id: "socketlib",
    kind: "module",
    version: "v1.1.4",
    download: "https://github.com/farling42/foundryvtt-socketlib/releases/download/v1.1.4/module.zip",
  },
  "warhammer-lib": {
    id: "warhammer-lib",
    kind: "module",
    version: "3.3.4",
    download: "https://github.com/moo-man/WarhammerLibrary-FVTT/releases/download/3.3.4/warhammer-lib.zip",
  },
});

const ADAPTERS = Object.freeze({
  dnd5e: { moduleId: "causodes-shipcombat-dnd5e", dependencies: ["socketlib"] },
  sf2e: { moduleId: "causodes-shipcombat-sf2e", dependencies: ["socketlib"] },
  impmal: { moduleId: "causodes-shipcombat-impmal", dependencies: ["socketlib", "warhammer-lib"] },
});

const [adapterId, checkoutsArg, dataArg] = process.argv.slice(2);
if (!ADAPTERS[adapterId] || !checkoutsArg || !dataArg) {
  throw new Error("Usage: node prepare-foundry-data.mjs <dnd5e|sf2e|impmal> <checkouts-dir> <foundry-data-dir>");
}

const checkoutsDir = resolve(checkoutsArg);
const dataDir = resolve(dataArg);
const adapter = ADAPTERS[adapterId];
const worldId = `shipcombat-integration-${adapterId}`;
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

async function installPackage(packageId) {
  const definition = PACKAGE_CATALOG[packageId];
  const parent = join(dataDir, `Data/${definition.kind}s`);
  const destination = join(parent, definition.id);
  const scratch = mkdtempSync(join(tmpdir(), `shipcombat-${definition.id}-`));
  const archive = join(scratch, "package.zip");
  const extracted = join(scratch, "extracted");
  mkdirSync(extracted);

  try {
    const response = await fetch(definition.download, { redirect: "follow" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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

stageCheckedOutModule("causodes-shipcombat-core");
stageCheckedOutModule(adapter.moduleId);
await installPackage(adapterId);
for (const dependency of adapter.dependencies) await installPackage(dependency);

const worldDir = join(dataDir, "Data/worlds", worldId);
mkdirSync(worldDir, { recursive: true });
mkdirSync(join(worldDir, "data"), { recursive: true });
mkdirSync(join(worldDir, "scenes"), { recursive: true });
writeFileSync(join(worldDir, "world.json"), `${JSON.stringify({
  id: worldId,
  title: `Ship Combat Integration (${adapterId})`,
  description: "Disposable CI fixture world.",
  system: adapterId,
  coreVersion: foundryVersion,
  compatibility: { minimum: "14", verified: foundryVersion, maximum: "14" },
  systemVersion: PACKAGE_CATALOG[adapterId].version,
  joinTheme: "minimal",
  flags: {},
}, null, 2)}\n`);

console.log(JSON.stringify({ adapterId, moduleId: adapter.moduleId, worldId, dataDir }));
