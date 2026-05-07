/**
 * Sensors (Augur) role  -  v10 AP-based lock system.
 *
 * Resources:
 *   - Auxiliary Power (AP)  -  shared with Engineer, generated from unspent cores.
 *     Lock upgrades and core actions cost AP.
 *
 * Lock Tiers (tracked per-target):
 *   0  -  Contact (unknown blip)
 *   1  -  Active Ping      (3 AP)   -  ship class visible, targetable by Gunner
 *   2  -  Breach Analysis   (6 AP)   -  shield presence revealed
 *   3  -  Deep Scan         (10 AP)  -  shield values, armour, hull, weapons revealed
 *   4  -  Targeting Solution (15 AP)  -  +10 accuracy, negates Zone 3 penalty
 *
 * Locks are consumed when the Gunner fires at a locked target (drops to 0).
 * After fire, BDA becomes available  -  the Augur rolls to retain partial lock.
 *
 * BDA (Battle Damage Assessment):
 *   After a Gunner fires at a locked target, Augur rolls Sensors:
 *     SL 0+ = reveal damage card.  SL 2+ = retain Tier 1.
 *     SL 4+ = Tier 2.  SL 6+ = Tier 3.  SL 8+ = Tier 4.
 *   Then choose one Fire Correction:
 *     - Adjust Bearing: +10 to hit on next attack (same weapon, same target)
 *     - Target Weak Point: +SL to AP on next attack
 *     - Fire for Effect: crit threshold reduced by SL on next attack
 *     - Break Off, Reallocate: grants 20% max AP; gunner may retarget next turn
 *
 * Focused Scan: free once/turn, roll Sensors → success returns +SL AP.
 *
 * Core Actions (require Power Core + AP):
 *   Combat Telemetry (12 AP)  -  all locked targets → Lock 4
 *   Sensor Overcharge (10 AP)  -  target weapon accuracy −20 for 2 rounds
 *   Signal Inversion (10 AP)  -  strip shields from nearest quadrant
 *   Sensor Surge (8 AP)  -  BDA +30; fire correction applies to ALL weapons
 *   Deep Revelation (15 AP)  -  reveal ALL target stats permanently
 */
import { emitToGM } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { LOCK_DECAY_ROUNDS, AUGUR_LOCK_COSTS, AUGUR_CORE_ACTIONS, BDA_CORRECTIONS, MODULE_ID } from "../constants.js";
import { SensorRadar } from "../canvas/SensorRadar.js";
import { BDAPopup, launchBDAFromChat } from "../apps/BDAPopup.js";

// ── Constants ────────────────────────────────────────────────────────────────

// Lock-upgrade actions  -  each advances one lock tier on a target. Costs AP.
const LOCK_ACTIONS = [
  { id: "activePing",        cost: AUGUR_LOCK_COSTS.activePing,        label: "SHIPCOMBAT.Sensors.ActivePing",        desc: "SHIPCOMBAT.Sensors.ActivePingDesc",        setsTier: 1, requiresTier: 0 },
  { id: "breachAnalysis",    cost: AUGUR_LOCK_COSTS.breachAnalysis,    label: "SHIPCOMBAT.Sensors.BreachAnalysis",    desc: "SHIPCOMBAT.Sensors.BreachAnalysisDesc",    setsTier: 2, requiresTier: 1 },
  { id: "deepScan",          cost: AUGUR_LOCK_COSTS.deepScan,          label: "SHIPCOMBAT.Sensors.DeepScan",          desc: "SHIPCOMBAT.Sensors.DeepScanDesc",          setsTier: 3, requiresTier: 2 },
  { id: "targetingSolution", cost: AUGUR_LOCK_COSTS.targetingSolution, label: "SHIPCOMBAT.Sensors.TargetingSolution", desc: "SHIPCOMBAT.Sensors.TargetingSolutionDesc", setsTier: 4, requiresTier: 2 },
];

