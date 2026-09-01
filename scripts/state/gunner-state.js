/**
 * gunner-state.js – Fire weapon resolution chain (B2) extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID, CORE_MODULE_ID, MACRO_FIRE_TIERS, LANCE_CHARGE_TIERS, buildChargeTiers, scaleDiceFormula, WEAPON_FIRED_HOOK } from "../constants.js";
import { isOrdnance } from "../actors/ordnance/ordnance-types.js";
import { rollCrit } from "./crit-state.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getSensorsOperatorUserId } from "../roles/crew-operators.js";
import { getContactDisplayName } from "../targeting/contact-intelligence.js";
import { hasDevastationProtocol } from "../stances.js";
import { attackBypassesShields, usesDamagePoolShields } from "./shield-resolution.js";
import { buildDefenseUpdates, resolveHitsAgainstDefenses } from "./hit-damage-resolution.js";
import { getDisabledWeaponSectionId, getWeaponSectionId } from "./weapon-section.js";

/** Allocate an opaque BDA key without ever overwriting a live attack record. */
export function allocateBdaAttackId(existingAttacks = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = foundry.utils.randomID(20);
    if (!Object.hasOwn(existingAttacks, id)) return id;
  }
  throw new Error(`${MODULE_ID} | Unable to allocate a unique BDA attack id`);
}

/**
 * B2 Resolution Chain (SL Allocation model):
 * 1. LOCK SL: First fire action locks the Gunner’s SL allocation for the turn.
 * 2. SALVO: All shots roll individual d100s vs accuracy (boosted by allocAccuracy).
 * 3. SHIELDS: each hit absorbed costs 1 + ShieldBurn(X); ShieldBypass → skip.
 * 4. DAMAGE: per surviving hit = weaponDamage + allocFirepower − (sectorArmour − AP − allocPenetration), min 0.
 * 5. REND: each hit through shields reduces sector armour by Rend value, even if armour blocks all hull damage.
 * 6. CRITICAL: if any single hit damage ≥ hull.max/4, roll on crit table.
 */
