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
 *   4  -  Targeting Solution (15 AP)  -  fixed hit bonus, negates Zone 3 penalty
 *
 * Locks are consumed when the Gunner fires at a locked target (drops to 0).
 * After fire, BDA becomes available  -  the Augur rolls to retain partial lock.
 *
 * BDA (Battle Damage Assessment):
 *   After a Gunner fires at a locked target, Augur rolls Sensors:
 *     SL 0+ = reveal damage card.  SL 2+ = retain Tier 1.
 *     SL 4+ = Tier 2.  SL 6+ = Tier 3.  SL 8+ = Tier 4.
 *   Then choose one Fire Correction:
 *     - Adjust Bearing: fixed hit bonus on next attack (same weapon, same target)
 *     - Target Weak Point: +SL to AP on next attack
 *     - Fire for Effect: crit threshold reduced by SL on next attack
 *     - Break Off, Reallocate: grants 20% max AP; gunner may retarget next turn
 *
 * Focused Scan: free once/turn, roll Sensors → success returns +SL AP.
 *
 * Core Actions (require Power Core + AP):
 *   Combat Telemetry (12 AP)  -  all locked targets → Lock 4
 *   Sensor Overcharge (10 AP)  -  restrict target weapons to auto-scan range
 *   Signal Inversion (10 AP)  -  strip shields from nearest quadrant
 *   Sensor Surge (8 AP)  -  BDA +30; fire correction applies to ALL weapons
 *   Deep Revelation (15 AP)  -  reveal ALL target stats permanently
 */
import { createActionRequester } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { LOCK_DECAY_ROUNDS, AUGUR_LOCK_ACTIONS, AUGUR_UTILITY_ACTIONS, AUGUR_CORE_ACTIONS, BDA_CORRECTIONS, MODULE_ID } from "../constants.js";
import { SensorRadar } from "../canvas/SensorRadar.js";
import { BDAPopup, launchBDAFromChat } from "../apps/BDAPopup.js";
import { getPowerCoreCount } from "./crew-operators.js";

const requestGM = createActionRequester(context => context.actor);

// ── Constants ────────────────────────────────────────────────────────────────

// Lock-upgrade actions  -  each advances one lock tier on a target. Costs AP.
const LOCK_ACTIONS = AUGUR_LOCK_ACTIONS;

// Non-lock utility actions  -  also cost AP now.
const UTILITY_ACTIONS = AUGUR_UTILITY_ACTIONS;

// Core actions now use imported AUGUR_CORE_ACTIONS from constants.js

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Apply Telemetry Buoy -20% AP discount (rounded up) when active.
 */
function _buoyDiscount(sys, baseCost) {
  if (baseCost <= 0) return 0;
  const hasBuoy = (sys.resources?.sensors?.payload ?? "") === "sensorBuoy";
  return hasBuoy ? Math.ceil(baseCost * 0.8) : baseCost;
}

function _getSensorApCostMultiplier(shipActor) {
  const sensor = shipActor?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "sensor" && i.system.equipped !== false);
  return sensor?.system?.apCostMultiplier ?? 1;
}

/**
 * Calculate a lock action's final AP cost. The sensor component modifies the
 * base cost first; Sensor Priority then halves Lock 1/2 upgrades, rounding up.
 * Telemetry Buoy remains the final discount in the existing cost pipeline.
 */
function _lockActionApCost(sys, lockEntry, apCostMultiplier) {
  let adjustedCost = lockEntry.cost * apCostMultiplier;
  const sensorPriorityActive = sys.resources?.sensors?.sensorPriorityActive ?? false;
  if (sensorPriorityActive && lockEntry.setsTier <= 2) adjustedCost *= 0.5;
  return _buoyDiscount(sys, Math.ceil(adjustedCost));
}

// ── Action handlers (static, `this` = sheet instance) ────────────────────────

/**
 * Lock upgrade or utility action. Costs AP.
 * data-action-id identifies which action.
 * data-target-token-id identifies the blip target.
 */
