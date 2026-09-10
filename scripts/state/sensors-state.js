/**
 * sensors-state.js – Sensor locks and effects extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID, CORE_MODULE_ID, LOCK_DECAY_ROUNDS, AUGUR_LOCK_ACTIONS, AUGUR_UTILITY_ACTIONS, AUGUR_CORE_ACTIONS, BDA_CORRECTIONS } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getPowerCoreCount, getPowerCorePoolRole } from "../roles/crew-operators.js";
import {
  ensureContactRecord,
  getContactDisplayName,
  isFriendlyContactToken,
  isMarkableContactToken,
  isTargetableContactToken,
} from "../targeting/contact-intelligence.js";
import { buildTargetReferenceCleanup, collectTargetReferenceIds } from "./target-references.js";

function _targetName(targetTokenId) {
  return canvas?.tokens?.get(targetTokenId)?.document?.name ?? null;
}

function _sensorBlindBlocksTier(data, tier) {
  const conditionTier = data.conditions?.weaponsSensors?.tier;
  return (conditionTier === "medium" || conditionTier === "high") && Number(tier) >= 2;
}

function _warnSensorBlind() {
  ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Crit.SensorBlindDisabled"));
}

async function _updateBDAChatMessage(attack, messageId, content) {
  if (!messageId || typeof content !== "string") return;
  if (attack.messageId && messageId !== attack.messageId) return;

  const message = game.messages.get(messageId);
  const flags = message?.flags?.[MODULE_ID];
  if (flags?.type !== "bdaPending"
    || flags.attackId !== attack.attackId
    || flags.attackCreatedAt !== attack.createdAt
    || flags.shipUuid !== attack.shipUuid) return;

  await message.update({ content });
}

function _contactUpdates(data, targets) {
  let sensors = {
    ...(data.resources?.sensors ?? {}),
    contacts: foundry.utils.deepClone(data.resources?.sensors?.contacts ?? {}),
  };

  for (const { targetTokenId, tier = 0 } of targets) {
    const workingData = {
      ...data,
      resources: { ...(data.resources ?? {}), sensors },
    };
    const ensured = ensureContactRecord(workingData, targetTokenId, {
      tier,
      realName: _targetName(targetTokenId),
    });
    sensors = {
      ...sensors,
      contacts: ensured.contacts,
      nextContactOrdinal: ensured.nextContactOrdinal,
    };
  }

  return {
    "resources.sensors.contacts": sensors.contacts,
    "resources.sensors.nextContactOrdinal": sensors.nextContactOrdinal ?? 1,
  };
}

/**
 * Add a sensor effect targeting an enemy token.
 */
export async function addSensorEffect({ actionId, targetTokenId, roundsRemaining = 1 }) {
  if (!actionId || !targetTokenId) return false;
  if (targetTokenId !== "__self__" && !canvas?.tokens?.get(targetTokenId)) return false;
  const data = this.getData();
  const effects = [...(data.resources?.sensors?.effects ?? [])];
  effects.push({ actionId, targetTokenId, roundsRemaining });
  return this.update({ "resources.sensors.effects": effects });
}

/**
 * True if the given actor's active token is currently under the named sensor
 * effect (registered on the player ship's combat state by its Sensors Officer).
 * The player ship's own effects only ever target enemy tokens, so this is
 * always false for the player ship itself.
 */
export function hasSensorEffectOn(actor, actionId) {
  const tokenId = actor?.getActiveTokens?.()?.[0]?.id ?? null;
  if (!tokenId) return false;
  const effects = this.getData?.()?.resources?.sensors?.effects ?? [];
  return effects.some(e => e.actionId === actionId && e.targetTokenId === tokenId);
}

/**
 * Sensor Disruption penalty for the given actor's rolls.  The magnitude is
 * adapter-defined (getSensorDisruptionPenalty): d20 systems use the disrupting
 * (player) ship's sensor Hit Modifier with a one-band minimum; roll-under
 * systems use one range band.  Returns 0 when the actor is not disrupted.
 * Returned as a positive number; callers subtract it.
 */