// Non-lock utility actions  -  also cost AP now.
const UTILITY_ACTIONS = [
  { id: "sensorDisruption",      cost: 12, label: "SHIPCOMBAT.Sensors.SensorDisruption",      desc: "SHIPCOMBAT.Sensors.SensorDisruptionDesc",      targeted: true,  duration: 1, requiresTier: 1 },
  { id: "lockHarmonics",         cost: 6,  label: "SHIPCOMBAT.Sensors.LockHarmonics",         desc: "SHIPCOMBAT.Sensors.LockHarmonicsDesc",         targeted: false, duration: 1 },
  { id: "sensorOvercharge",      cost: 16, label: "SHIPCOMBAT.Sensors.SensorOvercharge",      desc: "SHIPCOMBAT.Sensors.SensorOverchargeDesc",      targeted: true,  duration: 2 },
  { id: "rangeAmplifier",        cost: 24, label: "SHIPCOMBAT.Sensors.RangeAmplifier",        desc: "SHIPCOMBAT.Sensors.RangeAmplifierDesc",        targeted: false, duration: 2 },
  { id: "designateTorpedo",      cost: 20, label: "SHIPCOMBAT.Sensors.DesignateTorpedo",      desc: "SHIPCOMBAT.Sensors.DesignateTorpedoDesc",      targeted: false, duration: 0 },
];

// Core actions now use imported AUGUR_CORE_ACTIONS from constants.js

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _resolveSensorsActor(sheet) {
  const sys = sheet.actor.system;
  const ref = sys.crewActors?.sensors;
  if (ref?.uuid) {
    try { return await fromUuid(ref.uuid); } catch { /* ignore */ }
  }
  const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "sensors");
  if (entry) {
    const user = game.users.get(entry[0]);
    return user?.character ?? null;
  }
  return null;
}

/**
 * Spend AP from the Engineer's auxiliary power pool.
 * Returns true on success.
 */
function _spendAP(sys, cost) {
  const ap = sys.resources?.engineer?.auxiliaryPower ?? 0;
  if (ap < cost) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
    return false;
  }
  emitToGM("updateResource", { roleId: "engineer", key: "auxiliaryPower", value: ap - cost });
  return true;
}

/**
 * Apply Telemetry Buoy -20% AP discount (rounded up) when active.
 */
function _buoyDiscount(sys, baseCost) {
  if (baseCost <= 0) return 0;
  const hasBuoy = (sys.resources?.sensors?.payload ?? "") === "sensorBuoy";
  return hasBuoy ? Math.ceil(baseCost * 0.8) : baseCost;
}

function _getAuxPowerCapacity(shipActor) {
  const reactor = shipActor?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "reactor");
  return reactor?.system?.bankCapacity ?? 0;
}

// ── Action handlers (static, `this` = sheet instance) ────────────────────────

/**
 * Lock upgrade or utility action. Costs AP.
 * data-action-id identifies which action.
 * data-target-token-id identifies the blip target.
 */
async function _onSensorAction(event, target) {
  const sys      = this.actor.system;
  const actionId = target.dataset.actionId;

  // Try lock upgrades first
  const lockEntry = LOCK_ACTIONS.find(a => a.id === actionId);
  if (lockEntry) {
    const sensorPriorityActive = sys.resources?.sensors?.sensorPriorityActive ?? false;
    const baseCost = (sensorPriorityActive && lockEntry.setsTier <= 2) ? 0 : lockEntry.cost;
    const effectiveCost = _buoyDiscount(sys, baseCost);
    if (!_spendAP(sys, effectiveCost)) return;
    const targetTokenId = target.dataset.targetTokenId;
    if (!targetTokenId) return;
    emitToGM("updateResource", { roleId: "sensors", key: "actionUsed", value: true });
    emitToGM("upgradeLock", { targetTokenId, tier: lockEntry.setsTier });
    return;
  }

  // Utility actions
  const utilEntry = UTILITY_ACTIONS.find(a => a.id === actionId);
  if (utilEntry) {
    // designateTorpedo: use the clicked blip's token ID directly (no dialog)
    if (actionId === "designateTorpedo") {
      const tokenId = target.dataset.targetTokenId;
      if (!tokenId) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoDesignateTorpedoTargets"));
        return;
      }
      const ownTokenId = this.actor?.getActiveTokens?.()?.[0]?.id ?? null;
      const td = canvas?.scene?.tokens.get(tokenId);
      if (!td?.actor) return;
      const isAllied = ownTokenId && td.actor.system?.parentShipTokenId === ownTokenId;
      if (!_spendAP(sys, _buoyDiscount(sys, utilEntry.cost))) return;
      emitToGM("updateResource", { roleId: "sensors", key: "actionUsed", value: true });
      if (isAllied) {
        emitToGM("torpedoPowerBoost", { tokenId });
      } else {
        emitToGM("designateHostileTorpedo", { tokenId });
      }
      return;
    }

    if (!_spendAP(sys, _buoyDiscount(sys, utilEntry.cost))) return;
    emitToGM("updateResource", { roleId: "sensors", key: "actionUsed", value: true });
    const targetTokenId = target.dataset.targetTokenId;
    if (targetTokenId && utilEntry.targeted) {
      emitToGM("addSensorEffect", { actionId: utilEntry.id, targetTokenId, roundsRemaining: utilEntry.duration });
    } else if (!utilEntry.targeted) {
      emitToGM("addSensorEffect", { actionId: utilEntry.id, targetTokenId: "__self__", roundsRemaining: utilEntry.duration });
    }
    return;
  }
}