async function _onSensorAction(event, target) {
  const actionId = target.dataset.actionId;
  const lockEntry = LOCK_ACTIONS.find(a => a.id === actionId);
  const utilEntry = UTILITY_ACTIONS.find(a => a.id === actionId);
  if (!lockEntry && !utilEntry) return;

  const targetTokenId = target.dataset.targetTokenId ?? null;
  if ((lockEntry || utilEntry?.targeted) && (!targetTokenId || !canvas?.tokens?.get(targetTokenId))) {
    if (actionId === "designateTorpedo") {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoDesignateTorpedoTargets"));
    }
    return;
  }

  const result = await requestGM(this, "executeSensorAction", {
    actionId,
    targetTokenId,
  });
  if (result?.ok) return;
  if (result?.reason === "insufficientAP") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
  } else if (result?.reason === "sensorBlind") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Crit.SensorBlindDisabled"));
  } else if (result?.reason === "noLock") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Sensors.RequiresLock"));
  } else if (result?.reason === "rollbackFailed") {
    ui.notifications.error(game.i18n.localize("SHIPCOMBAT.Sensors.ActionRefundFailed"));
  } else {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Sensors.ActionFailed"));
  }
}

/**
 * Core action handler. Requires assigned Power Core + AP cost.
 * Uses AUGUR_CORE_ACTIONS from constants.js.
 */
async function _onSensorCoreAction(event, target) {
  const sys      = SystemAdapter.current.getShipData(this.actor);
  const actionId = target.dataset.actionId;

  const hasCoreAvail = getPowerCoreCount(sys, "sensors") > 0;
  if (!hasCoreAvail) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NeedsPowerCore"));
  }

  const entry = AUGUR_CORE_ACTIONS.find(a => a.id === actionId);
  if (!entry) return;
  const targetTokenId = target.dataset.targetTokenId;
  if (entry.targeted && (!targetTokenId || !canvas?.tokens?.get(targetTokenId))) return;

  // Validate AP before reserving the shared operator core. The GM-side core
  // reservation is serialized, so only its successful caller applies effects.
  const apCostMultiplier = _getSensorApCostMultiplier(this.actor);
  const apCost = _buoyDiscount(sys, Math.ceil(entry.ap * apCostMultiplier));
  if ((sys.resources?.engineer?.auxiliaryPower ?? 0) < apCost) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
    return;
  }
  if (actionId === "combatTelemetry") {
    const sensorCondition = sys.conditions?.weaponsSensors?.tier;
    if (sensorCondition === "medium" || sensorCondition === "high") {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Crit.SensorBlindDisabled"));
      return;
    }
  }

  const result = await requestGM(this, "executeSensorCoreAction", {
    actionId,
    targetTokenId,
  });
  if (result?.ok) {
    if (result.warning === "effectMarkerFailed") {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Sensors.CoreMarkerFailed"));
    }
    return;
  }

  if (result?.reason === "insufficientAP") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
  } else if (result?.reason === "noPowerCore") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NeedsPowerCore"));
  } else if (result?.reason === "sensorBlind") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Crit.SensorBlindDisabled"));
  } else if (result?.reason === "noLock") {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Sensors.RequiresLock"));
  } else if (result?.reason === "rollbackFailed") {
    ui.notifications.error(game.i18n.localize("SHIPCOMBAT.Sensors.CoreRollbackFailed"));
  } else {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Sensors.CoreActionFailed"));
  }
}

/** Share one non-mechanical target recommendation with the whole crew. */
async function _onRecommendTarget(event, target) {
  const targetTokenId = target.dataset.targetTokenId;
  if (!targetTokenId) return;
  await requestGM(this, "setRecommendedTarget", { targetTokenId });
}

/**
 * Open the BDA popup for the Augur.
 * The popup handles both the roll phase and the fire-correction selection.
 */
