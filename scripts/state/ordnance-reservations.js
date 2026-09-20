import { ORDNANCE_4MAN_COSTS, ORDNANCE_MASTER_ACTIONS } from "../constants.js";

/** Authoritative manpower and duration calculation shared by every reservation path. */
export function getOrdnanceReservation(data, actionId) {
  const action = ORDNANCE_MASTER_ACTIONS[actionId];
  if (!action) return null;
  const override = (data?.crewSize ?? 6) <= 4 ? ORDNANCE_4MAN_COSTS[actionId] : null;
  const ordnance = data?.resources?.ordnance ?? {};
  const baseCrew = override?.crew ?? action.crew;
  const baseDuration = override?.duration ?? action.duration;
  const crewCost = Math.max(2, baseCrew - Math.max(0, Number(ordnance.allocEfficiency) || 0));
  const duration = Math.max(1, baseDuration - Math.max(0, Number(ordnance.allocExpedience) || 0));
  const manpower = Math.max(0, Number(ordnance.manpower) || 0);
  return {
    action,
    crewCost,
    duration,
    manpower,
    affordable: manpower >= crewCost,
  };
}

/** Add one completed commitment's effects to an existing relative-path update. */
export function applyOrdnanceCompletionEffect(updates, data, actionId, {
  ammoCapacity = 0,
  auxPowerCapacity = 0,
  reserveMultiplier = 0,
  hullDisplayMode = "damageTaken",
} = {}) {
  const ordnance = data?.resources?.ordnance ?? {};
  if (actionId === "damageControl") {
    const fire = updates.internalFire ?? data?.internalFire ?? 0;
    if (fire > 0) updates.internalFire = Math.max(0, fire - 1);
  } else if (actionId === "hullRepairParty") {
    const hullCurrent = updates["hull.value"] ?? data?.hull?.value ?? 0;
    const hullMax = data?.hull?.max ?? 0;
    updates["hull.value"] = hullDisplayMode === "hpRemaining"
      ? Math.min(hullMax, hullCurrent + 2)
      : Math.max(0, hullCurrent - 2);
  } else if (actionId === "loadAmmo") {
    const current = updates["resources.gunner.ammo"] ?? data?.resources?.gunner?.ammo ?? 0;
    updates["resources.gunner.ammo"] = Math.min(ammoCapacity, current + Math.ceil(ammoCapacity * 0.2));
  } else if (actionId === "armTorpedo") {
    const current = updates["resources.ordnance.armedTorpedoes"] ?? ordnance.armedTorpedoes ?? 0;
    updates["resources.ordnance.armedTorpedoes"] = current + 1;
  } else if (actionId === "armCraft") {
    const current = updates["resources.ordnance.armedCraft"] ?? ordnance.armedCraft ?? 0;
    updates["resources.ordnance.armedCraft"] = current + 1;
  } else if (actionId === "loadPayload") {
    const current = updates["resources.ordnance.availablePayloads"] ?? ordnance.availablePayloads ?? 0;
    updates["resources.ordnance.availablePayloads"] = current + 1;
  } else if (actionId === "generatePower" && data?.conditions?.coreSystems?.tier !== "high") {
    const current = updates["resources.engineer.auxiliaryPower"]
      ?? data?.resources?.engineer?.auxiliaryPower
      ?? 0;
    updates["resources.engineer.auxiliaryPower"] = Math.min(
      auxPowerCapacity,
      current + reserveMultiplier,
    );
  } else if (actionId === "recallCraft") {
    const recovering = updates["resources.ordnance.craftRecovering"]
      ?? ordnance.craftRecovering
      ?? 0;
    if (recovering > 0) {
      updates["resources.ordnance.craftRecovering"] = recovering - 1;
      const armed = updates["resources.ordnance.armedCraft"] ?? ordnance.armedCraft ?? 0;
      updates["resources.ordnance.armedCraft"] = armed + 1;
    }
  } else if (actionId === "bayOptimization") {
    const commitments = updates["resources.ordnance.commitments"]
      ?? [...(ordnance.commitments ?? [])];
    updates["resources.ordnance.commitments"] = commitments.map(commitment => ({
      ...commitment,
      turnsRemaining: Math.max(0, (commitment.turnsRemaining ?? 1) - 1),
    }));
  }
  return updates;
}