export function getDisruptionPenalty(actor) {
  if (!this.hasSensorEffectOn(actor, "sensorDisruption")) return 0;
  const rating = this.getSensorStats?.()?.rating ?? 0;
  return SystemAdapter.current.getSensorDisruptionPenalty(rating);
}

/**
 * Signal Inversion (sensors core action): strip all shields from the target's
 * quadrant closest to the player ship.  GM-side.
 */
export async function stripQuadrantShields({ targetTokenId }) {
  if (!game.user.isGM || !canvas?.scene) return false;
  const targetToken = canvas.tokens.placeables.find(t => t.id === targetTokenId);
  const targetActor = targetToken?.document?.actor ?? targetToken?.actor;
  if (!targetToken || !targetActor) return false;

  const shipToken = this.ship?.getActiveTokens?.()?.[0];
  if (!shipToken) return false;

  const gs = canvas.grid.size;
  const sx = shipToken.x   + (shipToken.document.width    * gs) / 2;
  const sy = shipToken.y   + (shipToken.document.height   * gs) / 2;
  const tx = targetToken.x + (targetToken.document.width  * gs) / 2;
  const ty = targetToken.y + (targetToken.document.height * gs) / 2;

  // Quadrant of the TARGET facing the player ship (same math as getHitQuadrant,
  // inlined to avoid an import cycle with apps/TargetingPopup.js)
  const attackAngle   = Math.atan2(ty - sy, tx - sx);
  const targetHeading = ((targetToken.document.rotation ?? 0) + 90) * (Math.PI / 180);
  let incoming = attackAngle - targetHeading + Math.PI;
  while (incoming >  Math.PI) incoming -= 2 * Math.PI;
  while (incoming < -Math.PI) incoming += 2 * Math.PI;
  const deg = incoming * (180 / Math.PI);
  const quadrant =
      (deg >= -45  && deg < 45)  ? "bow"
    : (deg >= 45   && deg < 135) ? "starboard"
    : (deg >= -135 && deg < -45) ? "port"
    : "stern";

  const current = targetActor.system?.shields?.[quadrant] ?? 0;
  if (current > 0) {
    await targetActor.update({ [SystemAdapter.current.systemPath(`shields.${quadrant}`)]: 0 });
  }

  const quadrantLabel = game.i18n.localize(
    `SHIPCOMBAT.Sector.${quadrant.charAt(0).toUpperCase() + quadrant.slice(1)}`
  );
  const targetName = getContactDisplayName(this.getData(), targetTokenId, {
    currentTier: this.getEffectiveLockTier(targetTokenId, Math.hypot(tx - sx, ty - sy) / gs),
    realName: targetToken.document.name ?? "Unknown",
  });
  try {
    await ChatMessage.create({
      flavor:  game.i18n.localize("SHIPCOMBAT.Sensors.SignalInversion"),
      content: `<p><b>${targetName}</b>: ${quadrantLabel} shields stripped (${current} → 0).</p>`,
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Signal Inversion chat message failed`, error);
  }
  return true;
}

export function hasEffectiveLock({ belowTier = Infinity } = {}) {
  const ship = this.ship;
  if (!ship) return false;
  return (canvas?.tokens?.placeables ?? []).some(target => {
    if (!isTargetableContactToken(target, ship, { requireVisible: false })) return false;
    const tier = this.getEffectiveLockTier(target.id, _distanceSquaresToTarget(target.id, ship));
    return tier >= 1 && tier < belowTier;
  });
}

/** Reserve a normal Sensors action and resolve its effect under one ship queue. */
export async function executeSensorAction({ actionId, targetTokenId = null } = {}) {
  if (!game.user.isGM) return { ok: false, reason: "notGM" };
  const ship = this.ship;
  const lockEntry = AUGUR_LOCK_ACTIONS.find(action => action.id === actionId);
  const utilityEntry = AUGUR_UTILITY_ACTIONS.find(action => action.id === actionId);
  const entry = lockEntry ?? utilityEntry;
  if (!ship || !entry) return { ok: false, reason: "invalidAction" };

  return this.withAllocationTransaction(async () => {
    const data = this.getData(ship) ?? {};
    const priorActionUsed = data.resources?.sensors?.actionUsed ?? false;

    const targetToken = targetTokenId ? canvas?.tokens?.get(targetTokenId) : null;
    if (lockEntry || utilityEntry.targeted) {
      if (!targetToken) return { ok: false, reason: "invalidTarget" };
      if (actionId !== "designateTorpedo"
        && !isTargetableContactToken(targetToken, ship, { requireVisible: false })) {
        return { ok: false, reason: "invalidTarget" };
      }
    }

    if (lockEntry) {
      if (_sensorBlindBlocksTier(data, lockEntry.setsTier)) {
        return { ok: false, reason: "sensorBlind" };
      }
      const currentTier = this.getEffectiveLockTier(
        targetTokenId,
        _distanceSquaresToTarget(targetTokenId, ship),
      );
      if (currentTier < lockEntry.requiresTier) return { ok: false, reason: "noLock" };
      if (currentTier >= lockEntry.setsTier) return { ok: false, reason: "noChange" };
    } else if (utilityEntry.requiresTier) {
      const currentTier = this.getEffectiveLockTier(
        targetTokenId,
        _distanceSquaresToTarget(targetTokenId, ship),
      );
      if (currentTier < utilityEntry.requiresTier) return { ok: false, reason: "noLock" };
    } else if (utilityEntry.requiresAnyLock && !this.hasEffectiveLock()) {
      return { ok: false, reason: "noLock" };
    }

    const apMultiplier = this.getSensorStats(ship)?.apCostMultiplier ?? 1;
    let baseCost = entry.cost * apMultiplier;
    if (lockEntry && (data.resources?.sensors?.sensorPriorityActive ?? false) && lockEntry.setsTier <= 2) {
      baseCost *= 0.5;
    }
    const roundedCost = Math.ceil(baseCost);
    const apCost = (data.resources?.sensors?.payload ?? "") === "sensorBuoy"
      ? Math.ceil(roundedCost * 0.8)
      : roundedCost;
    const auxiliaryPower = data.resources?.engineer?.auxiliaryPower ?? 0;
    if (auxiliaryPower < apCost) {
      return { ok: false, reason: "insufficientAP", apCost, auxiliaryPower };
    }

    try {
      await this.update({
        "resources.engineer.auxiliaryPower": auxiliaryPower - apCost,
        "resources.sensors.actionUsed": true,
      }, ship);
    } catch (error) {
      console.error(`${MODULE_ID} | Sensors action reservation failed`, error);
      return { ok: false, reason: "reservationFailed" };
    }

    try {
      let effectResult;
      if (lockEntry) {
        effectResult = await this.upgradeLock({ targetTokenId, tier: lockEntry.setsTier });
      } else if (actionId === "designateTorpedo") {
        const parentShipTokenId = SystemAdapter.current.getShipData(targetToken.actor)?.parentShipTokenId;
        const ownTokenIds = new Set((ship.getActiveTokens?.() ?? []).map(token => token.id));
        effectResult = ownTokenIds.has(parentShipTokenId)
          ? await this.torpedoPowerBoost(targetTokenId)
          : await this.designateHostileTorpedo(targetTokenId);
      } else {
        effectResult = await this.addSensorEffect({
          actionId,
          targetTokenId: utilityEntry.targeted ? targetTokenId : "__self__",
          roundsRemaining: utilityEntry.duration,
        });
      }
      if (!effectResult) throw new Error("Sensors effect was rejected");
    } catch (error) {
      console.error(`${MODULE_ID} | Sensors action failed; rolling back reservation`, error);
      try {
        await this.update({
          "resources.engineer.auxiliaryPower": auxiliaryPower,
          "resources.sensors.actionUsed": priorActionUsed,
        }, ship);
        return { ok: false, reason: "effectFailed", rolledBack: true };
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Sensors action rollback failed`, rollbackError);
        return { ok: false, reason: "rollbackFailed", rolledBack: false };
      }
    }

    return { ok: true, apCost };
  }, ship);
}