/**
 * Core action handler. Requires assigned Power Core + AP cost.
 * Uses AUGUR_CORE_ACTIONS from constants.js.
 */
async function _onSensorCoreAction(event, target) {
  const sys      = this.actor.system;
  const actionId = target.dataset.actionId;

  const hasCoreAvail = (sys.resources?.sensors?.coreCount ?? 0) > 0;
  if (!hasCoreAvail) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NeedsPowerCore"));
  }

  const entry = AUGUR_CORE_ACTIONS.find(a => a.id === actionId);
  if (!entry) return;

  // Spend AP cost (with Telemetry Buoy discount if active)
  if (!_spendAP(sys, _buoyDiscount(sys, entry.ap))) return;

  // Combat Telemetry: upgrade ALL currently locked targets to tier 4
  if (actionId === "combatTelemetry") {
    const locks = sys.resources?.sensors?.locks ?? [];
    for (const lock of locks) {
      if (lock.tier < 4) {
        emitToGM("upgradeLock", { targetTokenId: lock.targetTokenId, tier: 4 });
      }
    }
  }

  const played = [...(sys.resources?.sensors?.coreActionsPlayed ?? []), actionId];
  emitToGM("updateResource", { roleId: "sensors", key: "coreActionsPlayed", value: played });
  emitToGM("markOvercharge", { roleId: "sensors" });

  // Store targeted effect for radar visualisation
  const targetTokenId = target.dataset.targetTokenId;
  if (targetTokenId) {
    emitToGM("addSensorEffect", { actionId: entry.id, targetTokenId, roundsRemaining: entry.duration ?? 1 });
  }
}

/**
 * Open the BDA popup for the Augur.
 * The popup handles both the roll phase and the fire-correction selection.
 */
async function _onOpenBDAPopup(event, target) {
  const sys     = this.actor.system;
  const sensors = sys.resources?.sensors ?? {};

  // Corrections already ready (roll was done from chat card)  -  open corrections popup
  if (sensors.bdaCorrectionPending) {
    const targetTokenId = sensors.bdaTargetTokenId ?? null;
    const sl            = sensors.bdaResultSL ?? 0;
    const popup = new BDAPopup({ ship: this.actor, targetTokenId, sl });
    popup.render(true);
    return;
  }

  // BDA roll still needed  -  launch directly (no chat card to update from the Sensors tab)
  if (sensors.bdaAvailable) {
    await launchBDAFromChat(this.actor, null);
    return;
  }

  ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.BDANotAvailable"));
}

// ── Context builder ──────────────────────────────────────────────────────────

