/**
 * ordnance-state.js – Ordnance token spawning and management extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID } from "../constants.js";
import { isTorpedo, ordnanceTypeName } from "../actors/ordnance/ordnance-types.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getOrdnanceControllerUserId } from "../roles/crew-operators.js";

/**
 * Spawn a torpedo or strike craft token near the ship.
 * If the ship has an ordnance actor template assigned, clone its data.
 * GM-only  -  called via socket from the OM's launch actions.
 */
export async function spawnOrdnance({ type, parentShipTokenId, x, y, rotation, templateId, forcedHull }) {
  if (!game.user.isGM) return;

  // The unified shipOrdnance type is used for new spawns.  Legacy torpedo
  // and strikeCraft template actors are also accepted (migration converts them).
  const unifiedType = ordnanceTypeName();
  const subtype = type === "strikeCraft" ? "strikeCraft" : "torpedo";
  const slotKey = type === "strikeCraft" ? "strikeCraft" : "torpedo";
  const defaultName = type === "strikeCraft" ? "Strike Craft" : "Torpedo";

  // ── Try to clone from the ship's embedded ordnance actor template ──
  const shipToken = canvas?.scene?.tokens.get(parentShipTokenId);
  const shipActor = shipToken?.actor;
  const templates = SystemAdapter.current.getShipData(shipActor)?.ordnanceActors?.[slotKey] ?? [];
  // Use the specified template if provided, otherwise fall back to the first
  const templateRef = (templateId ? templates.find(t => t.id === templateId) : null) ?? templates[0];

  // Look up salvo/flight size from weapons bay component (can be overridden by caller)
  let hullOverride = forcedHull ?? 1;
  if (!forcedHull && shipActor) {
    const bay = shipActor.items.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "weaponsBay");
    if (type === "torpedo") {
      hullOverride = bay?.system?.bayTorpedoSalvoSize ?? 1;
    } else if (type === "strikeCraft") {
      hullOverride = bay?.system?.bayStrikeCraftFlightSize ?? 1;
    }
  }

  const hullInitVal = SystemAdapter.current.hullDisplayMode === "hpRemaining" ? hullOverride : 0;

  let actorData;
  if (templateRef?.actorData) {
    // Inline embedded data  -  use directly (no external actor needed)
    actorData = foundry.utils.deepClone(templateRef.actorData);
    actorData._id = undefined;
    actorData.flags = foundry.utils.mergeObject(actorData.flags ?? {}, {
      [MODULE_ID]: { fromOrdnanceMaster: true },
    });
    actorData.system.parentShipTokenId = parentShipTokenId;
    actorData.system.turnComplete = type !== "strikeCraft";  // craft can manoeuvre on launch turn
    actorData.system.hull = { value: hullInitVal, max: hullOverride };
  } else if (templateRef?.uuid) {
    // Legacy UUID reference  -  fetch from world actors
    let templateActor = null;
    try { templateActor = await fromUuid(templateRef.uuid); } catch { /* not found */ }
    if (templateActor) {
      actorData = templateActor.toObject();
      actorData._id = undefined;
      actorData.flags = foundry.utils.mergeObject(actorData.flags ?? {}, {
        [MODULE_ID]: { fromOrdnanceMaster: true },
      });
      actorData.system.parentShipTokenId = parentShipTokenId;
      actorData.system.turnComplete = type !== "strikeCraft";
      actorData.system.hull = { value: hullInitVal, max: hullOverride };
    } else {
      actorData = {
        name: defaultName,
        type: unifiedType,
        flags: { [MODULE_ID]: { fromOrdnanceMaster: true } },
        system: { subtype, parentShipTokenId, hull: { value: hullInitVal, max: hullOverride } },
      };
    }
  } else {
    actorData = {
      name: defaultName,
      type: unifiedType,
      flags: { [MODULE_ID]: { fromOrdnanceMaster: true } },
      system: { subtype, parentShipTokenId, hull: { value: hullInitVal, max: hullOverride } },
    };
  }

  // ── Guard: launch with a full tank and magazine ──────────────────────────
  // Fuel/ammo are cloned straight from the template's saved state. A template
  // may have its current value below max — e.g. a GM sets 0/5 by mistake, or
  // the template actor was edited mid-combat — but a freshly launched torpedo
  // or strike craft should always start full. Clamp each resource's value up
  // to its own max. (Absent on the no-template fallback, where schema defaults
  // of 0/0 apply and there is nothing to clamp.)
  for (const res of ["fuel", "ammo"]) {
    const r = actorData.system?.[res];
    if (r && typeof r.max === "number") r.value = r.max;
  }

  // ── Set actor ownership so the controlling player can move the token ──
  // Launching and controlling are separate duties (see README_3–6):
  //   6-man: the Ordnance Master controls both types.
  //   5-man: the Captain launches both, but torpedoes are steered by the
  //          Gunner; strike craft stay with the Captain.
  //   ≤4-man: the Gunner absorbs the ordnance station and controls both.
  const stateData = (shipActor ? SystemAdapter.current.getShipData(shipActor) : null) ?? this.getData?.() ?? {};
  const controllerUserId = getOrdnanceControllerUserId(stateData, subtype);
  if (controllerUserId) {
    actorData.ownership = foundry.utils.mergeObject(
      actorData.ownership ?? { default: 0 },
      { [controllerUserId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    );
  }

  // In realistic mode, seed initial velocity: half own speed (in launch heading) + ship velocity.
  if (game.settings?.get(MODULE_ID, "movementMode") === "realistic") {
    const shipPilot  = SystemAdapter.current.getShipData(shipActor)?.resources?.pilot ?? {};
    const shipVx     = shipPilot.velocityX ?? 0;
    const shipVy     = shipPilot.velocityY ?? 0;
    const ownSpeed   = actorData.system?.movement?.speed ?? 0;
    const headingRad = (rotation + 90) * (Math.PI / 180);
    foundry.utils.setProperty(actorData, "system.helm.velocityX", shipVx + Math.cos(headingRad) * (ownSpeed / 2));
    foundry.utils.setProperty(actorData, "system.helm.velocityY", shipVy + Math.sin(headingRad) * (ownSpeed / 2));
  }

  const actor = await Actor.create(actorData).catch(err => {
    console.error(`${MODULE_ID} | spawnOrdnance: Actor.create failed`, err, actorData);
    ui.notifications?.error(`Ordnance launch failed: ${err.message ?? err}`);
    return null;
  });
  if (!actor) {
    console.warn(`${MODULE_ID} | spawnOrdnance: aborting after Actor.create returned null`, {
      type, subtype, unifiedType, templateId, parentShipTokenId, actorDataType: actorData?.type, actorDataSubtype: actorData?.system?.subtype,
    });
    return;
  }
  if (canvas?.scene) {
    try {
      const tokenOverrides = { x, y, rotation, hidden: false, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL };
      tokenOverrides.width = 0.5;
      tokenOverrides.height = 0.5;
      // Restore custom token texture. Priority:
      //   1. templateRef.tokenImg — stored explicitly at registration, survives normalisation
      //   2. actorData.prototypeToken.texture.src — serialised actor data (may be normalised)
      const _origTextureSrc = templateRef?.tokenImg ?? actorData?.prototypeToken?.texture?.src;
      if (_origTextureSrc) tokenOverrides.texture = { src: _origTextureSrc };
      const tokenData = await actor.getTokenDocument(tokenOverrides);
      await canvas.scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
    } catch (err) {
      console.error(`${MODULE_ID} | spawnOrdnance: token creation failed`, err);
      ui.notifications?.error(`Ordnance token creation failed: ${err.message ?? err}`);
    }
  }

  // Re-render any open ship sheets so Deployed Ordnance updates immediately
  if (shipActor?.sheet?.rendered) {
    shipActor.sheet.render();
  }
}

export async function deleteOrdnanceTokens(tokenIds = []) {
  if (!game.user.isGM || !canvas?.scene) return { tokensDeleted: 0, actorsDeleted: 0 };

  const tokenDocs = [...new Set(tokenIds)]
    .map(tokenId => canvas.scene.tokens.get(tokenId))
    .filter(Boolean);
  const generatedActorIds = new Set(tokenDocs
    .map(tokenDoc => tokenDoc.actorId)
    .filter(actorId => game.actors.get(actorId)?.getFlag(MODULE_ID, "fromOrdnanceMaster")));

  if (tokenDocs.length > 0) {
    await canvas.scene.deleteEmbeddedDocuments("Token", tokenDocs.map(tokenDoc => tokenDoc.id));
  }

  let actorsDeleted = 0;
  for (const actorId of generatedActorIds) {
    const stillDeployed = canvas.scene.tokens.some(tokenDoc => tokenDoc.actorId === actorId);
    const actor = game.actors.get(actorId);
    if (!stillDeployed && actor) {
      await actor.delete();
      actorsDeleted += 1;
    }
  }

  return { tokensDeleted: tokenDocs.length, actorsDeleted };
}

/**
 * Set the RTB flag on a deployed ordnance token.
 */
export async function setOrdnanceRtb(tokenId, rtb) {
  if (!game.user.isGM || !canvas?.scene) return;
  const td = canvas.scene.tokens.get(tokenId);
  if (!td?.actor) return;
  await td.actor.update({ [SystemAdapter.current.systemPath("rtb")]: !!rtb });
}

/**
 * Set the turnComplete flag on a deployed ordnance token.
 */
export async function setOrdnanceTurnDone(tokenId, done) {
  if (!game.user.isGM || !canvas?.scene) return;
  const td = canvas.scene.tokens.get(tokenId);
  if (!td?.actor) return;
  await td.actor.update({ [SystemAdapter.current.systemPath("turnComplete")]: !!done });
}

/**
 * Designate a hostile torpedo: locks helm controls for this round.
 * Sets designated=true (powerMax→0, maneuverability→0, detonate disabled).
 * The torpedo still auto-drifts its minimum distance in advanceRound.
 */
export async function designateHostileTorpedo(tokenId) {
  if (!game.user.isGM || !canvas?.scene) return;
  const td = canvas.scene.tokens.get(tokenId);
  if (!td?.actor || !isTorpedo(td.actor)) return false;
  const parentShipTokenId = SystemAdapter.current.getShipData(td.actor)?.parentShipTokenId;
  const ownTokenIds = new Set((this.ship?.getActiveTokens?.() ?? []).map(token => token.id));
  if (parentShipTokenId && ownTokenIds.has(parentShipTokenId)) return false;
  const shipToken = this.ship?.getActiveTokens?.()?.[0];
  if (!shipToken) return false;
  const gridSize = canvas.grid.size;
  const shipX = shipToken.document.x + (shipToken.document.width * gridSize) / 2;
  const shipY = shipToken.document.y + (shipToken.document.height * gridSize) / 2;
  const targetX = td.x + (td.width * gridSize) / 2;
  const targetY = td.y + (td.height * gridSize) / 2;
  const distance = Math.hypot(targetX - shipX, targetY - shipY) / gridSize;
  if (this.getEffectiveLockTier(tokenId, distance) < 1) return false;
  await td.actor.update({ [SystemAdapter.current.systemPath("designated")]: true });
  return true;
}

/**
 * Set the powerBoostActive flag on an allied torpedo, doubling its power
 * maximum (100 → 200) so it can commit up to 200% thrust this turn.
 */
export async function torpedoPowerBoost(tokenId) {
  if (!game.user.isGM || !canvas?.scene) return;
  const td = canvas.scene.tokens.get(tokenId);
  if (!td?.actor) return;
  await td.actor.update({ [SystemAdapter.current.systemPath("powerBoostActive")]: true });
}

/**
 * Blast ordnance caught in a torpedo's detonation radius.
 * Destroys torpedoes immediately; applies hull damage to strike craft (deletes if hull maxed).
 * GM-only.
 */
export async function blastOrdnance({ torpedoTokenIds, craftDamages, torName } = {}) {
  if (!game.user.isGM || !canvas?.scene) return;

  // Destroy torpedoes caught in the blast
  const torpsToDelete = (torpedoTokenIds ?? []).filter(id => canvas.scene.tokens.get(id));
  if (torpsToDelete.length > 0) {
    await deleteOrdnanceTokens(torpsToDelete);
    await ChatMessage.create({
      content: `<b>${torName ?? "Torpedo"}</b> detonation destroyed ${torpsToDelete.length} torpedo(es) in the blast radius.`,
    });
  }

  // Apply hull damage to strike craft in the blast
  const craftDestroyed = [];
  for (const { tokenId, damage } of (craftDamages ?? [])) {
    const td = canvas.scene.tokens.get(tokenId);
    if (!td?.actor) continue;
    const hull        = td.actor.system.hull ?? { value: 0, max: 1 };
    const _isHP       = SystemAdapter.current.hullDisplayMode === "hpRemaining";
    const newValue    = _isHP
      ? Math.max(0, (hull.value ?? 0) - damage)
      : Math.min(hull.max, (hull.value ?? 0) + damage);
    await td.actor.update({ [SystemAdapter.current.systemPath("hull.value")]: newValue });
    const isDestroyed = _isHP ? newValue <= 0 : newValue >= hull.max;
    if (isDestroyed) craftDestroyed.push(tokenId);
  }
  if (craftDestroyed.length > 0) {
    await deleteOrdnanceTokens(craftDestroyed);
    await ChatMessage.create({
      content: `<b>${torName ?? "Torpedo"}</b> detonation destroyed ${craftDestroyed.length} strike craft flight(s).`,
    });
  }
}