/**
 * Reserve a Sensors Power Core and Auxiliary Power together, then resolve the
 * action's primary effect before releasing either ship-level mutation queue.
 */
export async function executeSensorCoreAction({ actionId, targetTokenId = null } = {}) {
  if (!game.user.isGM) return { ok: false, reason: "notGM" };
  const ship = this.ship;
  const entry = AUGUR_CORE_ACTIONS.find(action => action.id === actionId);
  if (!ship || !entry) return { ok: false, reason: "invalidAction" };

  // Keep the same allocation → Power Core lock order used by Captain card
  // grants so concurrent station actions cannot deadlock each other.
  return this.withAllocationTransaction(
    () => this.withPowerCoreTransaction(async () => {
      const data = this.getData(ship) ?? {};
      if (entry.targeted) {
        const targetToken = targetTokenId ? canvas?.tokens?.get(targetTokenId) : null;
        const targetDistance = _distanceSquaresToTarget(targetTokenId, ship);
        if (!targetToken
          || !isTargetableContactToken(targetToken, ship, { requireVisible: false })
          || this.getEffectiveLockTier(targetTokenId, targetDistance) < 1) {
          return { ok: false, reason: "invalidTarget" };
        }
      }
      if (actionId === "combatTelemetry" && _sensorBlindBlocksTier(data, 4)) {
        return { ok: false, reason: "sensorBlind" };
      }
      if (actionId === "combatTelemetry") {
        if (!this.hasEffectiveLock({ belowTier: 4 })) return { ok: false, reason: "noLock" };
      }

      const apMultiplier = this.getSensorStats(ship)?.apCostMultiplier ?? 1;
      const baseApCost = Math.ceil(entry.ap * apMultiplier);
      const hasBuoy = (data.resources?.sensors?.payload ?? "") === "sensorBuoy";
      const apCost = hasBuoy ? Math.ceil(baseApCost * 0.8) : baseApCost;
      const auxiliaryPower = data.resources?.engineer?.auxiliaryPower ?? 0;
      if (auxiliaryPower < apCost) {
        return { ok: false, reason: "insufficientAP", apCost, auxiliaryPower };
      }

      const coreCount = getPowerCoreCount(data, "sensors");
      if (coreCount <= 0) return { ok: false, reason: "noPowerCore" };
      const corePoolRole = getPowerCorePoolRole(data, "sensors");
      const priorActions = [...(data.resources?.sensors?.coreActionsPlayed ?? [])];

      try {
        await this.update({
          [`resources.${corePoolRole}.coreCount`]: coreCount - 1,
          "resources.engineer.auxiliaryPower": auxiliaryPower - apCost,
          "resources.sensors.coreActionsPlayed": [...priorActions, actionId],
        }, ship);
      } catch (error) {
        console.error(`${MODULE_ID} | Sensors Core reservation failed`, error);
        return { ok: false, reason: "reservationFailed" };
      }

      try {
        const targetActor = targetTokenId
          ? canvas?.tokens?.get(targetTokenId)?.document?.actor ?? null
          : null;
        const effectResult = actionId === "combatTelemetry"
          ? await this.upgradeAllLocks({ tier: 4 })
          : await this.withActorActionTransaction(
              targetActor,
              () => this.stripQuadrantShields({ targetTokenId }),
            );
        if (!effectResult) throw new Error("Primary Sensors Core effect was rejected");
      } catch (error) {
        console.error(`${MODULE_ID} | Sensors Core effect failed; rolling back reservation`, error);
        try {
          await this.update({
            [`resources.${corePoolRole}.coreCount`]: coreCount,
            "resources.engineer.auxiliaryPower": auxiliaryPower,
            "resources.sensors.coreActionsPlayed": priorActions,
          }, ship);
          return { ok: false, reason: "effectFailed", rolledBack: true };
        } catch (rollbackError) {
          console.error(`${MODULE_ID} | Sensors Core reservation rollback failed`, rollbackError);
          return { ok: false, reason: "rollbackFailed", rolledBack: false };
        }
      }

      if (targetTokenId) {
        try {
          const effectStored = await this.addSensorEffect({
            actionId,
            targetTokenId,
            roundsRemaining: entry.duration ?? 1,
          });
          if (effectStored === false) throw new Error("Sensors Core visualization effect was rejected");
        } catch (error) {
          // Signal Inversion's shield removal is the primary mechanical effect;
          // a failed source-ship marker must not refund an already-applied hit.
          console.error(`${MODULE_ID} | Sensors Core effect marker failed`, error);
          return { ok: true, apCost, warning: "effectMarkerFailed" };
        }
      }

      return { ok: true, apCost };
    }, ship),
    ship,
  );
}

