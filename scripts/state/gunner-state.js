/**
 * gunner-state.js – Fire weapon resolution chain (B2) extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID, CORE_MODULE_ID, MACRO_FIRE_TIERS, LANCE_CHARGE_TIERS, buildChargeTiers, WEAPON_FIRED_HOOK } from "../constants.js";
import { isOrdnance } from "../actors/ordnance/ordnance-types.js";
import { rollCrit } from "./crit-state.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

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

  // True when an NPC is attacking the player ship
  const isNpcFire = firingActor.id !== ship.id;
  // NPC fire reads from the NPC actor's own system; player fire reads from the player ship
  const sys = isNpcFire ? firingActor.system : ship.system;

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

  const targetTok  = canvas.tokens.get(targetToken);
  const targetName  = targetTok?.document?.name ?? "Unknown";
  // Resolve the target actor to apply damage/crits to the correct ship
  const targetActor = targetTok?.document?.actor ?? null;
  const targetSys   = targetActor?.system ?? sys;

  // ── 1. Salvo Resolution (all shots roll individually) ──
  const scatterShieldBurn = (gunnerRes.payload === "scatterShot") ? 1 : 0;
  const totalSalvo = (salvoSize ?? weapon.system.salvoSize ?? 1);
  const baseSalvo  = weapon.system.salvoSize ?? 1;
  const allRolls = [];

  // Hit modifier: weapon trait + captain stance + player ship Fire Control Failure
  const adapter          = SystemAdapter.current;
  const step             = adapter.getModifierStepSize();
  const weaponHitMod     = traits.hitRatingModifier ?? 0;
  const stance           = sys.resources?.captain?.stance ?? "none";
  const stanceHitMod     = stance === "aggressive" ? step : stance === "defensive" ? -step : 0;
  const fcPenalty        = sys.conditions?.weaponsSensors?.tier === "high" ? -2 * step : 0;
  const captainHitBonus  = sys.resources?.gunner?.captainHitBonus ?? 0;
  const effectiveAccuracy = isAutoHit ? 999 : Math.max(accuracy + (allocAccuracy * (step / 2)) + weaponHitMod + stanceHitMod + fcPenalty + captainHitBonus, 1);

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
        const hit        = adapter.isHit(shotRoll, effectiveAccuracy);
        const isCrit     = hit && adapter.isCriticalHit(shotRoll, effectiveAccuracy);
        const isJam      = !hit && adapter.isJam(shotRoll, effectiveAccuracy, traits);

        salvoRolls.push({ roll: shotResult, target: effectiveAccuracy, hit, isCrit, isJam });

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
      salvoRolls.push({ roll: 0, target: 999, hit: true, isCrit: false, isJam: false });
    }
  }

  const totalHits = salvoRolls.filter(r => r.hit).length;

  // Build an ordnanceRoll-compatible summary for the chat card
  const ordnanceRoll = null;
  const ordnanceOutcome = isAutoHit
    ? game.i18n.localize("SHIPCOMBAT.Fire.AutoHit")
    : `${totalHits}/${totalSalvo} ${game.i18n.localize("SHIPCOMBAT.Fire.Hits")}`;

  // Always consume lock after firing  -  enables BDA regardless of hit count
  if (targetToken && !isNpcFire) {
    await this.consumeLock(targetToken);
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
    });
    return;
  }

  // ── Ordnance targets (torpedo / strike craft): 1 HP per hit, skip shields / armour ──
  if (targetActor && isOrdnance(targetActor)) {
    const currentHull = targetSys.hull?.value ?? 0;
    const hullMax     = targetSys.hull?.max ?? 1;
    await targetActor.update({ "system.hull.value": Math.min(hullMax, currentHull + totalHits) });
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
      critResult: null,
    });
    return;
  }

  // ── 2. Shields ── Read from TARGET actor
  const targetShields = targetSys.shields?.[hitQuadrant] ?? 0;
  let shieldsRemaining = targetShields;
  let hitsAbsorbed = 0;
  let shieldCostTotal = 0;
  const shieldBurnVal = (traits.overcharge && isOvercharged)
    ? (traits.shieldBurn ?? 0) * 3
    : (traits.shieldBurn ?? 0);
  // Battle Clarity: +2 void shield burn against the nominated priority target
  const priorityTargetId       = sys.resources?.captain?.priorityTargetId ?? null;
  const battleClarityShieldBurn = (!isNpcFire && priorityTargetId && priorityTargetId === targetToken) ? 2 : 0;
  const effectiveShieldBurn = shieldBurnVal + scatterShieldBurn + battleClarityShieldBurn;

  if (traits.shieldBypass) {
    // Shield Bypass: all hits pass through, but Shield Burn still degrades shields
    if (effectiveShieldBurn > 0 && shieldsRemaining > 0) {
      const burnTotal = effectiveShieldBurn * totalHits;
      shieldsRemaining = Math.max(0, shieldsRemaining - burnTotal);
      shieldCostTotal = targetShields - shieldsRemaining;
    }
  } else if (shieldsRemaining > 0) {
    const shieldCostPerHit = 1 + effectiveShieldBurn;
    for (let i = 0; i < totalHits; i++) {
      if (shieldsRemaining <= 0) break;
      shieldsRemaining = Math.max(0, shieldsRemaining - shieldCostPerHit);
      shieldCostTotal += shieldCostPerHit;
      hitsAbsorbed++;
    }
  }

  const hitsThroughShield = totalHits - hitsAbsorbed;
  const shieldResults = {
    sectorShields: targetShields,
    absorbed: hitsAbsorbed,
    shieldCostTotal,
    remaining: shieldsRemaining,
    bypassed: traits.shieldBypass,
    hitsThroughShield,
  };

  // ── 3. Damage per surviving hit (with SL allocation bonuses) ──
  const sectorArmour = targetSys.armour?.[hitQuadrant] ?? 0;
  const apShellsBonus = (gunnerRes.payload === "apShells") ? 2 : 0;
  // BDA "Target Weak Point" correction: +SL to armour penetration for this attack
  const twpBonus = (fireCorrection?.type === "targetWeakPoint") ? (fireCorrection.sl ?? 0) : 0;
  // Battle Clarity (captain core action): +2 armour penetration + 2 void shield burn against nominated priority target
  const battleClarityPierce = (!isNpcFire && priorityTargetId && priorityTargetId === targetToken) ? 2 : 0;
  const ap = ((traits.overcharge && isOvercharged) ? (traits.armourPenetration ?? 0) * 3 : (traits.armourPenetration ?? 0)) + allocPenetration + apShellsBonus + twpBonus + battleClarityPierce;
  const effectiveArmour = Math.max(0, sectorArmour - ap);
  const baseDamage = weapon.system.damage ?? 0;
  // Lance damage multiplier from charge tier
  let lanceMult = 1;
  if (weaponType === "power") {
    const step = weapon.system.chargeStep || 5;
    const tiers = buildChargeTiers(step);
    // Use the AP spent this shot to determine lance tier.
    const effectiveCharge = Math.min(lancePowerSpent, step * 4);
    const tier = tiers.find(t => effectiveCharge >= t.min && effectiveCharge <= t.max);
    lanceMult = tier?.multiplier ?? 1;
  }

  const rawDamagePerHit = Math.floor(baseDamage * lanceMult) + allocFirepower;
  const damagePerHit = Math.max(0, rawDamagePerHit - effectiveArmour);
  const devastatingBonus = (traits.overcharge && isOvercharged)
    ? (traits.devastating ?? 0) * 3
    : (traits.devastating ?? 0);

  let totalDamage = 0;
  const hitDetails = [];
  let rendTotal = 0;

  for (let i = 0; i < hitsThroughShield; i++) {
    const isCritHit = salvoRolls[i]?.isCrit ?? false;
    const thisHitDmg = isCritHit
      ? Math.max(0, rawDamagePerHit + devastatingBonus - effectiveArmour)
      : damagePerHit;
    totalDamage += thisHitDmg;
    hitDetails.push({ damage: thisHitDmg, isCrit: isCritHit });

    // ── 4. Rend  -  applies even if armour blocks all hull damage ──
    const rendPerHit = (traits.overcharge && isOvercharged)
      ? (traits.rend ?? 0) * 3
      : (traits.rend ?? 0);
    if (rendPerHit > 0) {
      rendTotal += rendPerHit;
    }
  }

  const damageResults = {
    sectorArmour,
    ap,
    effectiveArmour,
    rawDamagePerHit,
    damagePerHit,
    devastatingBonus,
    hitsThroughShield,
    hitDetails,
    totalDamage,
    rendTotal,
    lanceMult,
  };

  // ── 5. Apply damage to TARGET actor ──
  const currentHull = targetSys.hull?.value ?? 0;
  const hullMax     = targetSys.hull?.max ?? 50;
  const targetUpdates = {};

  if (totalDamage > 0) {
    targetUpdates["system.hull.value"] = Math.min(hullMax, currentHull + totalDamage);
  }
  if (rendTotal > 0) {
    const currentRend = targetSys.armourRend?.[hitQuadrant] ?? 0;
    targetUpdates[`system.armourRend.${hitQuadrant}`] = currentRend + rendTotal;
    // For NPC ships, armour is stored as a direct current value (not derived from rend)
    if (targetActor?.type === `${MODULE_ID}.npcShip`) {
      const currentArmour = targetSys.armour?.[hitQuadrant] ?? 0;
      targetUpdates[`system.armour.${hitQuadrant}`] = Math.max(0, currentArmour - rendTotal);
    }
  }
  if (shieldsRemaining !== targetShields) {
    targetUpdates[`system.shields.${hitQuadrant}`] = shieldsRemaining;
  }

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
  let critResult = null;
  if (targetActor && totalHits > 0 && totalDamage > 0) {
    const forceCrit = sys.resources?.captain?.stance === "devastation";
    // BDA "Fire for Effect": reduce crit threshold by SL percentage points
    const ffeReduction = (fireCorrection?.type === "fireForEffect") ? (fireCorrection.sl ?? 0) : 0;
    critResult = await rollCrit.call(this, targetActor, totalDamage, forceCrit, ffeReduction);
  }

  // ── 7b. Ranging Fire: if any shot hit, store a persistent +10 bonus against this target ──
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
    critResult,
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
    critResult,
  } = results;

  const fireModeLabel = game.i18n.localize(
    `SHIPCOMBAT.Gunner.${fireMode.charAt(0).toUpperCase() + fireMode.slice(1)}`
  ) ?? fireMode;
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
    return {
      ...r,
      revealDelay: delay,
      dieStyle: `animation-delay:${delay}ms`,
      batchBreak: i > 0 && posInBatch === 0,
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
    accuracy: isAutoHit ? null : (salvoRolls[0]?.target ?? null),
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
    // NPC crit revealed immediately; player crit revealed after BDA
    critResult: isNpcFire ? (critResult ?? null) : null,
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

  // ── BDA-Pending notification (Augur-only button) ───────────────────────
  const augurUserId = !isNpcFire &&
    (Object.entries(this.ship?.system?.roles ?? {})
      .find(([, r]) => r === "sensors")?.[0] ?? null);

  if (!isNpcFire) {
    // For player fire, store critResult alongside templateData so BDA card can reveal it
    const storeData = critResult
      ? { templateData: { ...templateData, critResult }, messageFlags }
      : { templateData, messageFlags };
    await this.update({
      "resources.sensors.pendingFireResult": JSON.stringify(storeData),
    });
  }

  if (augurUserId) {
    const bdaContent = await renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/bda-pending.hbs`,
      { targetName, weaponName: weapon.name, weaponImg: weapon.img, fireModeLabel }
    );
    const bdaMsg = await ChatMessage.create({
      content: bdaContent,
      user:    augurUserId,
      speaker: ChatMessage.getSpeaker({ actor: speakerActor ?? this.ship }),
      flags: {
        [MODULE_ID]: {
          type: "bdaPending",
          augurUserId,
          targetName,
        },
      },
    });
    if (bdaMsg?.id) {
      await this.update({ "resources.sensors.bdaMessageId": bdaMsg.id });
    }
  } else {
    // No Augur assigned: post fire result immediately
    // For player fire without augur, also reveal crit now
    const finalTd = (!isNpcFire && critResult) ? { ...templateData, critResult } : templateData;
    const content = await renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/fire-result.hbs`,
      finalTd,
    );
    const allCritRolls = critResult?.critRolls ?? [];
    await ChatMessage.create({
      content,
      rolls:   allCritRolls,
      speaker: ChatMessage.getSpeaker({ actor: speakerActor ?? this.ship }),
      flags: { [MODULE_ID]: { type: "fireWeapon", ...messageFlags } },
    });
  }

}
