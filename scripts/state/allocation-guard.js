/** Pure GM-side validation for every allocatable point pool. */

const ALLOCATION_KEYS = {
  captain: new Set(["allocInspire", "allocResolve", "allocInitiative"]),
  gunner: new Set(["allocAccuracy", "allocPenetration", "allocFirepower"]),
  pilot: new Set(["allocSpeed", "allocMano", "allocEvasion"]),
  ordnance: new Set(["allocEfficiency", "allocExpedience"]),
};

const ALLOCATION_POOLS = {
  captain: {
    locked: data => data.resources?.captain?.allocationLocked,
    rolled: data => data.resources?.captain?.leadershipRolled,
    total: data => data.resources?.captain?.leadershipSL ?? 0,
    allocated: data => {
      const captain = data.resources?.captain ?? {};
      const ordnance = data.resources?.ordnance ?? {};
      return (captain.allocInspire ?? 0)
        + (captain.allocResolve ?? 0)
        + (captain.allocInitiative ?? 0)
        + ((data.crewSize ?? 6) <= 5 ? (ordnance.allocEfficiency ?? 0) + (ordnance.allocExpedience ?? 0) : 0);
    },
  },
  gunner: {
    locked: data => data.resources?.gunner?.slLocked || (data.resources?.gunner?.firedWeaponIds ?? []).length > 0,
    rolled: data => data.resources?.gunner?.ordnanceRolled,
    total: data => data.resources?.gunner?.ordnanceSL ?? 0,
    allocated: data => {
      const gunner = data.resources?.gunner ?? {};
      return (gunner.allocAccuracy ?? 0) + (gunner.allocPenetration ?? 0) + (gunner.allocFirepower ?? 0);
    },
  },
  pilot: {
    locked: data => (data.resources?.pilot?.fuelBurned ?? 0) > 0 || data.resources?.pilot?.ramAllocLocked,
    rolled: data => !!data.resources?.pilot?.pilotingMessageId,
    total: data => data.resources?.pilot?.pilotingSL ?? 0,
    allocated: data => {
      const pilot = data.resources?.pilot ?? {};
      return (pilot.allocSpeed ?? 0) + (pilot.allocMano ?? 0) + (pilot.allocEvasion ?? 0);
    },
  },
  ordnance: {
    locked: data => data.resources?.ordnance?.actionUsed
      || ((data.crewSize ?? 6) <= 5 && data.resources?.captain?.allocationLocked),
    rolled: data => (data.crewSize ?? 6) <= 5
      ? data.resources?.captain?.leadershipRolled
      : data.resources?.ordnance?.bosunRolled,
    total: data => (data.crewSize ?? 6) <= 5
      ? data.resources?.captain?.leadershipSL ?? 0
      : data.resources?.ordnance?.bosunSL ?? 0,
    allocated: data => {
      const ordnance = data.resources?.ordnance ?? {};
      const captain = data.resources?.captain ?? {};
      return (ordnance.allocEfficiency ?? 0)
        + (ordnance.allocExpedience ?? 0)
        + ((data.crewSize ?? 6) <= 5
          ? (captain.allocInspire ?? 0) + (captain.allocResolve ?? 0) + (captain.allocInitiative ?? 0)
          : 0);
    },
  },
};

export function getUnspentAllocation(data, roleId) {
  const pool = ALLOCATION_POOLS[roleId];
  if (!pool || pool.locked(data)) return null;
  if (!pool.rolled(data)) return { roleId, state: "unrolled" };
  const remaining = Math.max(0, pool.total(data) - pool.allocated(data));
  return remaining > 0 ? { roleId, state: "unspent", remaining } : null;
}

export function isAllocationResource(roleId, key) {
  return ALLOCATION_KEYS[roleId]?.has(key) ?? false;
}

export function validateAllocationChange(data, roleId, key, value) {
  if (!isAllocationResource(roleId, key)) return null;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const nextValue = Math.max(0, Math.trunc(numericValue));
  if (!ALLOCATION_POOLS[roleId]?.rolled(data)) return null;

  if (roleId === "captain") {
    const captain = data.resources?.captain ?? {};
    if (captain.allocationLocked) return null;
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
      if (captain.allocationLocked) return null;
      const captainAllocated = (captain.allocInspire ?? 0) + (captain.allocResolve ?? 0) + (captain.allocInitiative ?? 0);
      if (captainAllocated + proposed.allocEfficiency + proposed.allocExpedience > (captain.leadershipSL ?? 0)) return null;
    } else {
      if (proposed.allocEfficiency + proposed.allocExpedience > (ordnance.bosunSL ?? 0)) return null;
    }
  }

  return { value: nextValue };
}