/**
 * Upgrade (or create) a sensor lock on a target token.
 * tier  -  the new lock tier (1-4).
 */
export async function upgradeLock({ targetTokenId, tier }) {
  if (!targetTokenId || !canvas?.tokens?.get(targetTokenId)) return false;
  const data = this.getData();
  if (_sensorBlindBlocksTier(data, tier)) {
    _warnSensorBlind();
    return false;
  }
  const locks = [...(data.resources?.sensors?.locks ?? [])];
  const idx   = locks.findIndex(l => l.targetTokenId === targetTokenId);
  const decay = LOCK_DECAY_ROUNDS[tier] ?? 1;

  if (idx >= 0) {
    locks[idx] = { ...locks[idx], tier, decayRounds: decay };
  } else {
    locks.push({ targetTokenId, tier, decayRounds: decay });
  }
  return this.update({
    "resources.sensors.locks": locks,
    ..._contactUpdates(data, [{ targetTokenId, tier }]),
  });
}

/** Upgrade every explicit or auto-scan lock in one actor update. */
export async function upgradeAllLocks({ tier }) {
  const targetTier = Math.max(1, Math.min(4, Number(tier) || 1));
  const data = this.getData();
  if (_sensorBlindBlocksTier(data, targetTier)) {
    _warnSensorBlind();
    return false;
  }
  const locks = data.resources?.sensors?.locks ?? [];
  const decay = LOCK_DECAY_ROUNDS[targetTier] ?? 1;
  const locksByTarget = new Map(locks.map(lock => [lock.targetTokenId, lock]));

  const scanRange = this.getSensorStats?.()?.autoScanRange ?? 0;
  if (scanRange > 0) {
    for (const target of canvas?.tokens?.placeables ?? []) {
      if (!isTargetableContactToken(target, this.ship, { requireVisible: false })) continue;
      if (_distanceSquaresToTarget(target.id, this.ship) > scanRange) continue;
      if (!locksByTarget.has(target.id)) {
        locksByTarget.set(target.id, { targetTokenId: target.id, tier: 2, decayRounds: 0 });
      }
    }
  }

  let changed = locksByTarget.size !== locks.length;
  const upgradedLocks = [...locksByTarget.values()].map(lock => {
    if ((lock.tier ?? 0) >= targetTier) return lock;
    changed = true;
    return { ...lock, tier: targetTier, decayRounds: decay };
  });

  if (!changed) return;
  return this.update({
    "resources.sensors.locks": upgradedLocks,
    ..._contactUpdates(data, upgradedLocks.map(lock => ({
      targetTokenId: lock.targetTokenId,
      tier: lock.tier ?? targetTier,
    }))),
  });
}