export async function fireWeapon({ weaponId, actorId, fireMode, targetToken, hitQuadrant, accuracy, isAutoHit, zone, salvoSize, isOvercharged, fireCorrection }) {
  const ship = this.ship;
  if (!ship) return;

  // Resolve weapon: NPC fire provides actorId of the firing NPC actor
  const firingActor = actorId ? (game.actors.get(actorId) ?? ship) : ship;
  const weapon = firingActor.items.get(weaponId);
  if (!weapon) return;

  const isNpcFire = firingActor.type === `${MODULE_ID}.npcShip`;
  // NPC fire reads from the NPC actor's own system; player fire reads from the player ship
  const sys = isNpcFire ? SystemAdapter.current.getShipData(firingActor) : SystemAdapter.current.getShipData(ship);

  const disabledSectionId = getDisabledWeaponSectionId(sys, [...firingActor.items.values()].filter(
    item => item.type === `${MODULE_ID}.component` && item.system?.slot === "weapon",
  ));
  if (disabledSectionId && getWeaponSectionId(weapon) === disabledSectionId) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Crit.WeaponSectionJammedDesc"));
    return false;
  }

  const gunnerRes = sys.resources?.gunner ?? {};
  const weaponType = weapon.system.resourceType;
  const resourceType = weapon.system.resource;
  const traits = weapon.system.traits ?? {};

  // ── Lock SL allocation on first fire (player only) ──
  if (!isNpcFire && !gunnerRes.slLocked) {
    await this.update({ "resources.gunner.slLocked": true });
  }

  // Read allocated stats
  const allocAccuracy   = gunnerRes.allocAccuracy ?? 0;
  const allocPenetration = gunnerRes.allocPenetration ?? 0;
  const allocFirepower  = gunnerRes.allocFirepower ?? 0;
  const updates = {};
  let lancePowerSpent = 0;
  let lanceTierLabel  = null;

  // Extend Range core action: consumed on the next shot (cleared here, before damage)
  if (!isNpcFire && gunnerRes.sensorBandExpanded) {
    updates["resources.gunner.sensorBandExpanded"] = false;
  }

  // ── 0. Resource consumption ──
  let resourceCost = "";
  if (!isNpcFire) {
    // ── Player ship resource consumption ──
    if (resourceType === "ammo") {
      const tier = MACRO_FIRE_TIERS.find(t => t.id === fireMode);
      if (!tier) return;
      const ammo = gunnerRes.ammo ?? 0;
      if (ammo < tier.ammo) return;
      updates["resources.gunner.ammo"] = ammo - tier.ammo;
      resourceCost = `${tier.ammo} ${game.i18n.localize("SHIPCOMBAT.Gunner.Ammo")}`;
    } else if (resourceType === "heat") {
      const heat = sys.resources?.engineer?.heat ?? 0;
      const baseHeatPerShot = (traits.overcharge && isOvercharged) ? 2 : 1;
      const effectiveSalvo = Math.max(1, Number(salvoSize ?? weapon.system.salvoSize ?? 1));
      const heatCost = baseHeatPerShot * effectiveSalvo;
      updates["resources.engineer.heat"] = heat + heatCost;
      resourceCost = `+${heatCost} ${game.i18n.localize("SHIPCOMBAT.Gunner.Heat")}`;
    } else if (resourceType === "power") {
      const charge = sys.resources?.engineer?.auxiliaryPower ?? 0;
      const step = weapon.system.chargeStep || 5;
      const maxCharge = step * 4;
      const spent = Math.min(charge, maxCharge);
      lancePowerSpent = spent;
      updates["resources.engineer.auxiliaryPower"] = charge - spent;
      resourceCost = `${spent} ${game.i18n.localize("SHIPCOMBAT.Sensors.PowerTrack")}`;
    }

    // ── Track once-per-turn usage (unless weapon has Multiple Attacks) ──
    if (!traits.unlimitedRof) {
      const currentFired = gunnerRes.firedWeaponIds ?? [];
      if (!currentFired.includes(weaponId)) {
        updates["resources.gunner.firedWeaponIds"] = [...currentFired, weaponId];
      }
    }

    if (Object.keys(updates).length) {
      await this.update(updates);
    }
  } else {
    // ── NPC ship resource consumption  -  writes directly to firingActor ──
    const npcUpdates = {};
    if (resourceType === "ammo") {
      const tier = MACRO_FIRE_TIERS.find(t => t.id === fireMode);
      if (!tier) return;
      const ammo = gunnerRes.ammo ?? 0;
      if (ammo < tier.ammo) return;
      npcUpdates["system.resources.gunner.ammo"] = ammo - tier.ammo;
      resourceCost = `${tier.ammo} ${game.i18n.localize("SHIPCOMBAT.Gunner.Ammo")}`;
    } else if (resourceType === "heat") {
      const heat = sys.heat ?? 0;
      const baseHeatPerShot = (traits.overcharge && isOvercharged) ? 2 : 1;
      const effectiveSalvo = Math.max(1, Number(salvoSize ?? weapon.system.salvoSize ?? 1));
      const heatCost = baseHeatPerShot * effectiveSalvo;
      npcUpdates["system.heat"] = heat + heatCost;
      resourceCost = `+${heatCost} ${game.i18n.localize("SHIPCOMBAT.Gunner.Heat")}`;
    } else if (resourceType === "power") {
      const charge = gunnerRes.power ?? 0;
      const step = weapon.system.chargeStep || 5;
      const maxCharge = step * 4;
      const spent = Math.min(charge, maxCharge);
      lancePowerSpent = spent;
      npcUpdates["system.resources.gunner.power"] = charge - spent;
      resourceCost = `${spent} ${game.i18n.localize("SHIPCOMBAT.Sensors.PowerTrack")}`;
    }

    if (Object.keys(npcUpdates).length) {
      await firingActor.update(npcUpdates);
    }
  }

  // Compute lance tier label for power weapons (shown in chat card instead of generic "Lance Fire")
  if (weaponType === "power") {
    const _lStep  = weapon.system.chargeStep || 5;
    const _lTiers = buildChargeTiers(_lStep);
    const _lEff   = Math.min(lancePowerSpent, _lStep * 4);
    const _lTier  = _lTiers.find(t => _lEff >= t.min && _lEff <= t.max);
    lanceTierLabel = game.i18n.localize(_lTier?.label ?? "SHIPCOMBAT.Gunner.LanceFire");
  }

  const targetTok  = canvas.tokens.get(targetToken);
  const targetRealName = targetTok?.document?.name ?? "Unknown";
  let targetDisplayTier = this.getLockTier(targetToken);
  const ownToken = this.ship?.getActiveTokens?.()?.[0];
  const gs = canvas?.grid?.size;
  if (!isNpcFire && targetTok && ownToken && gs) {
    const tx = targetTok.x + (targetTok.document.width * gs) / 2;
    const ty = targetTok.y + (targetTok.document.height * gs) / 2;
    const sx = ownToken.x + (ownToken.document.width * gs) / 2;
    const sy = ownToken.y + (ownToken.document.height * gs) / 2;
    targetDisplayTier = this.getEffectiveLockTier(targetToken, Math.hypot(tx - sx, ty - sy) / gs);
  }
  const targetName = isNpcFire
    ? targetRealName
    : getContactDisplayName(sys, targetToken, {
        currentTier: targetDisplayTier,
        realName: targetRealName,
      });
  // Resolve the target actor to apply damage/crits to the correct ship
  const targetActor = targetTok?.document?.actor ?? null;
  const targetSys   = SystemAdapter.current.getShipData(targetActor) ?? sys;

  // ── 1. Salvo Resolution (all shots roll individually) ──
  const scatterShieldBurn = (gunnerRes.payload === "scatterShot") ? 1 : 0;
  const totalSalvo = (salvoSize ?? weapon.system.salvoSize ?? 1);
  const baseSalvo  = weapon.system.salvoSize ?? 1;
  const allRolls = [];

  // The targeting popups pass a fully composed hit modifier (sensor rating,
  // zone/distance, fire mode, lock tier, SL allocation, weapon rating, stance,
  // BDA corrections, Priority Target, captain boosts).  Do NOT re-add those
  // here — only the Fire Control Failure penalty, which the popups don't know
  // about, is applied at resolution time.
  const adapter          = SystemAdapter.current;
  const step             = adapter.getModifierStepSize();
  const fcPenalty        = sys.conditions?.weaponsSensors?.tier === "high" ? -2 * step : 0;
  const effectiveAccuracy = isAutoHit ? 999 : Math.max(accuracy + fcPenalty, 1);

  // Adapter-supplied target AC (d20 systems only; null for roll-under systems)
  const targetAC = adapter.getTargetAC(targetActor);

  // Pre-compute FFE reduction so it is available during per-shot crit checks
  const ffeReduction = (fireCorrection?.type === "fireForEffect") ? (fireCorrection.sl ?? 0) : 0;
  const salvoRolls = [];
  let jammed = false;
  const batchSize = Math.max(1, baseSalvo);
  const _delay = ms => new Promise(r => setTimeout(r, ms));

  if (!isAutoHit) {
    for (let batch = 0; batch * batchSize < totalSalvo; batch++) {
      if (batch > 0) await _delay(1000);

      const batchStart = batch * batchSize;
      const batchEnd   = Math.min(batchStart + batchSize, totalSalvo);
      const batchRolls = [];

      // Roll all shots in this batch with short gaps
      for (let i = batchStart; i < batchEnd; i++) {
        if (i > batchStart) await _delay(100);

        const shotRoll = await new Roll(adapter.getRollFormula()).evaluate();
        allRolls.push(shotRoll);

        // Fire dice animation without awaiting (parallel within batch)
        if (game.dice3d) {
          game.dice3d.showForRoll(shotRoll, game.user, true);
        }

        const shotResult = shotRoll.total;
        const hit        = adapter.isHit(shotRoll, effectiveAccuracy, targetAC);
        const isCrit     = hit && adapter.isCriticalHit(shotRoll, effectiveAccuracy, targetAC, ffeReduction ? { ...traits, ffeReduction } : traits);
        const isJam      = !hit && adapter.isJam(shotRoll, effectiveAccuracy, traits, targetAC);
        const isCritMiss = !hit && adapter.isCriticalMiss(shotRoll, effectiveAccuracy, targetAC, traits);

        salvoRolls.push({ roll: shotResult, target: effectiveAccuracy, hit, isCrit, isCritMiss, isJam });

        if (isJam) {
          jammed = true;
          break;
        }
      }

      if (jammed) break;
    }
  } else {
    // Auto-hit: all shots hit
    for (let i = 0; i < totalSalvo; i++) {
      salvoRolls.push({ roll: 0, target: 999, hit: true, isCrit: false, isCritMiss: false, isJam: false });
    }
  }

  const totalHits = salvoRolls.filter(r => r.hit).length;

  // Build an ordnanceRoll-compatible summary for the chat card
  const ordnanceRoll = null;
  const ordnanceOutcome = isAutoHit
    ? game.i18n.localize("SHIPCOMBAT.Fire.AutoHit")
    : `${totalHits}/${totalSalvo} ${game.i18n.localize("SHIPCOMBAT.Fire.Hits")}`;

  // Always consume lock after firing. The immutable pre-fire tier is carried
  // into this attack's own BDA record instead of shared ship-wide fields.
  let bdaAttackId = null;
  let bdaOriginalLockTier = 0;
  if (targetToken && !isNpcFire) {
    const existingAttacks = this.getData()?.resources?.sensors?.bdaAttacks ?? {};
    bdaAttackId = allocateBdaAttackId(existingAttacks);
    bdaOriginalLockTier = await this.consumeLock(targetToken);
  }

  if (totalHits === 0) {
    await this._fireWeaponChat(weapon, fireMode, targetName, hitQuadrant, ordnanceRoll, isAutoHit, {
      totalSalvo, baseSalvo, guaranteedHits: 0, salvoRolls, totalHits: 0,
      shieldResults: null, damageResults: null,
      resourceCost, jammed, allRolls,
      ordnanceOutcome,
      allocAccuracy, allocPenetration, allocFirepower,
      isNpcFire,
      speakerActor: firingActor,
      targetAC,
      lanceTierLabel,
      critResults: [],
      bdaAttackId,
      bdaTargetTokenId: targetToken,
      bdaOriginalLockTier,
    });
    return;
  }

  // ── Ordnance targets (torpedo / strike craft): 1 HP per hit, skip shields / armour ──
  if (targetActor && isOrdnance(targetActor)) {
    const currentHull = targetSys.hull?.value ?? 0;
    const hullMax     = targetSys.hull?.max ?? 1;
    const _isHP       = SystemAdapter.current.hullDisplayMode === "hpRemaining";
    const _newHull    = _isHP ? Math.max(0, currentHull - totalHits) : Math.min(hullMax, currentHull + totalHits);
    await targetActor.update({ [SystemAdapter.current.systemPath("hull.value")]: _newHull });
    await this._fireWeaponChat(weapon, fireMode, targetName, hitQuadrant, ordnanceRoll, isAutoHit, {
      totalSalvo, baseSalvo, guaranteedHits: 0, salvoRolls, totalHits,
      shieldResults: null,
      damageResults: {
        sectorArmour: 0, ap: 0, effectiveArmour: 0,
        rawDamagePerHit: 1, damagePerHit: 1, devastatingBonus: 0,
        hitsThroughShield: totalHits,
        hitDetails: Array.from({ length: totalHits }, () => ({ damage: 1, isCrit: false })),
        totalDamage: totalHits,
        rendTotal: 0, lanceMult: 1,
      },
      resourceCost, jammed, allRolls,
      ordnanceOutcome,
      allocAccuracy, allocPenetration, allocFirepower,
      isNpcFire, speakerActor: firingActor,
      targetAC,
      lanceTierLabel,
      critResults: [],
      bdaAttackId,
      bdaTargetTokenId: targetToken,
      bdaOriginalLockTier,
    });
    return;
  }

  const _weaponDamageType = weapon.system.damageType || "";

  // ── 2. Shields ── Read from TARGET actor
  const targetShields = targetSys.shields?.[hitQuadrant] ?? 0;
  const damagePoolShields = usesDamagePoolShields();
  const shieldBurnVal = (traits.overcharge && isOvercharged)
    ? (traits.shieldBurn ?? 0) * 3
    : (traits.shieldBurn ?? 0);
  // Priority Target: +2 void shield burn against the nominated priority target
  const priorityTargetId       = sys.resources?.captain?.priorityTargetId ?? null;
  const battleClarityShieldBurn = (!isNpcFire && priorityTargetId && priorityTargetId === targetToken) ? 2 : 0;
  const effectiveShieldBurn = shieldBurnVal + scatterShieldBurn + battleClarityShieldBurn;
  const shieldBypass = attackBypassesShields(traits, targetSys);

  // ── 3. Damage per surviving hit (with SL allocation bonuses) ──
  const sectorArmour = targetSys.armour?.[hitQuadrant] ?? 0;
  const apShellsBonus = (gunnerRes.payload === "apShells") ? 2 : 0;
  // BDA "Target Weak Point" correction: +SL to armour penetration for this attack
  const twpBonus = (fireCorrection?.type === "targetWeakPoint") ? (fireCorrection.sl ?? 0) : 0;
  // Priority Target (captain core action): +2 armour penetration + 2 void shield burn against nominated priority target
  const battleClarityPierce = (!isNpcFire && priorityTargetId && priorityTargetId === targetToken) ? 2 : 0;
  const ap = ((traits.overcharge && isOvercharged) ? (traits.armourPenetration ?? 0) * 3 : (traits.armourPenetration ?? 0)) + allocPenetration + apShellsBonus + twpBonus + battleClarityPierce;
  const effectiveArmour = Math.max(0, sectorArmour - ap);
  // Evaluate the damage field as a dice formula (e.g. "2d6", "1d8+4") or plain number.
  // For lance (power) weapons the tier multiplier scales the dice COUNT before rolling
  // so "4d6" at 2× becomes "8d6" rather than rolling 4d6 and doubling the total.
  const _damageFormula = SystemAdapter.current.getWeaponDamageFormula(weapon);
  let lanceMult = 1;
  let _scaledFormula = _damageFormula;
  if (weaponType === "power") {
    const step = weapon.system.chargeStep || 5;
    const tiers = buildChargeTiers(step);
    const effectiveCharge = Math.min(lancePowerSpent, step * 4);
    const tier = tiers.find(t => effectiveCharge >= t.min && effectiveCharge <= t.max);
    const tierMult = tier?.multiplier ?? 1;
    if (/^\d+d\d+/i.test(_damageFormula)) {
      // Dice formula: scale the dice count and flat bonus, then roll it
      _scaledFormula = scaleDiceFormula(_damageFormula, tierMult);
      lanceMult = 1; // already baked into the formula
    } else {
      lanceMult = tierMult; // flat value: multiply the result post-roll
    }
  }
  const _hasDice = /\d*d\d+/i.test(_scaledFormula);
  const devastatingBonus = (traits.overcharge && isOvercharged)
    ? (traits.devastating ?? 0) * 3
    : (traits.devastating ?? 0);

  const damageRollValues = [];
  let _sumRawDamage = 0;
  let damageHitCount = 0;
  const successfulSalvoRolls = salvoRolls.filter(result => result.hit);
  const rendPerHit = (traits.overcharge && isOvercharged)
    ? (traits.rend ?? 0) * 3
    : (traits.rend ?? 0);
  const resolution = await resolveHitsAgainstDefenses({
    hits: successfulSalvoRolls.map(salvoResult => ({
      isCrit: salvoResult.isCrit ?? false,
      salvoResult,
      async resolveDamage() {
        damageHitCount++;
        let baseDamageThisHit = 0;
        try {
          const damageRoll = new Roll(_scaledFormula);
          await damageRoll.evaluate();
          baseDamageThisHit = damageRoll.total ?? 0;
          if (game.dice3d && _hasDice) game.dice3d.showForRoll(damageRoll, game.user, true);
        } catch {
          baseDamageThisHit = parseFloat(_scaledFormula) || 0;
        }
        if (_hasDice) damageRollValues.push({ value: baseDamageThisHit, isCrit: salvoResult.isCrit ?? false });
        const rawDamage = Math.floor(baseDamageThisHit * lanceMult) + allocFirepower;
        _sumRawDamage += rawDamage;
        return { damage: rawDamage + ((salvoResult.isCrit ?? false) ? devastatingBonus : 0) };
      },
    })),
    shields: targetShields,
    shieldBurn: effectiveShieldBurn,
    shieldBypass,
    damagePool: damagePoolShields,
    armour: sectorArmour,
    armourPenetration: ap,
    rendPerHit,
    armourRend: targetSys.armourRend?.[hitQuadrant] ?? 0,
    hullValue: targetSys.hull?.value ?? 0,
    hullMax: targetSys.hull?.max ?? 50,
    hullDisplayMode: SystemAdapter.current.hullDisplayMode,
    isNpcTarget: targetActor?.type === `${MODULE_ID}.npcShip`,
    modifyDamage: damage => (_weaponDamageType && targetActor)
      ? SystemAdapter.current.modifyDamageForType(damage, _weaponDamageType, targetActor)
      : { finalDamage: damage, immune: false, note: null },
  });
  const shieldResults = resolution.shieldResults;
  const { totalDamage, rendTotal, hitsThroughShield } = resolution.damageResults;
  const penetratingSalvoRolls = resolution.penetratingHits
    .map(hit => successfulSalvoRolls[hit.sourceIndex])
    .filter(Boolean);

  // rawDamagePerHit: average across hits for display; pre-computed if no hits went through
  const rawDamagePerHit = damageHitCount > 0
    ? Math.round(_sumRawDamage / damageHitCount)
    : Math.floor((parseFloat(_scaledFormula) || 0) * lanceMult) + allocFirepower;
  const damagePerHit = Math.max(0, rawDamagePerHit - effectiveArmour);

  const damageResults = {
    ...resolution.damageResults,
    sectorArmour,
    ap,
    effectiveArmour,
    rawDamagePerHit,
    damagePerHit,
    devastatingBonus,
    hitsThroughShield,
    lanceMult,
    damageRolls:    damageRollValues,
    damageDiceLabel: _hasDice ? _scaledFormula : null,
    damageFlatBonus: allocFirepower > 0 ? allocFirepower : 0,
    hasDamageRolls:  damageRollValues.length > 0,
    isSalvo:         hitsThroughShield > 1,
    damagePool:      damagePoolShields,
    resolvedHits:    damageHitCount,
  };

  // ── 5. Apply damage to TARGET actor ──
  const targetUpdates = buildDefenseUpdates(resolution, hitQuadrant);

  if (Object.keys(targetUpdates).length > 0) {
    if (targetActor) {
      await targetActor.update(targetUpdates);
    } else {
      // No target token on canvas  -  fall back to player ship
      const fallback = {};
      for (const [k, v] of Object.entries(targetUpdates)) {
        fallback[k.replace(/^system\./, "")] = v;
      }
      await this.update(fallback);
    }
  }

  // ── 6. Crit check ──
  const critResults = [];
  if (targetActor && totalHits > 0 && totalDamage > 0) {
    const isDevastation = hasDevastationProtocol(sys, targetSys);
    const critHitCount  = adapter.getCritHitCount(penetratingSalvoRolls, hitsThroughShield, isDevastation);

    if (critHitCount !== null) {
      // Per-crit-hit path (SF2e): one Low-tier crit per critting shot
      for (let i = 0; i < critHitCount; i++) {
        const r = await rollCrit.call(this, targetActor, totalDamage, false, ffeReduction, true);
        if (r) critResults.push(r);
      }
    } else {
      // Damage-based path (Impmal etc.): one crit based on total hull damage
      const r = await rollCrit.call(this, targetActor, totalDamage, isDevastation, ffeReduction);
      if (r) critResults.push(r);
    }
  }

  // ── 7b. Ranging Fire: if any shot hit, store a persistent fixed bonus against this target ──
  if (fireMode === "rangingFire" && totalHits > 0 && targetToken && !isNpcFire) {
    await this.update({
      "resources.sensors.fireCorrection": {
        type: "rangingFireBonus",
        targetTokenId: targetToken.id,
        persistent: true,
      },
    });
  }

  // ── 7c. Consume fire correction now that the shot is resolved (skip persistent corrections) ──
  if (fireCorrection && !fireCorrection.persistent) {
    await this.update({ "resources.sensors.fireCorrection": null });
  }

  // ── 8. Chat message ──
  await this._fireWeaponChat(weapon, fireMode, targetName, hitQuadrant, ordnanceRoll, isAutoHit, {
    totalSalvo, baseSalvo, guaranteedHits: 0, salvoRolls, totalHits,
    shieldResults, damageResults,
    resourceCost, jammed, allRolls,
    ordnanceOutcome,
    allocAccuracy, allocPenetration, allocFirepower,
    isNpcFire,
    speakerActor: firingActor,
    targetAC,
    lanceTierLabel,
    critResults,
    bdaAttackId,
    bdaTargetTokenId: targetToken,
    bdaOriginalLockTier,
  });

  // ── 9. Animation hook (GM-local) ──
  // socket.js broadcasts this to all clients after fireWeapon completes.
  Hooks.callAll(WEAPON_FIRED_HOOK, {
    weapon,
    weaponCategory: weapon.system.weaponCategory ?? "",
    fireMode,
    firingActor,
    targetToken: targetTok ?? null,
    totalHits,
    totalSalvo,
    isNpcFire,
  });

  return { totalHits, totalSalvo };
}

