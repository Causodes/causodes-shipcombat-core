/**
 * Engineer role – three mutually exclusive actions per turn:
 *   1. Core Distribution  – stage cores for roles + shield commitment + overclock + emergency vent
 *   2. Heat Management    – Rite of Cooling (costs 1 banked core, Engineering test)
 *   3. Fire Suppression   – Suppression Rite (costs 1+ banked cores, Engineering test)
 *
 * Each section is overlaid with a selection button. Clicking the overlay commits
 * to that action branch for the turn (appends to actionChoices[], removes the overlay).
 * resources.engineer.actionChoices: string[]   -  selected action IDs this turn
 * resources.engineer.extraActions:  number     -  extra slots granted by captain cards
 *
 * Staged cores: toggle-bolts stage/unstage cores (deducted from pool, not yet
 * granted to roles). "Dispatch Cores" button commits staged → assignedCores.
 *
 * Shield commitment: part of Core Distribution. Multiple cores can be committed
 * to shields; they convert to void flux at the start of the NEXT round.
 *
 * Overclock: Engineering test whose difficulty scales with heat tier.
 * Binary result: success = +1 core, failure = no core; heat always +1.
 *
 * Emergency Vent: sets heat to 0, starts Internal Fire = heat vented,
 * sets ventLocked = true (locks Core Distribution NEXT turn, not this one).
 *
 * Core bank: unused cores at end of turn bank (capped by reactor's bankCapacity).
 * Banked cores (Auxiliary Power) can ONLY be spent on Heat Management and Fire Suppression.
 */
import { emitToGM } from "../socket.js";
import { heatColor } from "../theme.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { MODULE_ID, hullDisplay } from "../constants.js";

function _getHeatCapacity(shipActor) {
  const reactor = shipActor?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "reactor");
  return reactor?.system?.heatCapacity ?? 0;
}

// Heat tier breakpoints for overclock difficulty
const HEAT_TIERS = [
  { max: 2, label: "Easy",      modifier: 40  },
  { max: 4, label: "Average",   modifier: 20  },
  { max: 6, label: "Challenging", modifier: 0 },
  { max: 7, label: "Difficult", modifier: -10 },
  { max: 8, label: "Hard",      modifier: -20 },
  { max: 9, label: "Very Hard", modifier: -30 },
];

function _getOverclockModifier(heat) {
  for (const tier of HEAT_TIERS) {
    if (heat <= tier.max) return tier;
  }
  return { max: Infinity, label: "Very Hard", modifier: -30 };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function _resolveEngineerActor(sheet) {
  const sys = SystemAdapter.current.getShipData(sheet.actor);
  const ref = sys.crewActors?.engineer;
  if (ref?.uuid) {
    try { return await fromUuid(ref.uuid); } catch { /* ignore */ }
  }
  const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "engineer");
  if (entry) {
    const user = game.users.get(entry[0]);
    return user?.character ?? null;
  }
  return null;
}

// ── Action handlers ─────────────────────────────────────────────────────────

/** Overlay button clicked  -  claim that action branch for one of this turn's action slots. */
async function _onSelectAction(event, target) {
  const actionType = target.dataset.actionType;
  if (!actionType) return;
  const sys = SystemAdapter.current.getShipData(this.actor);
  const current = sys.resources?.engineer?.actionChoices ?? [];
  if (current.includes(actionType)) return; // already selected
  const updated = [...current, actionType];
  emitToGM("updateResource", { roleId: "engineer", key: "actionChoices", value: updated });
}

/**
 * Overclock reactor: Engineering test, difficulty based on current heat tier.
 * Success: +1 core to pool. Failure: no core. Heat always increases by 1.
 */