/** Persist stable designations for newly detected contacts in one update. */
export async function registerSensorContacts({ targetTokenIds = [] } = {}) {
  const data = this.getData();
  const contacts = data.resources?.sensors?.contacts ?? {};
  const missingIds = [...new Set(targetTokenIds)]
    .filter(targetTokenId => targetTokenId && canvas?.tokens?.get(targetTokenId) && !contacts[targetTokenId])
    .sort();
  const detected = missingIds.map(targetTokenId => ({
    targetTokenId,
    tier: this.getEffectiveLockTier(
      targetTokenId,
      _distanceSquaresToTarget(targetTokenId, this.ship),
    ),
  })).filter(contact => contact.tier >= 1);
  if (detected.length === 0) return false;

  return this.update(_contactUpdates(data, detected));
}

function _distanceSquaresToTarget(targetTokenId, ship) {
  const target = canvas?.tokens?.get(targetTokenId);
  const own = ship?.getActiveTokens?.()?.[0];
  if (!target || !own || !canvas?.grid?.size) return Infinity;
  const gs = canvas.grid.size;
  const tx = target.x + (target.document.width * gs) / 2;
  const ty = target.y + (target.document.height * gs) / 2;
  const sx = own.x + (own.document.width * gs) / 2;
  const sy = own.y + (own.document.height * gs) / 2;
  return Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2) / gs;
}

