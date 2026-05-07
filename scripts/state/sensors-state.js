/**
 * sensors-state.js – Sensor locks and effects extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID, CORE_MODULE_ID, LOCK_DECAY_ROUNDS } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

/**
 * Add a sensor effect targeting an enemy token.
 */
export async function addSensorEffect({ actionId, targetTokenId, roundsRemaining = 1 }) {
  const data = this.getData();
  const effects = [...(data.resources?.sensors?.effects ?? [])];
  effects.push({ actionId, targetTokenId, roundsRemaining });
  return this.update({ "resources.sensors.effects": effects });
}

/**
 * Upgrade (or create) a sensor lock on a target token.
 * tier  -  the new lock tier (1-4).
 */
export async function upgradeLock({ targetTokenId, tier }) {
  const data = this.getData();
  const locks = [...(data.resources?.sensors?.locks ?? [])];
  const idx   = locks.findIndex(l => l.targetTokenId === targetTokenId);
  const decay = LOCK_DECAY_ROUNDS[tier] ?? 1;

  if (idx >= 0) {
    locks[idx] = { ...locks[idx], tier, decayRounds: decay };
  } else {
    locks.push({ targetTokenId, tier, decayRounds: decay });
  }
  return this.update({ "resources.sensors.locks": locks });
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
 * Consume lock on a target after firing  -  drops lock to 0.
 * Sets bdaAvailable=true so the Augur can roll BDA.
 */
export async function consumeLock(targetTokenId) {
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
  return this.update({
    "resources.sensors.locks": locks,
    "resources.sensors.bdaAvailable": true,
    "resources.sensors.bdaTargetTokenId": targetTokenId,
    "resources.sensors.bdaOriginalLockTier": originalTier,
  });
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
export async function resolveBDA({ targetTokenId, sl, messageId }) {
  const data = this.getData();
  const originalLockTier = data.resources?.sensors?.bdaOriginalLockTier ?? 4;

  let retainedTier = SystemAdapter.current.getLockTierForSL(sl);
  // Cap: BDA cannot restore higher than the original lock tier
  retainedTier = Math.min(retainedTier, originalLockTier);

  const updates = {
    "resources.sensors.bdaAvailable":        false,
    "resources.sensors.bdaCorrectionPending": sl >= 1,  // only true when corrections are available
    "resources.sensors.bdaResultSL":          sl,
    "resources.sensors.bdaOriginalLockTier":  0,
    "resources.sensors.bdaMessageId":         null,
  };

  if (retainedTier > 0) {
    const locks = [...(data.resources?.sensors?.locks ?? [])];
    const decay = LOCK_DECAY_ROUNDS[retainedTier] ?? 1;
    const idx   = locks.findIndex(l => l.targetTokenId === targetTokenId);
    if (idx >= 0) {
      locks[idx] = { ...locks[idx], tier: retainedTier, decayRounds: decay };
    } else {
      locks.push({ targetTokenId, tier: retainedTier, decayRounds: decay });
    }
    updates["resources.sensors.locks"] = locks;
  }

  // If a BDA message exists the player client already embedded the fire result in it.
  // Only post a standalone fire-result card when there is no BDA message
  // (e.g. Augur used the sensors tab shortcut instead of the chat card button).
  const pendingRaw = data.resources?.sensors?.pendingFireResult;
  if (!messageId && pendingRaw) {
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

  // Always clear pending result
  updates["resources.sensors.pendingFireResult"] = null;

  return this.update(updates);
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
