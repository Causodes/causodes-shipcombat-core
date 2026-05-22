/**
 * pilot-state.js – Helm movement and pilot overcharge actions extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID } from "../constants.js";
import { getHitQuadrant } from "../apps/TargetingPopup.js";
import { rollCrit } from "./crit-state.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

/**
 * Consume the pilot's assigned Power Core and record the overcharge action played.
 * Returns false without doing anything if the role has no core.
 * @param {string} userId
 * @param {string} actionId  – "overdrive" | "strafe" | "retro"
 */
export async function consumePilotCore(userId, actionId) {
  if (!this.hasPowerCore("pilot")) return false;
  const data      = this.getData();
  const coreCount = data.resources?.pilot?.coreCount ?? 0;
  if (coreCount <= 0) return false;
  const played = [...(data.resources?.pilot?.coreActionsPlayed ?? []), actionId];
  await this.update({
    "resources.pilot.coreCount":         Math.max(0, coreCount - 1),
    "resources.pilot.coreActionsPlayed": played,
  });
  return true;
}

/**
 * Overcharge – Retrograde Thrust: reduce the min-move obligation by retroValue VU.
 * In Realistic mode, cancels up to retroValue VU of velocity along the current heading.
 */
export async function pilotRetrograde(userId, retroValue, newX, newY, newRotation, waypoints) {
  const consumed = await this.consumePilotCore(userId, "retro");
  if (!consumed) return;

  const data = this.getData();
  const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";

  if (isRealistic) {
    const token = this.ship?.getActiveTokens()?.[0];
    const vx = data.resources?.pilot?.velocityX ?? 0;
    const vy = data.resources?.pilot?.velocityY ?? 0;
    const vmag = Math.hypot(vx, vy);
    if (vmag > 0 && token) {
      // Cancel retroValue VU from the velocity along the current heading direction
      const h0 = (token.document.rotation - 90) * (Math.PI / 180);
      const dot = vx * Math.cos(h0) + vy * Math.sin(h0);
      const cancel = Math.min(retroValue, Math.max(0, dot));
      const newVx = vx - cancel * Math.cos(h0);
      const newVy = vy - cancel * Math.sin(h0);
      await this.update({
        "resources.pilot.velocityX": newVx,
        "resources.pilot.velocityY": newVy,
      });
      // Move token to retrograde position if any
      if (waypoints?.length) {
        // waypoints driven by caller
      } else if (newX !== undefined) {
        await token.document.update({ x: newX, y: newY, rotation: newRotation }, { animate: true });
      }
    }
    return;
  }

  const prevMove   = data.resources?.pilot?.prevTurnMove ?? 0;
  const currentMin = Math.ceil(prevMove / 2);
  const newMin     = Math.max(0, currentMin - retroValue);
  await this.update({ "resources.pilot.prevTurnMove": newMin * 2 });
}

/**
 * Overcharge – Maximum Overdrive: flag the overdrive state so the helm
 * context doubles effective speed this turn.
 */
export async function pilotOverdrive(userId) {
  const consumed = await this.consumePilotCore(userId, "overdrive");
  if (!consumed) return;
  await this.update({ "resources.pilot.overdrive": true });
}

/**
 * Overcharge – Strafe: move the ship token laterally without changing heading.
 * In Realistic mode, also adds the lateral delta to the velocity vector.
 */
