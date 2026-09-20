function internalFire(data) {
  return Math.max(0, Number(data?.internalFire) || 0);
}

export function holdTheLineBlocksFire(data) {
  return internalFire(data) > 0
    && data?.resources?.captain?.holdTheLineActive === true;
}

export function getInternalFireHullValue(data, hullDisplayMode, fireOverride = null) {
  const fire = fireOverride == null ? internalFire(data) : Math.max(0, Number(fireOverride) || 0);
  if (fire <= 0 || data?.resources?.captain?.holdTheLineActive === true) return null;
  const value = Math.max(0, Number(data?.hull?.value) || 0);
  const max = Math.max(0, Number(data?.hull?.max) || 0);
  return hullDisplayMode === "hpRemaining"
    ? Math.max(0, value - fire)
    : Math.min(max, value + fire);
}

export function getInternalFireManpowerUpdates(data) {
  const fire = internalFire(data);
  if (fire <= 0 || holdTheLineBlocksFire(data)) return {};
  const currentMax = Math.max(0, Number(data?.resources?.ordnance?.manpowerMax) || 0);
  const manpowerMax = Math.max(0, currentMax - fire);
  const manpower = Math.max(0, Number(data?.resources?.ordnance?.manpower) || 0);
  return {
    "resources.ordnance.manpowerMax": manpowerMax,
    ...(manpower > manpowerMax ? { "resources.ordnance.manpower": manpowerMax } : {}),
  };
}

const HULL_DAMAGE_BY_TIER = Object.freeze({ low: 1, medium: 2, high: 3 });

/**
 * Project the condition and internal-fire effects for a player ship's new
 * turn. Both Foundry combat advancement and the manual round control consume
 * this projection so they cannot drift into different rules.
 */
export function getPlayerTurnConditionUpdates(data, hullDisplayMode) {
  const conditions = data?.conditions ?? {};
  const hullTier = conditions.hull?.tier;
  const hullDamage = HULL_DAMAGE_BY_TIER[hullTier] ?? 0;
  const fireBefore = internalFire(data);
  const fireDamage = holdTheLineBlocksFire(data) ? 0 : fireBefore;
  const totalHullDamage = hullDamage + fireDamage;
  const updates = {};

  if (totalHullDamage > 0) {
    const hullValue = Math.max(0, Number(data?.hull?.value) || 0);
    const hullMax = Math.max(0, Number(data?.hull?.max) || 0);
    updates["hull.value"] = hullDisplayMode === "hpRemaining"
      ? Math.max(0, hullValue - totalHullDamage)
      : Math.min(hullMax, hullValue + totalHullDamage);
  }
  if (hullTier === "high") updates.internalFire = fireBefore + 5;

  const coreTier = conditions.coreSystems?.tier;
  if (coreTier === "medium" || coreTier === "high") {
    updates["resources.engineer.heat"] = Math.max(
      0,
      Number(data?.resources?.engineer?.heat) || 0,
    ) + 5;
  }
  return updates;
}

/** Pure relative-path reset applied whenever an NPC ship starts a new turn. */
export function getNpcTurnResetUpdates(data) {
  const pilot = data?.resources?.pilot ?? {};
  const speed = Number(data?.movement?.speed) || 0;
  const allocSpeed = Number(pilot.allocSpeed) || 0;
  const previousMove = Number(pilot.prevTurnMove) || 0;
  const fuelBurned = Number(pilot.fuelBurned) || 0;
  const minimumMove = Math.ceil(previousMove / 2);
  const updates = {
    "resources.pilot.prevTurnMove": fuelBurned > 0
      ? Math.round((fuelBurned / 100) * (speed + allocSpeed + minimumMove))
      : previousMove,
    "resources.pilot.fuelBurned": 0,
    "resources.pilot.bearing": 0,
    "resources.pilot.pilotingSL": 0,
    "resources.pilot.pilotingMessageId": "",
    "resources.pilot.allocSpeed": 0,
    "resources.pilot.allocMano": 0,
    "resources.pilot.allocEvasion": 0,
    "resources.pilot.ramAllocLocked": false,
    "resources.gunner.ordnanceSL": 0,
    "resources.gunner.ordnanceRolled": false,
    "resources.gunner.allocAccuracy": 0,
    "resources.gunner.allocPenetration": 0,
    "resources.gunner.allocFirepower": 0,
    "resources.gunner.slLocked": false,
    "resources.gunner.firedWeaponIds": [],
    engActionUsed: false,
  };
  const fluxMax = Math.max(0, Number(data?.voidshieldFlux) || 0);
  if (fluxMax > 0) updates.voidshieldFluxRemaining = fluxMax;
  return updates;
}