/** Toggle the Sensors Officer's non-mechanical crew recommendation. */
export async function setRecommendedTarget({ targetTokenId } = {}) {
  const data = this.getData();
  const current = data.resources?.sensors?.recommendedTargetId ?? null;
  if (!targetTokenId || current === targetTokenId) {
    return this.update({ "resources.sensors.recommendedTargetId": null });
  }

  const target = canvas?.tokens?.get(targetTokenId);
  if (!isMarkableContactToken(target, this.ship)) return false;

  const tier = isFriendlyContactToken(target)
    ? 4
    : this.getEffectiveLockTier(
        targetTokenId,
        _distanceSquaresToTarget(targetTokenId, this.ship),
      );
  if (tier < 1) return false;

  return this.update({
    "resources.sensors.recommendedTargetId": targetTokenId,
    ..._contactUpdates(data, [{ targetTokenId, tier }]),
  });
}

/** Clear every targeting reference when its token leaves the scene. */
export async function clearTargetReferences(targetTokenId) {
  if (!targetTokenId || !this.ship) return false;
  return this.withAllocationTransaction(async () => {
    const updates = buildTargetReferenceCleanup(this.getData(), [targetTokenId]);
    if (Object.keys(updates).length === 0) return true;
    await this.update(updates);
    return true;
  }, this.ship);
}

/** Remove persisted targeting references whose Tokens are absent from the world. */
export async function pruneTargetReferences(validTargetTokenIds = []) {
  if (!this.ship) return false;
  const valid = new Set(validTargetTokenIds);
  return this.withAllocationTransaction(async () => {
    const data = this.getData();
    const stale = [...collectTargetReferenceIds(data)].filter(targetTokenId => !valid.has(targetTokenId));
    const updates = buildTargetReferenceCleanup(data, stale);
    if (Object.keys(updates).length === 0) return true;
    await this.update(updates);
    return true;
  }, this.ship);
}

/**
 * Return the explicit lock tier for a target token (0 if none).
 */
export function getLockTier(targetTokenId) {
  const data = this.getData();
  const lock = (data.resources?.sensors?.locks ?? []).find(l => l.targetTokenId === targetTokenId);
  return lock?.tier ?? 0;
}

/**
 * Return the effective lock tier taking auto-lock into account.
 * Targets within auto-scan range are auto-locked at tier 2.
 */
export function getEffectiveLockTier(targetTokenId, distSq) {
  const explicit   = this.getLockTier(targetTokenId);
  const sensor     = this.getSensorStats();
  const scanRange  = sensor.autoScanRange ?? 0;
  const autoTier   = (scanRange > 0 && distSq <= scanRange) ? 2 : 0;
  return Math.max(explicit, autoTier);
}

/**
 * Consume lock on a target after firing  -  drops lock to 0 and returns the
 * effective pre-fire tier for the attack's immutable BDA record.
 */
