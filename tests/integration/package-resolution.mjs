const PACKAGE_SOURCES = Object.freeze({
  dnd5e: { id: "dnd5e", kind: "system", repository: "foundryvtt/dnd5e", tagPrefix: "release-", descriptor: "system.json" },
  sf2e: { id: "sf2e", kind: "system", repository: "foundryvtt/pf2e", tagPrefix: "sf2e-", descriptor: "system.json" },
  pf2e: { id: "pf2e", kind: "system", repository: "foundryvtt/pf2e", tagPrefix: "pf2e-", descriptor: "system.json" },
  "sf2e-anachronism": {
    id: "sf2e-anachronism",
    kind: "module",
    repository: "foundryvtt/pf2e",
    tagPrefix: "sf2e-anachronism-",
    descriptor: "module.json",
  },
  impmal: { id: "impmal", kind: "system", repository: "moo-man/ImpMal-FoundryVTT", tagPrefix: "", descriptor: "system.json" },
  socketlib: { id: "socketlib", kind: "module", repository: "farling42/foundryvtt-socketlib", tagPrefix: "v", descriptor: "module.json" },
  "warhammer-lib": {
    id: "warhammer-lib",
    kind: "module",
    repository: "moo-man/WarhammerLibrary-FVTT",
    tagPrefix: "",
    descriptor: "module.json",
  },
});

function numericParts(version) {
  return String(version ?? "")
    .replace(/^[^0-9]*/, "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
}

export function comparePackageVersions(left, right) {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function isFoundryCompatible(manifest, foundryVersion) {
  const compatibility = manifest.compatibility ?? {};
  const minimum = compatibility.minimum;
  const maximum = compatibility.maximum;
  if (minimum && comparePackageVersions(foundryVersion, minimum) < 0) return false;
  if (maximum) {
    const maximumParts = numericParts(maximum);
    const foundryParts = numericParts(foundryVersion);
    if (maximumParts.length === 1) return foundryParts[0] === maximumParts[0];
    if (comparePackageVersions(foundryVersion, maximum) > 0) return false;
  }
  return true;
}

export function selectNewestCompatiblePackage(candidates, packageId, foundryVersion) {
  const compatible = candidates
    .filter(({ manifest }) => manifest.id === packageId)
    .filter(({ manifest }) => isFoundryCompatible(manifest, foundryVersion))
    .filter(({ manifest }) => typeof manifest.download === "string" && manifest.download.length > 0)
    .sort((left, right) => comparePackageVersions(right.manifest.version, left.manifest.version));
  if (compatible.length === 0) {
    throw new Error(`No ${packageId} release is compatible with Foundry ${foundryVersion}.`);
  }
  return compatible[0];
}

async function fetchJson(url, token) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "causodes-shipcombat-integration" };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers, redirect: "follow" });
      if (response.ok) return response.json();
      if (response.status < 500 && response.status !== 429) {
        const error = new Error(`${url}: ${response.status} ${response.statusText}`);
        error.retryable = false;
        throw error;
      }
      throw new Error(`${url}: ${response.status} ${response.statusText}`);
    } catch (error) {
      if (attempt === 4 || error.retryable === false) throw error;
      console.warn(`Manifest request attempt ${attempt} failed (${error.message}); retrying.`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 2_000));
    }
  }
  throw new Error(`Unable to fetch ${url}.`);
}

export async function resolvePackage(packageId, foundryVersion, token = process.env.GITHUB_TOKEN) {
  const source = PACKAGE_SOURCES[packageId];
  if (!source) throw new Error(`Unknown integration package: ${packageId}`);

  const releases = await fetchJson(`https://api.github.com/repos/${source.repository}/releases?per_page=100`, token);
  const matching = releases.filter(release => (
    !release.draft
    && !release.prerelease
    && release.tag_name.startsWith(source.tagPrefix)
  ));
  for (const release of matching) {
    const descriptorAsset = release.assets.find(asset => asset.name === source.descriptor);
    if (!descriptorAsset) continue;
    try {
      const manifest = await fetchJson(descriptorAsset.browser_download_url, token);
      if (manifest.id !== packageId || !isFoundryCompatible(manifest, foundryVersion)) continue;
      if (typeof manifest.download !== "string" || manifest.download.length === 0) continue;
      return {
        id: source.id,
        kind: source.kind,
        version: manifest.version,
        download: manifest.download,
        manifest: descriptorAsset.browser_download_url,
        compatibility: manifest.compatibility ?? {},
      };
    } catch (error) {
      throw new Error(`Unable to resolve ${packageId} from ${release.tag_name}: ${error.message}`, { cause: error });
    }
  }
  throw new Error(`No ${packageId} release is compatible with Foundry ${foundryVersion}.`);
}