async function _onOverclock() {
  const sys  = SystemAdapter.current.getShipData(this.actor);
  const heat = sys.resources?.engineer?.heat ?? 0;
  const heatMax = _getHeatCapacity(this.actor);
  if (heat >= heatMax) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.ReactorOverheated"));
  }

  const crewActor = await _resolveEngineerActor(this);
  if (!crewActor) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoEngineer"));
  }

  const tier = _getOverclockModifier(heat);
  const result = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.engineer ?? "engineering", { modifier: tier.modifier });
  if (!result) return;

  // Heat always increases regardless of result
  emitToGM("updateResource", { roleId: "engineer", key: "heat", value: heat + 1 });

  const succeeded = result.SL >= 0;
  if (succeeded) {
    const available = sys.resources?.engineer?.powerCores ?? 0;
    emitToGM("updateResource", { roleId: "engineer", key: "powerCores", value: available + 1 });
  } else {
  }
}

/** Dispatch staged cores → assignedCores so roles can use their Overcharged action. */
async function _onDispatchCores() {
  emitToGM("dispatchStagedCores", {});
}

/** Commit one core to shields. */
async function _onCommitShieldCore() {
  emitToGM("commitShieldCores", { count: 1 });
}

/** Remove one committed shield core back to available pool. */
async function _onUncommitShieldCore() {
  emitToGM("uncommitShieldCore", {});
}

/** Commit one core to auxiliary power. */
async function _onCommitAuxCore() {
  emitToGM("commitAuxCore", {});
}

/** Remove one staged auxiliary power core. */
async function _onUncommitAuxCore() {
  emitToGM("uncommitAuxCore", {});
}

/**
 * Rite of Cooling: costs heatCoresStaged banked cores. Engineering test,
 * reduce heat by coresSpent + SL (min 1).
 */
async function _onManageHeat() {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const bank = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const coresStaged = Math.min(sys.resources?.engineer?.heatCoresStaged ?? 1, bank);
  if (coresStaged < 1) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoBankedCores"));
  }

  const crewActor = await _resolveEngineerActor(this);
  if (!crewActor) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoEngineer"));
  }

  // Spend banked cores
  emitToGM("spendBankedCores", { count: coresStaged });

  const test2 = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.engineer ?? "engineering");
  if (!test2) return;

  const sl = Math.max(0, test2.SL);
  const reduction = Math.max(1, coresStaged + sl);
  const heat = sys.resources?.engineer?.heat ?? 0;
  const newHeat = Math.max(0, heat - reduction);

  emitToGM("updateResource", { roleId: "engineer", key: "heat", value: newHeat });
  // Reset staged value
  emitToGM("updateResource", { roleId: "engineer", key: "heatCoresStaged", value: 1 });
}

/**
 * Emergency Vent: heat → 0, starts Internal Fire equal to heat vented.
 * Sets ventLocked (Core Distribution locked NEXT turn).
 * Moved to Core Distribution section.
 */
async function _onEmergencyVent() {
  const heat = SystemAdapter.current.getShipData(this.actor).resources?.engineer?.heat ?? 0;
  if (heat <= 0) return;

  const ok = await foundry.applications.api.DialogV2.confirm({
    window:  { title: game.i18n.localize("SHIPCOMBAT.Dialog.EmergencyVent") },
    content: `<p>${game.i18n.format("SHIPCOMBAT.Dialog.EmergencyVentBody", { heat })}</p>`,
  });
  if (!ok) return;

  emitToGM("emergencyVent", {});
}

/**
 * Suppression Rite: costs fireCoresStaged banked cores (set via +/- in UI).
 * Each core spent = 1 flat fire severity reduction (pre-roll).
 * Engineering test SL = additional fire severity reduction (post-roll).
 */
async function _onSuppressFire() {
  const sys  = SystemAdapter.current.getShipData(this.actor);
  const fire = sys.internalFire ?? 0;
  const bank = sys.resources?.engineer?.auxiliaryPower ?? 0;

  if (fire <= 0) {
    return ui.notifications.info(game.i18n.localize("SHIPCOMBAT.Engineer.NoFire"));
  }
  if (bank < 1) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoBankedCores"));
  }

  const crewActor = await _resolveEngineerActor(this);
  if (!crewActor) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoEngineer"));
  }

  const maxSpend = Math.min(bank, fire);
  const coresSpent = Math.max(1, Math.min(sys.resources?.engineer?.fireCoresStaged ?? 1, maxSpend));

  // Spend banked cores
  emitToGM("spendBankedCores", { count: coresSpent });

  // Engineering test
  const test3 = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.engineer ?? "engineering");
  if (!test3) return;

  const sl = Math.max(0, test3.SL);
  const totalReduction = coresSpent + sl;

  emitToGM("reduceInternalFire", { amount: totalReduction });
  // Reset staged value
  emitToGM("updateResource", { roleId: "engineer", key: "fireCoresStaged", value: 1 });
}