export async function consumeLock(targetTokenIdOrPayload) {
  const targetTokenId = typeof targetTokenIdOrPayload === "string"
    ? targetTokenIdOrPayload
    : targetTokenIdOrPayload?.targetTokenId;
  if (!targetTokenId) return 0;

  const data  = this.getData();
  const locks = [...(data.resources?.sensors?.locks ?? [])];
  const idx   = locks.findIndex(l => l.targetTokenId === targetTokenId);
  const explicitTier = locks[idx]?.tier ?? 0;

  // Also account for auto-scan: if the target is in auto-scan range it always
  // contributes Tier 2 even if no explicit lock exists.
  // Distance must be computed in grid squares (same units as autoScanRange).
  const sensor    = this.getSensorStats?.() ?? {};
  const scanRange = sensor.autoScanRange ?? 0;
  let   autoTier  = 0;
  if (scanRange > 0) {
    const targetTok = canvas?.tokens?.get(targetTokenId);
    if (targetTok) {
      const ship    = this.ship;
      const shipTok = ship ? canvas?.tokens?.placeables?.find(t => t.document?.actorId === ship.id) : null;
      if (shipTok) {
        const gs  = canvas.grid.size;
        const tx  = targetTok.document.x + (targetTok.document.width  * gs) / 2;
        const ty  = targetTok.document.y + (targetTok.document.height * gs) / 2;
        const sx  = shipTok.document.x   + (shipTok.document.width    * gs) / 2;
        const sy  = shipTok.document.y   + (shipTok.document.height   * gs) / 2;
        const dist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2) / gs;
        if (dist <= scanRange) autoTier = 2;
      }
    }
  }

  const originalTier = Math.max(explicitTier, autoTier);
  if (idx >= 0) locks.splice(idx, 1);
  await this.update({ "resources.sensors.locks": locks });
  return originalTier;
}

/**
 * Remove (zero out) a sensor lock on a specific target.
 * Used when the Augur chooses "Break Off, Reallocate".
 */
export async function removeLock(targetTokenId) {
  const data  = this.getData();
  const locks = (data.resources?.sensors?.locks ?? []).filter(l => l.targetTokenId !== targetTokenId);
  return this.update({ "resources.sensors.locks": locks });
}

/**
 * BDA resolution: retain partial lock based on SL thresholds.
 * SL 0  = reveal damage only (lock lost). SL 1+ = Tier 1. SL 2+ = Tier 2. SL 3+ = Tier 3. SL 4+ = Tier 4.
 */
export async function resolveBDA({ attackId, sl, messageId, messageContent }) {
  const data = this.getData();
  const attack = data.resources?.sensors?.bdaAttacks?.[attackId];
  if (!attack) return;

  const targetTokenId = attack.targetTokenId ?? null;
  const originalLockTier = attack.originalLockTier ?? 4;
  const resolvedMessageId = messageId ?? attack.messageId ?? null;

  let retainedTier = SystemAdapter.current.getLockTierForSL(sl);
  // Cap: BDA cannot restore higher than the original lock tier
  retainedTier = Math.min(retainedTier, originalLockTier);
  if (_sensorBlindBlocksTier(data, retainedTier)) retainedTier = 1;

  const updates = {};

  if (retainedTier > 0 && targetTokenId) {
    const locks = [...(data.resources?.sensors?.locks ?? [])];
    const decay = LOCK_DECAY_ROUNDS[retainedTier] ?? 1;
    const idx   = locks.findIndex(l => l.targetTokenId === targetTokenId);
    if (idx >= 0) {
      locks[idx] = { ...locks[idx], tier: retainedTier, decayRounds: decay };
    } else {
      locks.push({ targetTokenId, tier: retainedTier, decayRounds: decay });
    }
    updates["resources.sensors.locks"] = locks;
    Object.assign(updates, _contactUpdates(data, [{ targetTokenId, tier: retainedTier }]));
  }

  // If a BDA message exists the player client already embedded the fire result in it.
  // Only post a standalone fire-result card when there is no BDA message
  // (e.g. Augur used the sensors tab shortcut instead of the chat card button).
  const pendingRaw = attack.pendingFireResult ?? null;
  if (!resolvedMessageId && pendingRaw) {
    if (sl >= 0) {
      try {
        const { templateData, messageFlags } = JSON.parse(pendingRaw);
        const content = await renderTemplate(
          `modules/${CORE_MODULE_ID}/templates/chat/fire-result.hbs`,
          templateData,
        );
        await ChatMessage.create({
          content,
          speaker: ChatMessage.getSpeaker({ actor: this.ship }),
          flags: { [MODULE_ID]: { type: "fireWeapon", ...messageFlags } },
        });
      } catch (e) {
        console.error(`${MODULE_ID} | Failed to post deferred fire result`, e);
      }
    }
    // sl < 0 with no message: just a UI warning  -  fire data is discarded
    if (sl < 0) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.BDA.AssessmentFailed"));
    }
  }

  await _updateBDAChatMessage(attack, resolvedMessageId, messageContent);

  if (sl >= 1) {
    updates[`resources.sensors.bdaAttacks.${attackId}`] = {
      ...attack,
      status: "correction",
      sl,
      messageId: resolvedMessageId,
    };
  } else {
    updates[`resources.sensors.bdaAttacks.-=${attackId}`] = null;
  }

  return this.update(updates);
}