async function _onOpenBDAPopup(event, target) {
  const sys     = SystemAdapter.current.getShipData(this.actor);
  const sensors = sys.resources?.sensors ?? {};
  const attacks = Object.values(sensors.bdaAttacks ?? {})
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const correction = attacks.find(attack => attack.status === "correction") ?? null;
  const pending = attacks.find(attack => attack.status === "pending") ?? null;

  // Corrections already ready (roll was done from chat card)  -  open corrections popup
  if (correction) {
    const popup = new BDAPopup({
      ship: this.actor,
      attackId: correction.attackId,
      targetTokenId: correction.targetTokenId ?? null,
      sl: correction.sl ?? 0,
      messageId: correction.messageId ?? null,
      targetName: correction.targetName ?? null,
      originalLockTier: correction.originalLockTier ?? 4,
    });
    popup.render(true);
    return;
  }

  // BDA roll still needed  -  launch directly (no chat card to update from the Sensors tab)
  if (pending) {
    const message = pending.messageId ? game.messages.get(pending.messageId) ?? null : null;
    await launchBDAFromChat(this.actor, message, pending.attackId);
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
  const coreCount    = getPowerCoreCount(sys, "sensors");
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
  const bdaAttacks = Object.values(sys.resources?.sensors?.bdaAttacks ?? {})
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const bdaCorrection = bdaAttacks.find(attack => attack.status === "correction") ?? null;
  const bdaPending = bdaAttacks.find(attack => attack.status === "pending") ?? null;
  const activeBda = bdaCorrection ?? bdaPending;
  const bdaAvailable = bdaPending !== null;
  const bdaCorrectionPending = bdaCorrection !== null;
  const bdaResultSL = bdaCorrection?.sl ?? 0;
  const bdaTargetTokenId = activeBda?.targetTokenId ?? null;
  const fireCorrection = sys.resources?.sensors?.fireCorrection ?? null;

  const apMax = reactorStats?.auxPowerCapacity ?? 0;
  const apPct = apMax > 0 ? Math.min(100, Math.round((ap / apMax) * 100)) : 0;

  // Build lock-action list with affordability + tier prereq status
  const apCostMultiplier = sensorStats.apCostMultiplier ?? 1;
  const lockActions = LOCK_ACTIONS.map(a => {
    const effectiveCost = _lockActionApCost(sys, a, apCostMultiplier);
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
    const effectiveCost = _buoyDiscount(sys, Math.ceil(a.cost * apCostMultiplier));
    return {
      ...a,
      cost:           effectiveCost,
      labelLocalized: game.i18n.localize(a.label),
      descLocalized:  game.i18n.localize(a.desc),
      canAfford:      ap >= effectiveCost,
    };
  }).sort((a, b) => a.cost - b.cost);

  const coreActions = AUGUR_CORE_ACTIONS.map(a => {
    const effectiveCost = _buoyDiscount(sys, Math.ceil(a.ap * apCostMultiplier));
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
    bdaSlBadge: SystemAdapter.current.formatBdaBadge(bdaResultSL),
    bdaTargetTokenId,
    bdaPendingCount: bdaAttacks.length,
    fireCorrection,
    corrections,
    lockTier0,
    lockActions:     lockActionsEffective,
    utilityActions,
    coreActions,
    locks,
    sensorBlind,
    sensorPriorityActive,
    recommendedTargetId: sys.resources?.sensors?.recommendedTargetId ?? null,
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
    const rawConds = SystemAdapter.current.getShipData(actor)?.conditions ?? {};
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
          conditionEffect: tier ? game.i18n.localize(`SHIPCOMBAT.Crit.${locId === "coreSystems" ? "NpcEffect" : "Effect"}.${locId}.${tier}`) : "",
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
  recommendTarget:    _onRecommendTarget,
  toggleBearing:      _onToggleBearing,
  popOutRadar:        _onPopOutRadar,
  openBDAPopup:       _onOpenBDAPopup,
};