export function buildSensorsContext(sys, opts = {}) {
  const {
    sensorStats = { rating: 0, bandSize: 0, autoScanRange: 0 },
    reactorStats,
  } = opts;

  const ap           = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const actionUsed   = sys.resources?.sensors?.actionUsed ?? false;
  const coreUsed     = sys.resources?.sensors?.coreActionUsed ?? false;
  const coreCount    = sys.resources?.sensors?.coreCount ?? 0;
  const hasCoreAssigned = coreCount > 0;

  // ── Captain card: Sensor Priority ──────────────────────────────────────────
  const sensorPriorityActive = sys.resources?.sensors?.sensorPriorityActive ?? false;
  const SENSORS_BOOST_CARDS = ["enhancedSensor", "sensorPriority"];
  const _captainPlayedCardsSen = sys.resources?.captain?.playedCards ?? [];
  const captainBoosts = _captainPlayedCardsSen
    .filter(id => SENSORS_BOOST_CARDS.includes(id))
    .map(id => ({
      id,
      label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${id}`),
    }));
  const bdaAvailable       = sys.resources?.sensors?.bdaAvailable ?? false;
  const bdaCorrectionPending = sys.resources?.sensors?.bdaCorrectionPending ?? false;
  const bdaResultSL        = sys.resources?.sensors?.bdaResultSL ?? 0;
  const bdaTargetTokenId   = sys.resources?.sensors?.bdaTargetTokenId ?? null;
  const fireCorrection = sys.resources?.sensors?.fireCorrection ?? null;

  const apMax = reactorStats?.auxPowerCapacity ?? 0;
  const apPct = apMax > 0 ? Math.min(100, Math.round((ap / apMax) * 100)) : 0;

  // Build lock-action list with affordability + tier prereq status
  const lockActions = LOCK_ACTIONS.map(a => {
    const baseCost = (sensorPriorityActive && a.setsTier <= 2) ? 0 : a.cost;
    const effectiveCost = _buoyDiscount(sys, baseCost);
    return {
      ...a,
      cost:           effectiveCost,
      labelLocalized: game.i18n.localize(a.label),
      descLocalized:  game.i18n.localize(a.desc),
      tierClass:      `shipcombat-abl-icon--t${a.setsTier}`,
      decayRounds:    LOCK_DECAY_ROUNDS[a.setsTier] ?? 1,
      canAfford:      ap >= effectiveCost,
    };
  });

  const lockTier0 = {
    labelLocalized: game.i18n.localize("SHIPCOMBAT.Sensors.LockTier0"),
    descLocalized:  game.i18n.localize("SHIPCOMBAT.Sensors.LockTier0Desc"),
    tierClass:      "shipcombat-abl-icon--t0",
    cost:           0,
    decayRounds:    0,
  };

  // Build utility-action list
  const utilityActions = UTILITY_ACTIONS.map(a => {
    const effectiveCost = _buoyDiscount(sys, a.cost);
    return {
      ...a,
      cost:           effectiveCost,
      labelLocalized: game.i18n.localize(a.label),
      descLocalized:  game.i18n.localize(a.desc),
      canAfford:      ap >= effectiveCost,
    };
  }).sort((a, b) => a.cost - b.cost);

  const coreActions = AUGUR_CORE_ACTIONS.map(a => {
    const effectiveCost = _buoyDiscount(sys, a.ap);
    return {
      ...a,
      labelLocalized: game.i18n.localize(a.label),
      descLocalized:  game.i18n.localize(a.desc),
      cost:           effectiveCost,
      canAfford:      ap >= effectiveCost && coreCount > 0,
    };
  }).sort((a, b) => a.cost - b.cost);

  // Played core actions this turn (for banner display)
  const coreActionsPlayed = sys.resources?.sensors?.coreActionsPlayed ?? [];
  const coreActionsPlayedLabels = coreActionsPlayed.map(id => {
    const entry = AUGUR_CORE_ACTIONS.find(a => a.id === id);
    return entry ? game.i18n.localize(entry.label) : id;
  });

  // BDA corrections for the UI
  const corrections = BDA_CORRECTIONS.map(c => ({
    ...c,
    labelLocalized: game.i18n.localize(c.label),
    descLocalized:  game.i18n.localize(c.desc),
  }));

  // Lock state (for the radar & popup)
  const locks = sys.resources?.sensors?.locks ?? [];

  // ── Sensor Blind condition: weaponsSensors Medium+ blocks L2+ lock upgrades ──
  const weaponsSensorsTier = sys.conditions?.weaponsSensors?.tier;
  const sensorBlind = weaponsSensorsTier === "medium" || weaponsSensorsTier === "high";

  // Mark lock actions unavailable when Sensor Blind is active
  const lockActionsEffective = lockActions.map(a => ({
    ...a,
    disabled:    sensorBlind && a.setsTier >= 2,
    disabledReason: sensorBlind && a.setsTier >= 2 ? game.i18n.localize("SHIPCOMBAT.Crit.SensorBlindDisabled") : null,
  }));

  return {
    ap,
    apMax:       apMax,
    apPct,
    data:        ap,
    dataMax:     apMax,
    dataPct:     apPct,
    power:       ap,
    powerMax:    apMax,
    powerPct:    apPct,
    actionUsed,
    coreUsed,
    hasCoreAssigned,
    hasCaptainFreeCore: false,
    coreActionsPlayedLabels,
    bdaAvailable,
    bdaCorrectionPending,
    bdaResultSL,
    bdaTargetTokenId,
    fireCorrection,
    corrections,
    lockTier0,
    lockActions:     lockActionsEffective,
    utilityActions,
    coreActions,
    locks,
    sensorBlind,
    sensorPriorityActive,
    captainBoosts,
    // NPC conditions: visible when Sensors holds an active L3+ lock on that token
    npcConditions: _buildNpcConditions(locks),
    sensorStats,
    isTrueBearing: SensorRadar.isTrueBearing,
    radarScale: SensorRadar.radarScale || sensorStats.maxRange || 30,
    maxScanRange: sensorStats.maxRange || 30,
  };
}

const _NPC_CRIT_LOCS = ["hull", "engines", "manoeuvring", "coreSystems", "weaponsSensors"];

/**
 * Build an array of NPC intel entries for any locked target with tier >= 3.
 * The Sensors operator can see enemy ship condition panels through a Deep Scan+ lock.
 * @param {Array} locks  - Populated lock entries from sensors.resources
 * @returns {Array}      - [{ tokenName, conditionsList }]
 */
function _buildNpcConditions(locks) {
  const result = [];
  if (!Array.isArray(locks)) return result;
  for (const lock of locks) {
    if ((lock.tier ?? 0) < 3) continue;
    const tokenDoc = canvas?.tokens?.get(lock.targetTokenId)?.document;
    const actor    = tokenDoc?.actor;
    if (!actor) continue;
    if (actor.type !== `${MODULE_ID}.npcShip`) continue;
    const rawConds = actor.system?.conditions ?? {};
    const conditionsList = _NPC_CRIT_LOCS
      .map(locId => {
        const cond = rawConds[locId] ?? {};
        const tier = cond.tier ?? null;
        return {
          locId,
          tier,
          hasCondition: !!tier,
          locLabel:     game.i18n.localize(`SHIPCOMBAT.Crit.Location.${locId}`),
          conditionName:   tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Condition.${locId}.${tier}`) : "",
          conditionEffect: tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Effect.${locId}.${tier}`) : "",
          tierLabel:    tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Tier.${tier.charAt(0).toUpperCase() + tier.slice(1)}`) : "",
          tierClass:    tier ? `shipcombat-crit-tier--${tier}` : "",
        };
      })
      .filter(c => c.hasCondition);
    result.push({
      npcName: tokenDoc.name ?? "Unknown",
      conditionsList,
    });
  }
  return result;
}

function _onToggleBearing() {
  SensorRadar.toggleBearing();
  this.render();
}

function _onPopOutRadar() {
  SensorRadar.popOut(this);
}


// ── Exports ──────────────────────────────────────────────────────────────────

export const SENSORS_ACTIONS = {
  sensorAction:       _onSensorAction,
  sensorCoreAction:   _onSensorCoreAction,
  toggleBearing:      _onToggleBearing,
  popOutRadar:        _onPopOutRadar,
  openBDAPopup:       _onOpenBDAPopup,
};