/**
 * Build and post the fire-result chat card.
 */
export async function _fireWeaponChat(weapon, fireMode, targetName, hitQuadrant, ordnanceRoll, isAutoHit, results) {
  const {
    totalSalvo, baseSalvo, guaranteedHits, salvoRolls, totalHits,
    shieldResults, damageResults,
    resourceCost, jammed, allRolls,
    ordnanceOutcome,
    isNpcFire,
    speakerActor,
    critResults = [],
    targetAC = null,
    lanceTierLabel = null,
    bdaAttackId = null,
    bdaTargetTokenId = null,
    bdaOriginalLockTier = 0,
  } = results;

  const _baseFireModeLabel = game.i18n.localize(
    `SHIPCOMBAT.Gunner.${fireMode.charAt(0).toUpperCase() + fireMode.slice(1)}`
  ) ?? fireMode;
  const fireModeLabel = lanceTierLabel ?? _baseFireModeLabel;
  const hitQuadrantLabel = game.i18n.localize(
    `SHIPCOMBAT.Sector.${hitQuadrant.charAt(0).toUpperCase() + hitQuadrant.slice(1)}`
  );

  const success = ordnanceRoll?.success ?? isAutoHit;
  const signedSL = ordnanceRoll?.signedSL ?? "+0";

  // ── Timed salvo reveal: batch dice by baseSalvo ──
  const SHOT_INTERVAL = 100;
  const BATCH_GAP     = 1000;
  const SUMMARY_PAD   = 400;
  const batchSize     = Math.max(1, baseSalvo ?? 1);

  let lastDelay = 0;
  const styledSalvoRolls = salvoRolls.map((r, i) => {
    const batchIdx  = Math.floor(i / batchSize);
    const posInBatch = i % batchSize;
    const delay = batchIdx * (batchSize * SHOT_INTERVAL + BATCH_GAP) + posInBatch * SHOT_INTERVAL;
    lastDelay = delay;
    // d20 systems (targetAC !== null): show attack total (d20 + modifier) and compare vs AC
    const displayRoll   = (targetAC !== null) ? (r.roll + r.target) : r.roll;
    const displayTarget = (targetAC !== null) ? targetAC : r.target;
    let critClass = "";
    if (r.hit && r.isCrit)      critClass = "shipcombat-salvo-crit";
    else if (!r.hit && r.isCritMiss) critClass = "shipcombat-salvo-crit-fail";
    return {
      ...r,
      revealDelay: delay,
      dieStyle: `animation-delay:${delay}ms`,
      batchBreak: i > 0 && posInBatch === 0,
      displayRoll,
      displayTarget,
      critClass,
    };
  });
  const summaryDelay = (salvoRolls.length > 0 ? lastDelay + SHOT_INTERVAL : 0) + SUMMARY_PAD;

  const templateData = {
    weaponName: weapon.name,
    weaponImg: weapon.img,
    fireModeLabel,
    targetName,
    hitQuadrantLabel,
    isAutoHit,
    success,
    accuracy: isAutoHit ? null : SystemAdapter.current.formatChatAccuracyDisplay(salvoRolls[0]?.target ?? null, targetAC),
    hitModDisplay: isAutoHit ? null : SystemAdapter.current.formatChatHitMod(salvoRolls[0]?.target ?? null, targetAC),
    signedSL,
    outcome: ordnanceOutcome ?? ordnanceRoll?.outcome ?? game.i18n.localize("SHIPCOMBAT.Fire.AutoHit"),
    totalSalvo,
    guaranteedHits,
    salvoRolls: styledSalvoRolls,
    totalHits,
    shieldResults,
    damageResults,
    resourceCost,
    jammed,
    hasSalvoRolls: styledSalvoRolls.length > 0,
    hasShieldResults: shieldResults !== null,
    hasDamageResults: damageResults !== null && (damageResults.totalDamage > 0 || damageResults.rendTotal > 0 || damageResults.hitsThroughShield > 0),
    summaryDelay,
    // NPC crits revealed immediately; player crits revealed after BDA
    critResults: isNpcFire ? critResults : [],
  };

  const messageFlags = {
    weaponId:    weapon.id,
    fireMode,
    targetName,
    hitQuadrant,
    success,
    sl:          ordnanceRoll?.sl ?? 0,
    totalHits,
    totalDamage: damageResults?.totalDamage ?? 0,
  };

  // Store result and defer posting until the Augur completes BDA
  // NPC fire bypasses BDA entirely and posts the result card immediately.

  // ── BDA-Pending notification ────────────────────────────────────────────
  // Each attack owns an immutable result snapshot keyed by attackId. This
  // prevents later shots from replacing the hit count or damage shown by an
  // earlier assessment.
  const operatorUserId = !isNpcFire ? getSensorsOperatorUserId(this.ship) : null;
  const storeData = critResults.length > 0
    ? { templateData: { ...templateData, critResults }, messageFlags }
    : { templateData, messageFlags };

  if (operatorUserId && bdaAttackId) {
    const createdAt = Date.now();
    const attackRecord = {
      attackId: bdaAttackId,
      shipUuid: this.ship.uuid,
      targetTokenId: bdaTargetTokenId,
      targetName,
      weaponName: weapon.name,
      weaponImg: weapon.img,
      fireModeLabel,
      originalLockTier: bdaOriginalLockTier,
      operatorUserId,
      status: "pending",
      createdAt,
      messageId: null,
      pendingFireResult: JSON.stringify(storeData),
    };
    await this.update({
      [`resources.sensors.bdaAttacks.${bdaAttackId}`]: attackRecord,
    });

    const bdaContent = await renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/bda-pending.hbs`,
      { targetName, weaponName: weapon.name, weaponImg: weapon.img, fireModeLabel }
    );
    const bdaMsg = await ChatMessage.create({
      content: bdaContent,
      user:    operatorUserId,
      speaker: ChatMessage.getSpeaker({ actor: speakerActor ?? this.ship }),
      flags: {
        [MODULE_ID]: {
          type: "bdaPending",
          attackId: bdaAttackId,
          attackCreatedAt: createdAt,
          shipUuid: this.ship.uuid,
          operatorUserId,
          targetName,
        },
      },
    });
    if (bdaMsg?.id) {
      await this.update({
        [`resources.sensors.bdaAttacks.${bdaAttackId}.messageId`]: bdaMsg.id,
      });
    }
  } else {
    // No Augur assigned: post fire result immediately
    // For player fire without augur, also reveal crits now
    const finalTd = (!isNpcFire && critResults.length > 0) ? { ...templateData, critResults } : templateData;
    const content = await renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/fire-result.hbs`,
      finalTd,
    );
    const allCritRolls = critResults.flatMap(r => r.critRolls ?? []);
    await ChatMessage.create({
      content,
      rolls:   allCritRolls,
      speaker: ChatMessage.getSpeaker({ actor: speakerActor ?? this.ship }),
      flags: { [MODULE_ID]: { type: "fireWeapon", ...messageFlags } },
    });
  }

}
