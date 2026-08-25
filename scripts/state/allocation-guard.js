/** Pure GM-side validation for every allocatable point pool. */

const ALLOCATION_KEYS = {
  captain: new Set(["allocInspire", "allocResolve", "allocInitiative"]),
  gunner: new Set(["allocAccuracy", "allocPenetration", "allocFirepower"]),
  pilot: new Set(["allocSpeed", "allocMano", "allocEvasion"]),
  ordnance: new Set(["allocEfficiency", "allocExpedience"]),
};

export function isAllocationResource(roleId, key) {
  return ALLOCATION_KEYS[roleId]?.has(key) ?? false;
}

export function validateAllocationChange(data, roleId, key, value) {
  if (!isAllocationResource(roleId, key)) return null;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const nextValue = Math.max(0, Math.trunc(numericValue));

  if (roleId === "captain") {
    const captain = data.resources?.captain ?? {};
    if (captain.allocationLocked || (captain.playedCards ?? []).length > 0) return null;
    const proposed = {
      allocInspire: captain.allocInspire ?? 0,
      allocResolve: captain.allocResolve ?? 0,
      allocInitiative: captain.allocInitiative ?? 0,
      [key]: nextValue,
    };
    const sharedOrdnance = (data.crewSize ?? 6) <= 5
      ? (data.resources?.ordnance?.allocEfficiency ?? 0) + (data.resources?.ordnance?.allocExpedience ?? 0)
      : 0;
    if (proposed.allocInspire + proposed.allocResolve + proposed.allocInitiative + sharedOrdnance > (captain.leadershipSL ?? 0)) return null;
  }

  if (roleId === "gunner") {
    const gunner = data.resources?.gunner ?? {};
    if (gunner.slLocked || (gunner.firedWeaponIds ?? []).length > 0) return null;
    if (nextValue > 0 && !gunner.ordnanceRolled) return null;
    const proposed = {
      allocAccuracy: gunner.allocAccuracy ?? 0,
      allocPenetration: gunner.allocPenetration ?? 0,
      allocFirepower: gunner.allocFirepower ?? 0,
      [key]: nextValue,
    };
    if (proposed.allocAccuracy + proposed.allocPenetration + proposed.allocFirepower > (gunner.ordnanceSL ?? 0)) return null;
  }

  if (roleId === "pilot") {
    const pilot = data.resources?.pilot ?? {};
    if ((pilot.fuelBurned ?? 0) > 0 || pilot.ramAllocLocked) return null;
    if (nextValue > 0 && !pilot.pilotingMessageId) return null;
    const proposed = {
      allocSpeed: pilot.allocSpeed ?? 0,
      allocMano: pilot.allocMano ?? 0,
      allocEvasion: pilot.allocEvasion ?? 0,
      [key]: nextValue,
    };
    if (proposed.allocSpeed + proposed.allocMano + proposed.allocEvasion > (pilot.pilotingSL ?? 0)) return null;
  }

  if (roleId === "ordnance") {
    const ordnance = data.resources?.ordnance ?? {};
    if (ordnance.actionUsed) return null;
    const proposed = {
      allocEfficiency: ordnance.allocEfficiency ?? 0,
      allocExpedience: ordnance.allocExpedience ?? 0,
      [key]: nextValue,
    };
    if ((data.crewSize ?? 6) <= 5) {
      const captain = data.resources?.captain ?? {};
      if (captain.allocationLocked || (captain.playedCards ?? []).length > 0) return null;
      if (nextValue > 0 && !captain.leadershipRolled) return null;
      const captainAllocated = (captain.allocInspire ?? 0) + (captain.allocResolve ?? 0) + (captain.allocInitiative ?? 0);
      if (captainAllocated + proposed.allocEfficiency + proposed.allocExpedience > (captain.leadershipSL ?? 0)) return null;
    } else {
      if (nextValue > 0 && !ordnance.bosunRolled) return null;
      if (proposed.allocEfficiency + proposed.allocExpedience > (ordnance.bosunSL ?? 0)) return null;
    }
  }

  return { value: nextValue };
}