export async function pilotStrafe(userId, newX, newY, newRotation, dist, waypoints) {
  const consumed = await this.consumePilotCore(userId, "strafe");
  if (!consumed) return;
  const data = this.getData();
  const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";
  let velocityX, velocityY;
  if (isRealistic) {
    const token = this.ship?.getActiveTokens()?.[0];
    const vx = data.resources?.pilot?.velocityX ?? 0;
    const vy = data.resources?.pilot?.velocityY ?? 0;
    if (token) {
      // Determine direction from displacement vs current heading perpendicular
      const h0 = (token.document.rotation - 90) * (Math.PI / 180);
      const perpAngle = h0 + Math.PI / 2; // starboard
      // Project displacement onto perp to get signed dist
      const gridSize = (typeof canvas !== "undefined") ? canvas.grid.size : 100;
      const dx = (newX - (token.document.x ?? 0)) / gridSize;
      const dy = (newY - (token.document.y ?? 0)) / gridSize;
      const signedDist = dx * Math.cos(perpAngle) + dy * Math.sin(perpAngle);
      velocityX = vx + Math.cos(perpAngle) * signedDist;
      velocityY = vy + Math.sin(perpAngle) * signedDist;
    }
  }
  await this.confirmMovement({
    fuelUsed: data.resources?.pilot?.fuelBurned ?? 0,
    newX, newY, newRotation,
    gridSquaresMoved: dist,
    waypoints,
    velocityX,
    velocityY,
  });
}

/**
 * Overcharge – Flip and Burn: rotate 180° in place, then burn sternward at half
 * effective speed. Requires ≥50% power remaining; consumes 50% power and one Core.
 */
export async function pilotFlipAndBurn(userId, halfSpeedUnits, newX, newY, newRotation, waypoints) {
  const consumed = await this.consumePilotCore(userId, "flipBurn");
  if (!consumed) return;
  const data       = this.getData();
  const fuelBurned = data.resources?.pilot?.fuelBurned ?? 0;
  const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";
  await this.confirmMovement({
    fuelUsed:         fuelBurned + 50,
    newX,
    newY,
    newRotation,
    gridSquaresMoved: halfSpeedUnits,
    waypoints,
    // In Realistic mode the burn fully arrests momentum (velocity → 0)
    velocityX: isRealistic ? 0 : undefined,
    velocityY: isRealistic ? 0 : undefined,
  });
}

/**
 * AP → Thrust: spend 1 Auxiliary Power to raise the helmsman's powerMax by powerPerAP %.
 * The bonus is stored as `resources.pilot.apThrustBonus` and cleared at round end.
 */
export async function apToThrust(userId) {
  const data = this.getData();
  const ap = data.resources?.engineer?.auxiliaryPower ?? 0;
  if (ap <= 0) return;

  const engine = this.ship?.items.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "engine");
  const powerPerAP = engine?.system?.powerPerAP ?? 0;
  if (powerPerAP <= 0) {
    return ui.notifications.warn("Engine has no Power Per AP rating configured.");
  }

  const current = data.resources?.pilot?.apThrustBonus ?? 0;
  await this.update({
    "resources.engineer.auxiliaryPower": Math.max(0, ap - 1),
    "resources.pilot.apThrustBonus": current + powerPerAP,
  });
}

/**
 * Confirm a helm movement segment. Updates fuel burned, drift accumulated, prevTurnMove, and token position.
 * In Realistic mode, also stores the new velocity vector.
 */
export async function confirmMovement({ fuelUsed, driftUsed = 0, speed, newX, newY, newRotation, gridSquaresMoved, waypoints, velocityX, velocityY, bearingDelta, momentumUsed }) {
  const data = this.getData();
  const effectiveSpeed = speed
    ?? (SystemAdapter.current.getShipData(this.ship)?.movement?.speed ?? 6) + (data.resources?.pilot?.allocSpeed ?? 0);
  const existingDrift  = data.resources?.pilot?.driftBurned ?? 0;
  const newDriftBurned = existingDrift + driftUsed;
  // prevTurnMove is NOT updated here — it is computed and set by resetHelmState at the
  // start of the next turn so that it remains stable (last-turn total) throughout the
  // current turn, even during piecemeal / fractional movement commits.
  const updates = {
    "resources.pilot.fuelBurned":  fuelUsed,
    "resources.pilot.driftBurned": newDriftBurned,
  };
  // Persist velocity vector when provided (Realistic mode)
  if (velocityX !== undefined && velocityY !== undefined) {
    updates["resources.pilot.velocityX"] = velocityX;
    updates["resources.pilot.velocityY"] = velocityY;
  }
  // Track bearing budget spent this turn (Realistic mode)
  if (bearingDelta !== undefined && bearingDelta > 0) {
    const existingBearingUsed = data.resources?.pilot?.bearingUsed ?? 0;
    updates["resources.pilot.bearingUsed"] = existingBearingUsed + bearingDelta;
  }
  // Track momentum carry committed this turn (Realistic mode)
  if (momentumUsed !== undefined) {
    updates["resources.pilot.momentumUsed"] = momentumUsed;
  }
  // Reset bearing to centre after each committed move
  updates["resources.pilot.bearing"] = 0;
  await this.update(updates);

  if (!waypoints?.length) {
    const token = this.ship?.getActiveTokens()?.[0];
    if (token) await token.document.update({ x: newX, y: newY, rotation: newRotation }, { animate: true });
  }
}

