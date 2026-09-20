#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function compareFoundryVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function generationOf(version, field, manifestPath) {
  const generation = Number.parseInt(String(version ?? "").split(".")[0], 10);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`${manifestPath} has an invalid compatibility.${field}: ${version}`);
  }
  return generation;
}

export function resolveSupportedGeneration(manifestPaths) {
  if (manifestPaths.length === 0) throw new Error("At least one module manifest is required.");

  const constraints = manifestPaths.map(manifestPath => {
    const compatibility = readManifest(manifestPath).compatibility ?? {};
    const minimum = generationOf(compatibility.minimum, "minimum", manifestPath);
    const verified = generationOf(compatibility.verified, "verified", manifestPath);
    const maximum = compatibility.maximum == null
      ? Number.POSITIVE_INFINITY
      : generationOf(compatibility.maximum, "maximum", manifestPath);
    return { minimum, verified, maximum };
  });

  const minimum = Math.max(...constraints.map(({ minimum }) => minimum));
  const maximum = Math.min(...constraints.map(({ maximum }) => maximum));
  if (minimum > maximum) throw new Error("The module manifests have no mutually supported Foundry generation.");

  const highestVerified = Math.max(...constraints.map(({ verified }) => verified));
  return Number.isFinite(maximum) ? maximum : Math.max(minimum, highestVerified);
}

export function promoteVerifiedVersion(foundryVersion, manifestPaths) {
  const candidateGeneration = generationOf(foundryVersion, "verified candidate", "Foundry");
  const supportedGeneration = resolveSupportedGeneration(manifestPaths);
  if (candidateGeneration !== supportedGeneration) {
    throw new Error(
      `Refusing to promote Foundry ${foundryVersion}; the manifests mutually support generation ${supportedGeneration}.`,
    );
  }

  const changed = [];
  for (const manifestPath of manifestPaths) {
    const manifest = readManifest(manifestPath);
    if (compareFoundryVersions(foundryVersion, manifest.compatibility.verified) <= 0) continue;
    manifest.compatibility.verified = foundryVersion;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    changed.push(manifestPath);
  }
  return changed;
}

function usage() {
  return "Usage: foundry-compatibility.mjs generation <module.json...> | promote <version> <module.json...>";
}

function main([command, ...args]) {
  if (command === "generation" && args.length > 0) {
    process.stdout.write(`${resolveSupportedGeneration(args)}\n`);
    return;
  }
  if (command === "promote" && args.length > 1) {
    const [version, ...manifestPaths] = args;
    for (const changedPath of promoteVerifiedVersion(version, manifestPaths)) {
      process.stdout.write(`${path.resolve(changedPath)}\n`);
    }
    return;
  }
  throw new Error(usage());
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