/** Remove one completed per-attack BDA record. */
export async function completeBDA({ attackId, messageId, messageContent }) {
  if (!attackId) return;
  const attack = this.getData().resources?.sensors?.bdaAttacks?.[attackId];
  if (!attack) return;
  await _updateBDAChatMessage(attack, messageId ?? attack.messageId ?? null, messageContent);
  return this.update({ [`resources.sensors.bdaAttacks.-=${attackId}`]: null });
}

/** Apply a BDA correction and retire its attack record in one ship update. */
export async function applyBdaCorrection({ attackId, correctionId, messageId, messageContent } = {}) {
  if (!attackId || !BDA_CORRECTIONS.some(correction => correction.id === correctionId)) {
    return { ok: false, reason: "invalidCorrection" };
  }
  const ship = this.ship;
  if (!ship) return { ok: false, reason: "noShip" };

  return this.withAllocationTransaction(async () => {
    const data = this.getData(ship) ?? {};
    const attack = data.resources?.sensors?.bdaAttacks?.[attackId];
    if (!attack || attack.status !== "correction") return { ok: false, reason: "notFound" };

    await _updateBDAChatMessage(attack, messageId ?? attack.messageId ?? null, messageContent);
    const updates = { [`resources.sensors.bdaAttacks.-=${attackId}`]: null };
    if (correctionId === "ceaseFireSwitch") {
      const maxAP = this.getReactorStats(ship).auxPowerCapacity ?? 0;
      const currentAP = data.resources?.engineer?.auxiliaryPower ?? 0;
      updates["resources.engineer.auxiliaryPower"] = Math.min(maxAP, currentAP + Math.floor(maxAP * 0.2));
      updates["resources.sensors.locks"] = (data.resources?.sensors?.locks ?? [])
        .filter(lock => lock.targetTokenId !== attack.targetTokenId);
    } else {
      updates["resources.sensors.fireCorrection"] = {
        type: correctionId,
        targetTokenId: attack.targetTokenId ?? null,
        weaponId: null,
        sl: attack.sl ?? 0,
      };
    }
    await this.update(updates, ship);
    return { ok: true };
  }, ship);
}

/**
 * Store a fire correction chosen after BDA.
 * correction = { type: string, targetTokenId: string, weaponId: string, sl: number }
 * Expires: after next attack from same weapon at same target, or end of next turn.
 */
export async function setFireCorrection(correction) {
  return this.update({ "resources.sensors.fireCorrection": correction });
}

/**
 * Spend Auxiliary Power. Returns true on success.
 */
export async function spendAP(cost) {
  const current = this.getData().resources?.engineer?.auxiliaryPower ?? 0;
  if (current < cost) return false;
  await this.update({ "resources.engineer.auxiliaryPower": current - cost });
  return true;
}
