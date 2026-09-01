import { resolveShieldHit } from "./shield-resolution.js";

function normalizeTypeResult(result, fallbackDamage) {
  if (!result || typeof result !== "object") {
    return { finalDamage: fallbackDamage, immune: false, note: null };
  }
  return {
    finalDamage: Math.max(0, Number(result.finalDamage) || 0),
    immune: !!result.immune,
    note: result.note ?? null,
  };
}

async function resolveHitDamage(hit, index) {
  const resolved = typeof hit.resolveDamage === "function"
    ? await hit.resolveDamage(hit, index)
    : hit.rawDamage;
  if (resolved && typeof resolved === "object") {
    return {
      ...resolved,
      damage: Math.max(0, Number(resolved.damage) || 0),
    };
  }
  return { damage: Math.max(0, Number(resolved) || 0) };
}

function hitMetadata(hit) {
  const {
    resolveDamage: _resolveDamage,
    rawDamage: _rawDamage,
    salvoResult: _salvoResult,
    ...metadata
  } = hit ?? {};
  return metadata;
}

/** Resolve normalized hits against one target facing without mutating documents. */
export async function resolveHitsAgainstDefenses({
  hits = [],
  shields = 0,
  shieldBurn = 0,
  shieldBypass = false,
  damagePool = false,
  armour = 0,
  armourPenetration = 0,
  rendPerHit = 0,
  armourRend = 0,
  hullValue = 0,
  hullMax = 0,
  hullDisplayMode = "damageTaken",
  isNpcTarget = false,
  modifyDamage = damage => ({ finalDamage: damage, immune: false, note: null }),
} = {}) {
  const normalizedHits = Array.isArray(hits) ? hits : [];
  const sectorShields = Math.max(0, Number(shields) || 0);
  const sectorArmour = Math.max(0, Number(armour) || 0);
  const ap = Math.max(0, Number(armourPenetration) || 0);
  const effectiveArmour = Math.max(0, sectorArmour - ap);
  const rend = Math.max(0, Number(rendPerHit) || 0);
  let shieldsRemaining = sectorShields;
  let hitsAbsorbed = 0;
  let hitsThroughShield = 0;
  let shieldCostTotal = 0;
  let shieldDamageAbsorbed = 0;
  let totalDamage = 0;
  let rendTotal = 0;
  let rolledDamageTotal = 0;
  let typeModifiedDamageTotal = 0;
  let damageThroughTotal = 0;
  const hitDetails = [];
  const penetratingHits = [];

  for (let index = 0; index < normalizedHits.length; index++) {
    const hit = normalizedHits[index];
    const metadata = hitMetadata(hit);
    const immunity = normalizeTypeResult(modifyDamage(0, hit, index), 0);
    if (immunity.immune) {
      hitsAbsorbed++;
      hitDetails.push({ ...metadata, damage: 0, rawDamage: 0, immune: true, note: immunity.note });
      continue;
    }

    if (!damagePool) {
      const shieldResult = resolveShieldHit({
        shields: shieldsRemaining,
        incomingDamage: 1,
        shieldBurn,
        bypass: shieldBypass,
      });
      shieldsRemaining = shieldResult.remaining;
      shieldCostTotal += shieldResult.shieldDrain;
      if (shieldResult.hitAbsorbed) {
        hitsAbsorbed++;
        hitDetails.push({ ...metadata, damage: 0, rawDamage: 0, immune: false, shieldAbsorbed: true });
        continue;
      }
    }

    const rolled = await resolveHitDamage(hit, index);
    rolledDamageTotal += rolled.damage;
    const typeResult = normalizeTypeResult(modifyDamage(rolled.damage, hit, index), rolled.damage);
    if (typeResult.immune) {
      hitsAbsorbed++;
      hitDetails.push({ ...metadata, ...rolled, damage: 0, rawDamage: rolled.damage, immune: true, note: typeResult.note });
      continue;
    }
    typeModifiedDamageTotal += typeResult.finalDamage;

    let damageThrough = typeResult.finalDamage;
    if (damagePool) {
      const shieldResult = resolveShieldHit({
        shields: shieldsRemaining,
        incomingDamage: damageThrough,
        shieldBurn,
        bypass: shieldBypass,
        damagePool: true,
      });
      shieldsRemaining = shieldResult.remaining;
      shieldCostTotal += shieldResult.shieldDrain;
      shieldDamageAbsorbed += shieldResult.damageAbsorbed;
      damageThrough = shieldResult.damageThrough;
      if (shieldResult.hitAbsorbed) hitsAbsorbed++;
    }

    if (damageThrough <= 0) {
      hitDetails.push({ ...metadata, ...rolled, damage: 0, rawDamage: rolled.damage, immune: false, note: typeResult.note });
      continue;
    }

    hitsThroughShield++;
    damageThroughTotal += damageThrough;
    const finalDamage = Math.max(0, damageThrough - effectiveArmour);
    totalDamage += finalDamage;
    if (rend > 0) rendTotal += rend;
    const detail = {
      ...metadata,
      ...rolled,
      damage: finalDamage,
      rawDamage: rolled.damage,
      damageBeforeArmour: damageThrough,
      immune: false,
      note: typeResult.note,
    };
    hitDetails.push(detail);
    penetratingHits.push({ ...detail, sourceIndex: index });
  }

  const currentHull = Math.max(0, Number(hullValue) || 0);
  const maximumHull = Math.max(0, Number(hullMax) || 0);
  const nextHull = hullDisplayMode === "hpRemaining"
    ? Math.max(0, currentHull - totalDamage)
    : Math.min(maximumHull, currentHull + totalDamage);
  const currentArmourRend = Math.max(0, Number(armourRend) || 0);

  return {
    shieldResults: {
      sectorShields,
      absorbed: hitsAbsorbed,
      damageAbsorbed: shieldDamageAbsorbed,
      damagePool,
      shieldCostTotal,
      remaining: shieldsRemaining,
      bypassed: shieldBypass,
      hitsThroughShield,
    },
    damageResults: {
      sectorArmour,
      ap,
      effectiveArmour,
      hitsThroughShield,
      hitDetails,
      totalDamage,
      rendTotal,
      damagePool,
      resolvedHits: hitDetails.length,
      rolledDamageTotal,
      typeModifiedDamageTotal,
      damageThroughTotal,
    },
    penetratingHits,
    changes: {
      shieldsChanged: shieldsRemaining !== sectorShields,
      shields: shieldsRemaining,
      hullChanged: totalDamage > 0,
      hull: nextHull,
      armourRendChanged: rendTotal > 0,
      armourRend: currentArmourRend + rendTotal,
      armourChanged: isNpcTarget && rendTotal > 0,
      armour: isNpcTarget ? Math.max(0, sectorArmour - rendTotal) : sectorArmour,
    },
  };
}

/** Convert semantic defensive changes into Foundry actor update paths. */
export function buildDefenseUpdates(resolution, hitQuadrant, systemPath = path => `system.${path}`) {
  const changes = resolution?.changes ?? {};
  const updates = {};
  if (changes.shieldsChanged) updates[systemPath(`shields.${hitQuadrant}`)] = changes.shields;
  if (changes.hullChanged) updates[systemPath("hull.value")] = changes.hull;
  if (changes.armourRendChanged) updates[systemPath(`armourRend.${hitQuadrant}`)] = changes.armourRend;
  if (changes.armourChanged) updates[systemPath(`armour.${hitQuadrant}`)] = changes.armour;
  return updates;
}