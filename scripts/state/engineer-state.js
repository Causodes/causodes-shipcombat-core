/**
 * engineer-state.js – Power cores, heat, fire, shields, core bank, hull repair
 * extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

// ── Power Cores ───────────────────────────────────────────────────────────

export async function assignPowerCore(targetUserId) {
  const data = this.getData();
  const available = data.resources?.engineer?.powerCores ?? 0;
  if (available <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoPowerCores"));
    return;
  }
  return this.update({
    [`assignedCores.${targetUserId}`]: true,
    "resources.engineer.powerCores": available - 1,
  });
}

export async function revokePowerCore(targetUserId) {
  const data = this.getData();
  const available = data.resources?.engineer?.powerCores ?? 0;
  return this.update({
    [`assignedCores.${targetUserId}`]: false,
    "resources.engineer.powerCores": available + 1,
  });
}

export async function stagePowerCore(targetRoleId) {
  const data = this.getData();
  if (data.assignedCores?.[targetRoleId] === "spent") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.CoreAlreadyConsumed"));
    return;
  }
  // Power Fluctuation (any Core Systems tier): staging and dispatch both blocked
  if (data.conditions?.coreSystems?.tier) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.PowerFluctuation"));
    return;
  }
  // Derive available from reactor max minus currently distributed cores so the
  // guard stays accurate even if the reactor was changed mid-combat.
  const reactorStats    = this.getReactorStats();
  const _staged         = data.resources?.engineer?.stagedCores ?? {};
  const _stagedCount    = Object.values(_staged).filter(Boolean).length;
  const _distributed    = _stagedCount
    + (data.resources?.engineer?.stagedShieldCores ?? 0)
    + (data.resources?.engineer?.stagedAuxCores    ?? 0)
    + (data.resources?.engineer?.committedAuxCores ?? 0)
    + (data.shieldPool?.committed ?? 0)
    + Object.values(data.assignedCores ?? {}).filter(Boolean).length;
  const available = Math.max(0, reactorStats.coreOutput - _distributed);
  if (available <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoPowerCores"));
    return;
  }
  return this.update({
    [`resources.engineer.stagedCores.${targetRoleId}`]: true,
    "resources.engineer.powerCores": available - 1,
  });
}

export async function unstagePowerCore(targetRoleId) {
  const data = this.getData();
  const available = data.resources?.engineer?.powerCores ?? 0;
  return this.update({
    [`resources.engineer.stagedCores.${targetRoleId}`]: false,
    "resources.engineer.powerCores": available + 1,
  });
}

export async function dispatchStagedCores() {
  const data = this.getData();
  // Power Fluctuation: Core Systems Low+ blocks all core distribution
  if (data.conditions?.coreSystems?.tier) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.PowerFluctuation"));
    return;
  }
  const staged = data.resources?.engineer?.stagedCores ?? {};
  const stagedShield = data.resources?.engineer?.stagedShieldCores ?? 0;
  const stagedAux    = data.resources?.engineer?.stagedAuxCores ?? 0;
  const committedAux = data.resources?.engineer?.committedAuxCores ?? 0;
  const currentCommitted = data.shieldPool?.committed ?? 0;
  if (!Object.values(staged).some(Boolean) && stagedShield === 0 && stagedAux === 0) return;
  const updates = {};
  for (const [uid, val] of Object.entries(staged)) {
    if (val) {
      updates[`assignedCores.${uid}`] = true;
      updates[`resources.engineer.stagedCores.${uid}`] = false;
      // Increment coreCount for the role receiving the dispatched core
      updates[`resources.${uid}.coreCount`] = (data.resources?.[uid]?.coreCount ?? 0) + 1;
    }
  }
  if (stagedShield > 0) {
    updates["shieldPool.committed"] = currentCommitted + stagedShield;
    updates["resources.engineer.stagedShieldCores"] = 0;
  }
  if (stagedAux > 0) {
    updates["resources.engineer.committedAuxCores"] = committedAux + stagedAux;
    updates["resources.engineer.stagedAuxCores"] = 0;
  }
  return this.update(updates);
}

export function hasPowerCore(roleId) {
  const data = this.getData();
  return (data.resources?.[roleId]?.coreCount ?? 0) > 0;
}

// ── Emergency Vent & Internal Fire ──────────────────────────────────────

export async function emergencyVent() {
  const heat = this.getData().resources?.engineer?.heat ?? 0;
  if (heat <= 0) return;
  const currentFire = this.ship?.system?.internalFire ?? 0;
  await this.update({
    "resources.engineer.heat": 0,
    internalFire: currentFire + heat,
    ventPending: true,
  });
}

export async function reduceInternalFire(amount) {
  const current = this.ship?.system?.internalFire ?? 0;
  await this.update({ internalFire: Math.max(0, current - amount) });
}

export async function setInternalFire(value) {
  await this.update({ internalFire: Math.max(0, Math.floor(value)) });
}

// ── Auxiliary Power spending ──────────────────────────────────────────────

export async function spendBankedCores(count) {
  const current = this.ship?.system?.resources?.engineer?.auxiliaryPower ?? 0;
  const spent   = Math.min(count, current);
  if (spent <= 0) return 0;
  await this.update({ "resources.engineer.auxiliaryPower": current - spent });
  return spent;
}

// ── Shield core commitment ────────────────────────────────────────────────

export async function commitShieldCores(count) {
  const data = this.getData();
  const available = data.resources?.engineer?.powerCores ?? 0;
  const currentStaged = data.resources?.engineer?.stagedShieldCores ?? 0;
  const shieldCfg    = this.getShieldStats();
  const reactorStats = this.getReactorStats();
  const maxShieldCores = reactorStats.shieldStrengthPerCore > 0
    ? Math.ceil(shieldCfg.maxVoidFlux / reactorStats.shieldStrengthPerCore)
    : 0;
  const toStage = Math.min(count, available, Math.max(0, maxShieldCores - currentStaged));
  if (toStage <= 0) return;
  await this.update({
    "resources.engineer.powerCores": available - toStage,
    "resources.engineer.stagedShieldCores": currentStaged + toStage,
  });
}

export async function uncommitShieldCore() {
  const data = this.getData();
  const staged = data.resources?.engineer?.stagedShieldCores ?? 0;
  if (staged <= 0) return;
  const available = data.resources?.engineer?.powerCores ?? 0;
  await this.update({
    "resources.engineer.powerCores": available + 1,
    "resources.engineer.stagedShieldCores": staged - 1,
  });
}

// ── Auxiliary Power core commitment ─────────────────────────────────────

export async function commitAuxCore() {
  const data = this.getData();
  const available = data.resources?.engineer?.powerCores ?? 0;
  if (available <= 0) return;
  const currentStaged = data.resources?.engineer?.stagedAuxCores ?? 0;
  await this.update({
    "resources.engineer.powerCores": available - 1,
    "resources.engineer.stagedAuxCores": currentStaged + 1,
  });
}

export async function uncommitAuxCore() {
  const data = this.getData();
  const staged = data.resources?.engineer?.stagedAuxCores ?? 0;
  if (staged <= 0) return;
  const available = data.resources?.engineer?.powerCores ?? 0;
  await this.update({
    "resources.engineer.powerCores": available + 1,
    "resources.engineer.stagedAuxCores": staged - 1,
  });
}

export async function adjustShieldZone(sector, value) {
  const data = this.getData();
  const current = data.shields?.[sector] ?? 0;
  const pool = data.shieldPool?.current ?? 0;
  const next = Math.max(0, value);
  const diff = next - current;
  if (diff > 0 && diff > pool) return;
  await this.update({
    [`shields.${sector}`]: next,
    "shieldPool.current": pool - diff,
  });
}

// ── Hull Repair ────────────────────────────────────────────────────────────

export async function repairHull(plasmaSpent, sl) {
  const sys = this.ship?.system;
  if (!sys) return;

  const internalFire = sys.internalFire ?? 0;
  if (internalFire > 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.RepairBlockedByFire"));
    return;
  }

  const heat = sys.resources?.engineer?.heat ?? 0;
  const reactor    = ShipCombatState.getReactorStats(this.ship);
  const heatMax    = reactor.heatCapacity;
  const heatRoom   = Math.max(0, heatMax - heat);
  // Repair is capped to available heat budget (1 heat per HP) and existing damage
  const repairAttempted = Math.max(0, plasmaSpent + sl);
  const hullCurrent = sys.hull?.value ?? 0;
  const repairAmount = Math.min(repairAttempted, heatRoom, hullCurrent);
  if (repairAmount <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.HullRepairNoRoom"));
    return;
  }
  const heatCost = repairAmount;
  const newHull  = Math.max(0, hullCurrent - repairAmount);

  await this.update({
    "resources.engineer.heat": heat + heatCost,
    "hull.value": newHull,
  });

}

// ── Flux → Auxiliary Power ───────────────────────────────────────────────

/** Convert 1 voidshield flux (shieldPool.current) into 1 Auxiliary Power. */
export async function fluxToCharge() {
  const sys = this.ship?.system;
  if (!sys) return;
  const pool = sys.shieldPool?.current ?? 0;
  if (pool <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.NoFluxRemaining"));
    return;
  }
  const ap = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const apCap = this.getReactorStats().auxPowerCapacity;
  // AP Shutdown (Core Systems High): AP cannot increase
  const newAP = this.getData?.()?.conditions?.coreSystems?.tier === "high" ? ap : Math.min(apCap, ap + 1);
  await this.update({
    "shieldPool.current": pool - 1,
    "resources.engineer.auxiliaryPower": newAP,
  });
}