/**
 * Ram manoeuvre: arc the ship along a computed heading to impact a target.
 * Movement is committed identically to a normal helm confirmation, then damage
 * is applied to both ships (bypassing shields and armour), lockouts are set,
 * the rammed ship is displaced half a tile, and the ramming ship rotates ±20°.
 *
 * Damage formula:
 *   thrustFraction  = fuelUsed / powerMax  (capped at 1.0)
 *   angleModifier   = 0.5 + 0.5 × |sin(θ)|  where θ is impact angle from rammed ship's heading
 *                     → 1.0 at broadside, 0.5 at bow/stern
 *
 *   To rammed ship   = (max(1, ramming.armour.bow) + 0.1 × ramming.hull.max)
 *                      × thrustFraction × angleModifier × COEFF
 *   To ramming ship  = (max(1, rammed.armour[hitSector]) + 0.1 × rammed.hull.max)
 *                      × thrustFraction × 1.0 × COEFF
 *
 * Both sides bypass shields AND armour (direct hull damage).
 *
 * @param {string}   userId
 * @param {string}   targetTokenId   – id of the rammed token document
 * @param {number}   fuelUsed        – total fuel consumed this move
 * @param {number}   driftUsed       – drift units applied
 * @param {number}   speed           – effective speed (grid squares per 100% power)
 * @param {number}   newX            – ramming ship final canvas X
 * @param {number}   newY            – ramming ship final canvas Y
 * @param {number}   newRotation     – ramming ship final rotation
 * @param {object[]} waypoints       – animation path
 * @param {number}   attackAngle     – angle (radians) from ramming ship centre to rammed ship centre
 * @param {number}   powerMax        – maximum power for thrust-fraction calculation
 */