/** Adjust heatCoresStaged by delta, clamped [1, coreBank]. */
async function _onAdjustHeatCores(event, target) {
  const delta = Number(target.dataset.delta) || 0;
  const sys = SystemAdapter.current.getShipData(this.actor);
  const bank = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const current = sys.resources?.engineer?.heatCoresStaged ?? 1;
  const next = Math.max(1, Math.min(bank, current + delta));
  emitToGM("updateResource", { roleId: "engineer", key: "heatCoresStaged", value: next });
}

/** Adjust fireCoresStaged by delta, clamped [1, min(coreBank, internalFire)]. */
async function _onAdjustFireCores(event, target) {
  const delta = Number(target.dataset.delta) || 0;
  const sys = SystemAdapter.current.getShipData(this.actor);
  const bank = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const fire = sys.internalFire ?? 0;
  const maxSpend = Math.min(bank, fire);
  const current = sys.resources?.engineer?.fireCoresStaged ?? 1;
  const next = Math.max(1, Math.min(maxSpend, current + delta));
  emitToGM("updateResource", { roleId: "engineer", key: "fireCoresStaged", value: next });
}

/** Adjust repairPlasmaStaged by delta, clamped [1, coreBank]. */
async function _onAdjustRepairPlasma(event, target) {
  const delta = Number(target.dataset.delta) || 0;
  const sys = SystemAdapter.current.getShipData(this.actor);
  const bank = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const current = sys.resources?.engineer?.repairPlasmaStaged ?? 1;
  const next = Math.max(1, Math.min(bank, current + delta));
  emitToGM("updateResource", { roleId: "engineer", key: "repairPlasmaStaged", value: next });
}

/**
 * Hull Repair: costs 2 heat + N plasma reserves (banked cores).
 * Engineering test, hull restored = plasmaSpent + SL (min 0).
 * Cannot repair while internal fire is active.
 */
async function _onRepairHull() {
  const sys  = SystemAdapter.current.getShipData(this.actor);
  const heat = sys.resources?.engineer?.heat ?? 0;
  const fire = sys.internalFire ?? 0;
  const bank = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const hull = sys.hull?.value ?? 0;
  const hullMax = sys.hull?.max ?? 50;
  const heatMax = _getHeatCapacity(this.actor);

  if (fire > 0) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.RepairBlockedByFire"));
  }
  if (hull >= hullMax) {
    return ui.notifications.info(game.i18n.localize("SHIPCOMBAT.Engineer.HullFull"));
  }
  if (heat + 2 > heatMax) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.HeatTooHighForRepair"));
  }
  if (bank < 1) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoBankedCores"));
  }

  const crewActor = await _resolveEngineerActor(this);
  if (!crewActor) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoEngineer"));
  }

  const plasmaSpent = Math.max(1, Math.min(bank, sys.resources?.engineer?.repairPlasmaStaged ?? 1));

  // Spend banked cores (plasma reserves)
  emitToGM("spendBankedCores", { count: plasmaSpent });

  // Engineering test
  const result = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.engineer ?? "engineering");
  if (!result) return;

  const sl = Math.max(0, result.SL);
  emitToGM("repairHull", { plasmaSpent, sl });

  // Reset staged value
  emitToGM("updateResource", { roleId: "engineer", key: "repairPlasmaStaged", value: 1 });
}

