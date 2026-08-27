const HULL_DAMAGE_BY_TIER = { low: 1, medium: 2, high: 3 };

export function npcCoreBlocksPowerGeneration(data) {
  return data?.conditions?.coreSystems?.tier === "high";
}

export function getNpcRoundConditionEffects(data, hullDisplayMode) {
  const conditions = data?.conditions ?? {};
  const updates = {};
  const hullTier = conditions.hull?.tier;
  const hullDamage = HULL_DAMAGE_BY_TIER[hullTier] ?? 0;
  const fireBefore = Math.max(0, Number(data?.internalFire) || 0);
  const totalHullDamage = hullDamage + fireBefore;

  if (totalHullDamage > 0) {
    const hullValue = Number(data?.hull?.value) || 0;
    const hullMax = Number(data?.hull?.max) || 50;
    updates["hull.value"] = hullDisplayMode === "hpRemaining"
      ? Math.max(0, hullValue - totalHullDamage)
      : Math.min(hullMax, hullValue + totalHullDamage);
  }

  if (hullTier === "high") {
    updates.internalFire = fireBefore + 5;
  }

  const coreTier = conditions.coreSystems?.tier;
  if (coreTier === "medium" || coreTier === "high") {
    updates.heat = Math.max(0, Number(data?.heat) || 0) + 5;
  }
  if (coreTier) {
    const currentPenalty = Math.max(0, Number(data?.movement?.coreSpeedPenalty) || 0);
    updates["movement.coreSpeedPenalty"] = currentPenalty + 1;
  }

  return {
    updates,
    blocksPowerGeneration: npcCoreBlocksPowerGeneration(data),
  };
}