export async function pilotRam(
  userId, targetTokenId, fuelUsed, driftUsed, speed,
  newX, newY, newRotation, waypoints, attackAngle, powerMax,
  rammingActorId = null, maxBearingDeg = 30,
) {
  const RAM_COEFF = 2; // Tunable damage coefficient

  // ── Resolve the ramming actor ──────────────────────────────────────────────
  // If rammingActorId points to an NPC actor, operate on it directly.
  // If null (or the player ship), use the normal ShipCombatState path.
  const isNpcRam = rammingActorId && rammingActorId !== this.ship?.id;
  const rammingActor = isNpcRam
    ? (game.actors?.get(rammingActorId) ?? null)
    : this.ship;
  if (!rammingActor) return;

  // ── 1. Commit movement ─────────────────────────────────────────────────────
  if (isNpcRam) {
    // NPC path: update actor + token directly
    const effectiveSpeed = rammingActor.system?.resources?.pilot?.speed ?? speed;
    const prevTurnMove   = (fuelUsed / 100) * effectiveSpeed;
    await rammingActor.update({
      [SystemAdapter.current.systemPath("resources.pilot.fuelBurned")]:   fuelUsed,
      [SystemAdapter.current.systemPath("resources.pilot.prevTurnMove")]: prevTurnMove,
      [SystemAdapter.current.systemPath("resources.pilot.prowGunLocked")]:  true,
      [SystemAdapter.current.systemPath("resources.pilot.ramAllocLocked")]: true,
    });
    const npcToken = rammingActor.getActiveTokens?.()?.[0];
    if (npcToken) {
      await npcToken.document.update({ x: newX, y: newY, rotation: newRotation }, { animate: true });
    }
  } else {
    // Player ship path: delegate to ShipCombatState helpers
    await this.confirmMovement({ fuelUsed, driftUsed, speed, newX, newY, newRotation, waypoints });
    await this.update({
      "resources.pilot.prowGunLocked":  true,
      "resources.pilot.ramAllocLocked": true,
    });
  }

  // ── 3. Find rammed actor ───────────────────────────────────────────────────
  const rammingSys  = rammingActor.system;

  // Search canvas tokens first (scene-linked), then world actors as fallback
  let rammedToken = canvas?.tokens?.placeables?.find(t => t.id === targetTokenId)
    ?? canvas?.tokens?.placeables?.find(t => t.document?.id === targetTokenId);
  let rammedActor = rammedToken?.document?.actor ?? rammedToken?.actor;
  if (!rammedActor) {
    // Fallback: look in scene tokens
    const tokenDoc = canvas?.scene?.tokens?.find(t => t.id === targetTokenId);
    rammedActor = tokenDoc?.actor ?? null;
  }
  if (!rammedActor) {
    console.warn("SHIPCOMBAT | pilotRam: could not find rammed actor for token", targetTokenId);
    return;
  }
  const rammedSys = rammedActor.system;

  // ── 4. Compute thrust fraction ────────────────────────────────────────────
  const safeMax         = powerMax > 0 ? powerMax : 100;
  const thrustFraction  = Math.min(1, fuelUsed / safeMax);

  // ── 5. Angle modifier for rammed ship (from rammed ship's heading) ─────────
  // attackAngle: vector FROM ramming ship TO rammed ship (atan2)
  // incoming   : angle from rammed ship's bow to the impact vector
  const rammedRotation  = rammedToken?.document?.rotation ?? rammedActor.getActiveTokens?.()?.[0]?.document?.rotation ?? 0;
  const tgtHeadingRad   = (rammedRotation - 90) * (Math.PI / 180);
  let   incoming        = attackAngle - tgtHeadingRad + Math.PI;
  // Normalise to [−π, +π]
  while (incoming >  Math.PI) incoming -= 2 * Math.PI;
  while (incoming < -Math.PI) incoming += 2 * Math.PI;
  const angleModRammed  = 0.5 + 0.5 * Math.abs(Math.sin(incoming));

  // ── 6. Hit sector on rammed ship ───────────────────────────────────────────
  const hitSectorRammed = getHitQuadrant(rammedRotation, attackAngle);

  // ── 7. Damage TO rammed ship (uses RAMMING ship's stats) ──────────────────
  const rammingBowArmour = Math.max(1, rammingSys?.armour?.bow ?? 0);
  const rammingHullMax   = rammingSys?.hull?.max ?? 50;
  const rammingBase      = rammingBowArmour + 0.25 * rammingHullMax;
  const damageToRammed   = Math.max(1, Math.round(rammingBase * thrustFraction * angleModRammed * RAM_COEFF));

  // ── 8. Damage TO ramming ship (uses RAMMED ship's stats; bow armour soaks) ──
  const rammingTakesArmour  = Math.max(1, rammedSys?.armour?.[hitSectorRammed] ?? 0);
  const rammingTakesHullMax = rammedSys?.hull?.max ?? 50;
  const rammingBase2        = rammingTakesArmour + 0.25 * rammingTakesHullMax;
  const rawDamageToRamming  = Math.round(rammingBase2 * thrustFraction * 1.0 * RAM_COEFF);
  const damageToRamming     = Math.max(0, rawDamageToRamming - rammingBowArmour);

  // ── 9. Apply hull damage to rammed ship (bypasses shields and armour) ──────
  const rammedHullCur = rammedSys?.hull?.value ?? 0;
  const rammedHullMax = rammedSys?.hull?.max ?? 50;
  await rammedActor.update({
    [SystemAdapter.current.systemPath("hull.value")]: Math.min(rammedHullMax, rammedHullCur + damageToRammed),
  });

  // ── 10. Apply hull damage to ramming ship ─────────────────────────────────
  const rammingHullCur = rammingSys?.hull?.value ?? 0;
  await rammingActor.update({
    [SystemAdapter.current.systemPath("hull.value")]: Math.min(rammingHullMax, rammingHullCur + damageToRamming),
  });

  // ── 11. Crit rolls for both ships ─────────────────────────────────────────
  if (damageToRammed  > 0) await rollCrit.call(this, rammedActor,   damageToRammed,  false, 0);
  if (damageToRamming > 0) await rollCrit.call(this, rammingActor,  damageToRamming, false, 0);

  // ── 12. Displace rammed ship + velocity transfer ──────────────────────────
  const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";
  let rammingToken;

  if (isRealistic) {
    // Normal-projection 50/50 velocity split
    const nx = Math.cos(attackAngle);
    const ny = Math.sin(attackAngle);
    // Ramming ship velocity (post-thrust, stored by confirmMovement)
    const rvx = rammingActor.system?.resources?.pilot?.velocityX ?? 0;
    const rvy = rammingActor.system?.resources?.pilot?.velocityY ?? 0;
    const dot = rvx * nx + rvy * ny;
    const icx = dot * nx;  // impact component x
    const icy = dot * ny;  // impact component y
    // Ramming ship retains 20% of its total velocity (the rest is lost to the impact)
    const newRvx = rvx * 0.20;
    const newRvy = rvy * 0.20;
    // Rammed ship gains 50% of the ramming ship's velocity vector
    const tvx = rammedActor.system?.resources?.pilot?.velocityX ?? 0;
    const tvy = rammedActor.system?.resources?.pilot?.velocityY ?? 0;
    const newTvx = tvx + rvx * 0.50;
    const newTvy = tvy + rvy * 0.50;
    await rammingActor.update({
      [SystemAdapter.current.systemPath("resources.pilot.velocityX")]: newRvx,
      [SystemAdapter.current.systemPath("resources.pilot.velocityY")]: newRvy,
    });
    await rammedActor.update({
      [SystemAdapter.current.systemPath("resources.pilot.velocityX")]: newTvx,
      [SystemAdapter.current.systemPath("resources.pilot.velocityY")]: newTvy,
    });
    // Physical displacement: push rammed ship one full tile in impact direction
    if (rammedToken && canvas?.ready) {
      const gridSize  = canvas.grid.size;
      const displaceX = (rammedToken.document?.x ?? 0) + Math.cos(attackAngle) * gridSize;
      const displaceY = (rammedToken.document?.y ?? 0) + Math.sin(attackAngle) * gridSize;
      await rammedToken.document.update({ x: displaceX, y: displaceY }, { animate: true });
    }
    // ── 13. Final rotation: orthogonal to impact angle, clamped to bearing arc ──
    rammingToken = rammingActor?.getActiveTokens?.()?.[0];
    if (rammingToken && canvas?.ready) {
      const h0deg      = rammingToken.document.rotation ?? 0;
      const mano       = rammingActor.system?.movement?.maneuverability ?? 2;
      const allocMano  = rammingActor.system?.resources?.pilot?.allocMano ?? 0;
      // Cap at 20° – a meaningful orientation nudge toward orthogonal, not a full re-aim
      const maxBearing = Math.min(20, Math.max(0, mano + allocMano) * 15);
      const { HelmPreview } = await import("../canvas/HelmPreview.js").catch(() => ({ HelmPreview: null }));
      let newRot;
      if (HelmPreview) {
        newRot = HelmPreview.computeRamRotationRealistic(h0deg, attackAngle, maxBearing);
      } else {
        // Fallback: ±20° jitter
        const jitter = Math.random() * 40 - 20;
        newRot = ((h0deg + jitter) + 360) % 360;
      }
      await rammingToken.document.update({ rotation: newRot }, { animate: false });
    }
  } else {
    // ── 12. Simplified: displace rammed ship one full tile in the impact direction ──
    if (rammedToken && canvas?.ready) {
      const gridSize   = canvas.grid.size;
      const displaceX  = (rammedToken.document?.x ?? 0) + Math.cos(attackAngle) * gridSize;
      const displaceY  = (rammedToken.document?.y ?? 0) + Math.sin(attackAngle) * gridSize;
      await rammedToken.document.update({ x: displaceX, y: displaceY }, { animate: true });
    }

    // ── 13. Rotate ramming ship ±20° randomly ─────────────────────────────────
    rammingToken = rammingActor?.getActiveTokens?.()?.[0];
    if (rammingToken && canvas?.ready) {
      const jitter    = Math.random() * 40 - 20; // −20° to +20°
      const newRot    = ((rammingToken.document.rotation ?? 0) + jitter + 360) % 360;
      await rammingToken.document.update({ rotation: newRot }, { animate: false });
    }
  }

  // ── 14. Clear helm preview ghost ──────────────────────────────────────────
  const { HelmPreview: HP } = await import("../canvas/HelmPreview.js").catch(() => ({ HelmPreview: null }));
  if (HP) HP.hide();

  // ── 15. Chat message ───────────────────────────────────────────────────────
  const thrustPct = Math.round(thrustFraction * 100);
  const attackAngleDeg = Math.round(Math.abs(incoming) * (180 / Math.PI));
  const rammingName = rammingActor.name ?? "Unknown";
  const quadLabel   = hitSectorRammed.charAt(0).toUpperCase() + hitSectorRammed.slice(1);
  const ramDmgType  = SystemAdapter.current.getRamDamageType();
  const dmgTypeSuffix = ramDmgType ? ` ${ramDmgType}` : "";
  const chatContent = `
    <div class="shipcombat-ram-chat">
      <div class="shipcombat-ram-chat-header">
        <i class="fa-solid fa-burst" style="color:#ff6b6b"></i>
        <strong>${game.i18n.format("SHIPCOMBAT.Ram.ChatTitle", { name: rammingName })}</strong>
      </div>
      <p>${game.i18n.format("SHIPCOMBAT.Ram.ChatPublic", {
        attacker: rammingName,
        target:   rammedActor.name ?? "Unknown",
        sector:   game.i18n.localize(`SHIPCOMBAT.Sector.${quadLabel}`),
        thrust:   thrustPct,
      })}</p>
      <p style="font-size:0.85em;color:#e8a87c"><i class="fa-solid fa-ban"></i> ${game.i18n.localize("SHIPCOMBAT.Ram.ChatLockouts")}</p>
      <hr style="border-color:#444;margin:0.4em 0">
      <strong style="font-size:0.9em">${game.i18n.localize("SHIPCOMBAT.Ram.ChatDamageTitle")}</strong>
      <table class="shipcombat-ram-dmg-table">
        <tr><td>${rammingName}</td><td style="color:#ff6b6b">${damageToRamming}${dmgTypeSuffix} hull damage</td></tr>
        <tr><td>${rammedActor.name}</td><td style="color:#ff6b6b">${damageToRammed}${dmgTypeSuffix} hull damage</td></tr>
      </table>
      <p style="font-size:0.85em;color:#888">${game.i18n.format("SHIPCOMBAT.Ram.ChatDamageNote", { thrust: thrustPct, angle: attackAngleDeg, sector: game.i18n.localize(`SHIPCOMBAT.Sector.${quadLabel}`) })}</p>
    </div>`;

  await ChatMessage.create({
    content: chatContent,
    speaker: { alias: rammingName },
  });
}