/** Convert 1 voidshield flux into 1 Auxiliary Power. */
async function _onFluxToCharge() {
  const pool = SystemAdapter.current.getShipData(this.actor).shieldPool?.current ?? 0;
  if (pool <= 0) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.NoFluxRemaining"));
  emitToGM("fluxToCharge", {});
}

// ── Exported action map ────────────────────────────────────────────────────

export const ENGINEER_ACTIONS = {
  selectAction:        _onSelectAction,
  overclock:           _onOverclock,
  dispatchCores:       _onDispatchCores,
  commitShieldCore:    _onCommitShieldCore,
  uncommitShieldCore:  _onUncommitShieldCore,
  commitAuxCore:       _onCommitAuxCore,
  uncommitAuxCore:     _onUncommitAuxCore,
  manageHeat:          _onManageHeat,
  emergencyVent:       _onEmergencyVent,
  suppressFire:        _onSuppressFire,
  adjustHeatCores:     _onAdjustHeatCores,
  adjustFireCores:     _onAdjustFireCores,
  repairHull:          _onRepairHull,
  adjustRepairPlasma:  _onAdjustRepairPlasma,
  fluxToCharge:        _onFluxToCharge,
};

// ── Engineer context builder ────────────────────────────────────────────────

export function buildEngineerContext(sys, opts = {}) {
  const heat         = sys.resources?.engineer?.heat         ?? 0;
  const powerCores   = sys.resources?.engineer?.powerCores   ?? 0;
  const actionChoices    = sys.resources?.engineer?.actionChoices ?? [];
  const extraActions     = sys.resources?.engineer?.extraActions  ?? 0;
  const actionsAllowed   = 1 + extraActions;
  const actionsRemaining = Math.max(0, actionsAllowed - actionChoices.length);
  const ventLocked   = sys.ventLocked ?? false;
  const internalFire = sys.internalFire ?? 0;
  const stagedCores  = sys.resources?.engineer?.stagedCores  ?? {};
  const stagedShieldCores = sys.resources?.engineer?.stagedShieldCores ?? 0;
  const stagedAuxCores    = sys.resources?.engineer?.stagedAuxCores ?? 0;
  const committedAuxCores = sys.resources?.engineer?.committedAuxCores ?? 0;
  const auxiliaryPower = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const ventPending   = sys.ventPending ?? false;
  const shieldCommitted = sys.shieldPool?.committed ?? 0;
  const shieldCurrent   = sys.shieldPool?.current   ?? 0;
  const heatCoresStaged = Math.max(1, Math.min(auxiliaryPower, sys.resources?.engineer?.heatCoresStaged ?? 1));
  const fireCoresStaged = Math.max(1, Math.min(Math.min(auxiliaryPower, internalFire), sys.resources?.engineer?.fireCoresStaged ?? 1));
  const repairPlasmaStaged = Math.max(1, Math.min(auxiliaryPower, sys.resources?.engineer?.repairPlasmaStaged ?? 1));

  const { reactorStats, shieldStats } = opts;
  const shieldStrengthPerCore = reactorStats?.shieldStrengthPerCore ?? 0;
  const maxVoidFlux           = shieldStats?.maxVoidFlux ?? 0;
  const heatMax               = reactorStats?.heatCapacity ?? 0;
  const auxPowerCapacity      = reactorStats?.auxPowerCapacity ?? 0;
  const reserveMultiplier     = reactorStats?.reserveMultiplier ?? 0;

  // Projected shield pool next turn: staged (not yet dispatched) + committed (dispatched this turn)
  const projectedShieldPool = Math.min(
    (stagedShieldCores + shieldCommitted) * shieldStrengthPerCore,
    maxVoidFlux
  );

  // Projected aux power gain from staged and dispatched aux cores.
  const projectedAuxGain = (stagedAuxCores + committedAuxCores) * reserveMultiplier;

  const overclockTier = _getOverclockModifier(heat);

  return {
    heat,
    heatMax,
    heatPct:           heatMax > 0 ? Math.round((heat / heatMax) * 100) : 0,
    heatColor:         heatColor(heatMax > 0 ? Math.round((heat / heatMax) * 100) : 0),
    auxiliaryPower,
    auxPowerCapacity,
    plasmaPct:         auxPowerCapacity > 0 ? Math.round((auxiliaryPower / auxPowerCapacity) * 100) : 0,
    canOverclock:      heat < heatMax,
    coresExhausted:    powerCores <= 0,
    // Multi-action slot system
    actionChoices,
    actionsAllowed,
    actionsRemaining,
    // Per-section "selected" flags  -  overlay is hidden when true
    coresSelected:  actionChoices.includes("cores"),
    heatSelected:   actionChoices.includes("heat"),
    fireSelected:   actionChoices.includes("fire"),
    repairSelected: actionChoices.includes("repair"),
    internalFire,
    hasInternalFire:   internalFire > 0,
    hasStaged:         Object.values(stagedCores).some(Boolean) || stagedShieldCores > 0 || stagedAuxCores > 0,
    hasBankedCores:    auxiliaryPower > 0,
    ventLocked,
    ventPending,
    stagedShieldCores,
    stagedAuxCores,
    committedAuxCores,
    shieldCommitted,
    shieldCurrent,
    shieldStrengthPerCore,
    maxVoidFlux,
    projectedShieldPool,
    projectedAuxGain,
    reserveMultiplier,
    heatCoresStaged,
    fireCoresStaged,
    repairPlasmaStaged,
    overclockTier:     overclockTier.label,
    overclockModifier: overclockTier.modifier,
    hull:              sys.hull?.value ?? 0,
    hullMax:           sys.hull?.max ?? 50,
    hullPct:           hullDisplay(sys.hull?.value ?? 0, sys.hull?.max ?? 50).pct,
    hullDisplayValue:  hullDisplay(sys.hull?.value ?? 0, sys.hull?.max ?? 50).displayValue,
    // hullFull: true when hull is at maximum health (mode-aware).
    // HP mode:     hull.value = current HP; full = value >= max.
    // Wounds mode: hull.value = damage taken; full = value === 0.
    hullFull: SystemAdapter.current.hullDisplayMode === "hpRemaining"
      ? (sys.hull?.value ?? 0) >= (sys.hull?.max ?? Infinity)
      : (sys.hull?.value ?? 0) <= 0,
    canRepairHull:     internalFire === 0 && auxiliaryPower > 0 && (sys.hull?.value ?? 0) > 0 && (sys.hull?.value ?? 0) < (sys.hull?.max ?? Infinity) && heat < heatMax,
    // Shield allocation  -  Engineer manages sector distribution (moved from Captain in v10)
    shields: _buildShieldSectors(sys, opts),
    // ── Captain boost cards targeting Engineer ───────────────────────────────────
    captainBoosts: (sys.resources?.captain?.playedCards ?? [])
      .filter(id => ["overdriveCommand", "doubleShift"].includes(id))
      .map(id => ({ id, label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${id}`) })),
    // ── Crit condition flags ──────────────────────────────────────────────────────
    // Power Fluctuation (Low+): core distribution disabled
    powerFluctuation:  !!(sys.conditions?.coreSystems?.tier),
    // Heat Surge (Medium+): +5 heat per round
    heatSurge:         sys.conditions?.coreSystems?.tier === "medium" || sys.conditions?.coreSystems?.tier === "high",
    // AP Shutdown (High): AP generation from all sources disabled
    apDisabled:        sys.conditions?.coreSystems?.tier === "high",
  };
}

function _buildShieldSectors(sys, opts) {
  const ztMap = opts.shieldStats?.zoneThresholds ?? { bow: 0, stern: 0, port: 0, starboard: 0 };
  const _sector = (id) => {
    const val = sys.shields?.[id] ?? 0;
    const zt  = ztMap[id] || 1;
    return { val, pct: +(Math.min(1, val / zt).toFixed(3)), over: val > zt };
  };
  return {
    bow:       _sector("bow"),
    starboard: _sector("starboard"),
    stern:     _sector("stern"),
    port:      _sector("port"),
  };
}
