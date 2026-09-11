/**
 * ordnance-state.js – Ordnance token spawning and management extracted from ShipCombatState.
 *
 * Every exported function is attached as a static method on ShipCombatState.
 * Inside each function, `this` refers to the ShipCombatState class itself.
 */

import { MODULE_ID, ORDNANCE_4MAN_COSTS, ORDNANCE_MASTER_ACTIONS } from "../constants.js";
import { isStrikeCraft, isTorpedo, ordnanceTypeName } from "../actors/ordnance/ordnance-types.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getOrdnanceControllerUserId } from "../roles/crew-operators.js";
import { canSetOrdnanceTurnDone, getOrdnanceLaunchTurnState } from "./ordnance-turn-state.js";

const destroyingOrdnanceTokenIds = new Set();

const LAUNCH_REQUEST_SHAPES = {
  launchTorpedo:  ["torpedo"],
  torpedoSalvo:   ["torpedo", "torpedo"],
  emergencyLaunch: ["torpedo"],
  launchCraft:    ["strikeCraft"],
};

async function _cleanupFailedSpawn(actor) {
  if (!actor) return;
  const tokenIds = canvas?.scene?.tokens
    ?.filter(tokenDoc => tokenDoc.actorId === actor.id)
    .map(tokenDoc => tokenDoc.id) ?? [];
  if (tokenIds.length > 0) {
    await deleteOrdnanceTokens(tokenIds, { suppressDestroyTracking: true });
    return;
  }
  const generatedActor = game.actors.get(actor.id);
  if (generatedActor) await generatedActor.delete();
}

async function _cleanupProvisionalTokens(tokenIds) {
  if (tokenIds.length === 0) return true;
  try {
    const result = await deleteOrdnanceTokens(tokenIds, { suppressDestroyTracking: true });
    return (result?.tokensDeleted ?? 0) === tokenIds.length;
  } catch (error) {
    console.error(`${MODULE_ID} | Provisional ordnance cleanup failed`, error);
    return false;
  }
}

/**
 * Validate, spawn, and commit a player-ship launch in one GM-side request.
 * The allocation queue covers both the authoritative resource check and the
 * compensating cleanup, so a dropped client response cannot split the action.
 */
export async function executeOrdnanceLaunch({ actionId, spawnRequests = [] } = {}) {
  if (!game.user.isGM || !canvas?.scene) return { ok: false, reason: "notGM" };
  const ship = this.ship;
  const entry = ORDNANCE_MASTER_ACTIONS[actionId];
  const expectedTypes = LAUNCH_REQUEST_SHAPES[actionId];
  if (!ship || !entry || !expectedTypes || !Array.isArray(spawnRequests)
    || spawnRequests.length !== expectedTypes.length) {
    return { ok: false, reason: "invalidLaunch" };
  }

  return this.withAllocationTransaction(async () => {
    const validRequests = spawnRequests.every((request, index) => {
      const parentToken = request?.parentShipTokenId
        ? canvas.scene.tokens.get(request.parentShipTokenId)
        : null;
      return request?.type === expectedTypes[index] && parentToken?.actorId === ship.id;
    });
    if (!validRequests) return { ok: false, reason: "invalidLaunch" };

    const data = SystemAdapter.current.getShipData(ship) ?? {};
    const ordnance = data.resources?.ordnance ?? {};
    if (data.resources?.pilot?.prowGunLocked) {
      return { ok: false, reason: "prowGunLocked" };
    }
    const configuredTemplates = {
      torpedo: data.ordnanceActors?.torpedo ?? [],
      strikeCraft: data.ordnanceActors?.strikeCraft ?? [],
    };
    const activeTemplateIds = {
      torpedo: new Set((data.activeOrdnance ?? [])
        .filter(entry => entry?.type === "torpedo")
        .map(entry => entry.actorId)),
      strikeCraft: new Set((data.activeOrdnance ?? [])
        .filter(entry => entry?.type === "strikeCraft")
        .map(entry => entry.actorId)),
    };
    const hasConfiguredTemplates = spawnRequests.every(request => request.templateId
      && activeTemplateIds[request.type].has(request.templateId)
      && configuredTemplates[request.type].some(template => template?.id === request.templateId));
    if (!hasConfiguredTemplates) return { ok: false, reason: "invalidTemplate" };

    const override = (data.crewSize ?? 6) <= 4 ? ORDNANCE_4MAN_COSTS[actionId] : null;
    const crewCost = Math.max(2, (override?.crew ?? entry.crew) - Math.max(0, ordnance.allocEfficiency ?? 0));
    const duration = Math.max(1, (override?.duration ?? entry.duration) - Math.max(0, ordnance.allocExpedience ?? 0));
    const manpower = ordnance.manpower ?? 0;
    if (manpower < crewCost) {
      return { ok: false, reason: "insufficientCrew", need: crewCost, have: manpower };
    }
    if (["launchTorpedo", "torpedoSalvo"].includes(actionId) && (ordnance.armedTorpedoes ?? 0) < 1) {
      return { ok: false, reason: "noArmedTorpedoes" };
    }
    if (actionId === "launchCraft") {
      if ((ordnance.armedCraft ?? 0) < 1) return { ok: false, reason: "noArmedCraft" };
      const shipTokenIds = new Set((ship.getActiveTokens?.() ?? []).map(token => token.id));
      const deployedCraftCount = canvas.scene.tokens.filter(tokenDoc => {
        if (!isStrikeCraft(tokenDoc.actor)) return false;
        const parentTokenId = SystemAdapter.current.getShipData(tokenDoc.actor)?.parentShipTokenId;
        return shipTokenIds.has(parentTokenId);
      }).length;
      const bayStats = this.getOrdnanceBayStats(ship);
      if (deployedCraftCount >= (bayStats.maxFlights ?? 2)
        || deployedCraftCount + (ordnance.craftDestroyed ?? 0) >= (bayStats.strikeCraftCapacity ?? 6)) {
        return { ok: false, reason: "flightCapacityReached" };
      }
    }

    const spawnedTokenIds = [];
    for (const request of spawnRequests) {
      let spawned;
      try {
        spawned = await spawnOrdnance.call(this, request);
      } catch (error) {
        console.error(`${MODULE_ID} | Ordnance launch spawn failed`, error);
      }
      if (!spawned?.ok) {
        const rolledBack = await _cleanupProvisionalTokens(spawnedTokenIds);
        return { ok: false, reason: rolledBack ? "spawnFailed" : "rollbackFailed" };
      }
      spawnedTokenIds.push(...(spawned.tokenIds ?? []));
    }

    const commitments = [...(ordnance.commitments ?? []), {
      id: foundry.utils.randomID(),
      action: actionId,
      crewCount: crewCost,
      turnsRemaining: duration,
      addedRound: data.round ?? 0,
    }];
    const updates = {
      "resources.ordnance.manpower": manpower - crewCost,
      "resources.ordnance.commitments": commitments,
    };
    if (["launchTorpedo", "torpedoSalvo"].includes(actionId)) {
      updates["resources.ordnance.armedTorpedoes"] = ordnance.armedTorpedoes - 1;
    }
    if (actionId === "launchCraft") {
      updates["resources.ordnance.armedCraft"] = ordnance.armedCraft - 1;
    }

    try {
      await this.update(updates, ship);
    } catch (error) {
      console.error(`${MODULE_ID} | Ordnance launch commitment failed`, error);
      const rolledBack = await _cleanupProvisionalTokens(spawnedTokenIds);
      return { ok: false, reason: rolledBack ? "commitFailed" : "rollbackFailed" };
    }
    return { ok: true, crewCost, duration, tokenIds: spawnedTokenIds };
  }, ship);
}

/** Reserve a recall and remove its craft as one compensating GM workflow. */
export async function executeCraftRecovery({ tokenId } = {}) {
  if (!game.user.isGM || !canvas?.scene) return { ok: false, reason: "notGM" };
  const ship = this.ship;
  if (!ship || !tokenId) return { ok: false, reason: "invalidRecovery" };

  return this.withAllocationTransaction(async () => {
    const tokenDoc = canvas.scene.tokens.get(tokenId);
    const craft = tokenDoc?.actor;
    const parentTokenId = SystemAdapter.current.getShipData(craft)?.parentShipTokenId;
    const parentToken = parentTokenId ? canvas.scene.tokens.get(parentTokenId) : null;
    const shipToken = ship.getActiveTokens?.()?.find(token => token.id === parentTokenId) ?? null;
    if (!craft || !isStrikeCraft(craft) || parentToken?.actorId !== ship.id || !shipToken) {
      return { ok: false, reason: "invalidRecovery" };
    }

    const gridSize = canvas.grid?.size ?? 0;
    if (!gridSize) return { ok: false, reason: "invalidRecovery" };
    const shipX = shipToken.center?.x ?? (shipToken.x + (shipToken.document.width ?? 1) * gridSize / 2);
    const shipY = shipToken.center?.y ?? (shipToken.y + (shipToken.document.height ?? 1) * gridSize / 2);
    const craftX = (tokenDoc.x ?? 0) + (tokenDoc.width ?? 1) * gridSize / 2;
    const craftY = (tokenDoc.y ?? 0) + (tokenDoc.height ?? 1) * gridSize / 2;
    if (Math.hypot(craftX - shipX, craftY - shipY) / gridSize > 3) {
      return { ok: false, reason: "outOfRange" };
    }

    const data = SystemAdapter.current.getShipData(ship) ?? {};
    const ordnance = data.resources?.ordnance ?? {};
    const entry = ORDNANCE_MASTER_ACTIONS.recallCraft;
    const override = (data.crewSize ?? 6) <= 4 ? ORDNANCE_4MAN_COSTS.recallCraft : null;
    const crewCost = Math.max(2, (override?.crew ?? entry.crew) - Math.max(0, ordnance.allocEfficiency ?? 0));
    const duration = Math.max(1, (override?.duration ?? entry.duration) - Math.max(0, ordnance.allocExpedience ?? 0));
    const manpower = ordnance.manpower ?? 0;
    if (manpower < crewCost) {
      return { ok: false, reason: "insufficientCrew", need: crewCost, have: manpower };
    }

    const priorCommitments = [...(ordnance.commitments ?? [])];
    const commitments = [...priorCommitments, {
      id: foundry.utils.randomID(),
      action: "recallCraft",
      crewCount: crewCost,
      turnsRemaining: duration,
      addedRound: data.round ?? 0,
    }];
    const priorRecovering = ordnance.craftRecovering ?? 0;
    await this.update({
      "resources.ordnance.manpower": manpower - crewCost,
      "resources.ordnance.commitments": commitments,
      "resources.ordnance.craftRecovering": priorRecovering + 1,
    }, ship);

    try {
      const deleted = await deleteOrdnanceTokens([tokenId], { suppressDestroyTracking: true });
      if ((deleted?.tokensDeleted ?? 0) !== 1) throw new Error("Recovered craft token was not deleted");
      return { ok: true, crewCost, duration, warning: deleted.actorCleanupFailed ? "actorCleanupFailed" : null };
    } catch (error) {
      console.error(`${MODULE_ID} | Craft recovery deletion failed; rolling back reservation`, error);
      try {
        await this.update({
          "resources.ordnance.manpower": manpower,
          "resources.ordnance.commitments": priorCommitments,
          "resources.ordnance.craftRecovering": priorRecovering,
        }, ship);
        return { ok: false, reason: "deletionFailed", rolledBack: true };
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Craft recovery rollback failed`, rollbackError);
        return { ok: false, reason: "rollbackFailed", rolledBack: false };
      }
    }
  }, ship);
}

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

  // Apply launch-turn state once after every construction path, including the
  // no-template fallback. Torpedoes remain locked until lifecycle processing
  // performs their mandatory launch drift; strike craft can act immediately.
  Object.assign(actorData.system, getOrdnanceLaunchTurnState(subtype));

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
    return { ok: false, reason: "actorCreateFailed" };
  }
  if (!canvas?.scene) {
    await _cleanupFailedSpawn(actor);
    return { ok: false, reason: "noScene" };
  }

  let createdTokens;
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
    createdTokens = await canvas.scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
    if (createdTokens.length !== 1) {
      throw new Error(`Expected one created token, received ${createdTokens.length}`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | spawnOrdnance: token creation failed`, err);
    ui.notifications?.error(`Ordnance token creation failed: ${err.message ?? err}`);
    try {
      await _cleanupFailedSpawn(actor);
    } catch (cleanupError) {
      console.error(`${MODULE_ID} | spawnOrdnance: failed-spawn cleanup also failed`, cleanupError);
    }
    return { ok: false, reason: "tokenCreateFailed" };
  }

  // Re-render any open ship sheets so Deployed Ordnance updates immediately
  if (shipActor?.sheet?.rendered) {
    try {
      shipActor.sheet.render();
    } catch (error) {
      console.error(`${MODULE_ID} | spawnOrdnance: parent-sheet refresh failed`, error);
    }
  }
  return {
    ok: true,
    actorId: actor.id,
    tokenIds: createdTokens.map(tokenDoc => tokenDoc.id),
  };
}

export async function deleteOrdnanceTokens(tokenIds = [], { suppressDestroyTracking = false } = {}) {
  if (!game.user.isGM || !canvas?.scene) return { tokensDeleted: 0, actorsDeleted: 0 };

  const tokenDocs = [...new Set(tokenIds)]
    .map(tokenId => canvas.scene.tokens.get(tokenId))
    .filter(Boolean);
  const generatedActorIds = new Set(tokenDocs
    .map(tokenDoc => tokenDoc.actorId)
    .filter(actorId => game.actors.get(actorId)?.getFlag(MODULE_ID, "fromOrdnanceMaster")));

  if (tokenDocs.length > 0) {
    await canvas.scene.deleteEmbeddedDocuments(
      "Token",
      tokenDocs.map(tokenDoc => tokenDoc.id),
      {
        shipCombatSuppressDestroyTracking: suppressDestroyTracking,
        shipCombatHandlesActorCleanup: true,
      },
    );
  }

  let actorsDeleted = 0;
  let actorCleanupFailed = 0;
  for (const actorId of generatedActorIds) {
    const stillDeployed = canvas.scene.tokens.some(tokenDoc => tokenDoc.actorId === actorId);
    const actor = game.actors.get(actorId);
    if (!stillDeployed && actor) {
      try {
        await actor.delete();
        actorsDeleted += 1;
      } catch (error) {
        actorCleanupFailed += 1;
        console.error(`${MODULE_ID} | Failed to clean up generated ordnance Actor`, error);
      }
    }
  }

  return { tokensDeleted: tokenDocs.length, actorsDeleted, actorCleanupFailed };
}

/** Destroy ordnance after playing its destruction animation. */
export async function destroyOrdnanceTokens(tokenIds = []) {
  if (!game.user.isGM || !canvas?.scene) return { tokensDeleted: 0, actorsDeleted: 0 };

  const tokenDocs = [...new Set(tokenIds)]
    .filter(tokenId => !destroyingOrdnanceTokenIds.has(tokenId))
    .map(tokenId => canvas.scene.tokens.get(tokenId))
    .filter(Boolean);
  if (tokenDocs.length === 0) return { tokensDeleted: 0, actorsDeleted: 0 };

  for (const tokenDoc of tokenDocs) destroyingOrdnanceTokenIds.add(tokenDoc.id);
  try {
    if (tokenDocs.length > 0) {
      const { emitToAll } = await import("../socket.js");
      for (const tokenDoc of tokenDocs) {
        const sys = SystemAdapter.current.getShipData(tokenDoc.actor) ?? {};
        const torpedo = isTorpedo(tokenDoc.actor);
        emitToAll("playWeaponAnimation", {
          weaponCategory: torpedo ? "torpedo_detonation" : "strike_craft_destruction",
          fireMode: "",
          firingActorId: null,
          targetTokenId: tokenDoc.id,
          totalHits: 1,
          totalSalvo: 1,
          isNpcFire: false,
          blastRadius: torpedo ? (sys.payloadRadius ?? 1) : null,
        });
        if (tokenDoc.object?._animation) {
          await CanvasAnimation.terminateAnimation(tokenDoc.object._animation);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return await deleteOrdnanceTokens(tokenDocs.map(tokenDoc => tokenDoc.id));
  } finally {
    for (const tokenDoc of tokenDocs) destroyingOrdnanceTokenIds.delete(tokenDoc.id);
  }
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
  if (!game.user.isGM || !canvas?.scene) return false;
  const td = canvas.scene.tokens.get(tokenId);
  if (!td?.actor) return false;
  const ordnanceData = {
    ...(SystemAdapter.current.getShipData(td.actor) ?? {}),
    subtype: isTorpedo(td.actor) ? "torpedo" : "strikeCraft",
  };
  if (!canSetOrdnanceTurnDone(ordnanceData, done)) return false;
  await td.actor.update({ [SystemAdapter.current.systemPath("turnComplete")]: !!done });
  return true;
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
  if (!game.user.isGM || !canvas?.scene) return false;
  const td = canvas.scene.tokens.get(tokenId);
  if (!td?.actor || !isTorpedo(td.actor)) return false;
  const parentShipTokenId = SystemAdapter.current.getShipData(td.actor)?.parentShipTokenId;
  const ownTokenIds = new Set((this.ship?.getActiveTokens?.() ?? []).map(token => token.id));
  if (!parentShipTokenId || !ownTokenIds.has(parentShipTokenId)) return false;
  await td.actor.update({ [SystemAdapter.current.systemPath("powerBoostActive")]: true });
  return true;
}

/**
 * Blast ordnance caught in a torpedo's detonation radius.
 * Destroys torpedoes immediately; applies hull damage to strike craft (deletes if hull maxed).
 * GM-only.
 */
export async function blastOrdnance({ torpedoTokenIds, craftDamages, torName, detonationId = null } = {}) {
  if (!game.user.isGM || !canvas?.scene) return { ok: false, reason: "notGM" };

  const postResultChat = async content => {
    try {
      await ChatMessage.create({ content });
    } catch (error) {
      console.error(`${MODULE_ID} | Ordnance blast chat failed after resolution committed`, error);
    }
  };

  // Destroy torpedoes caught in the blast
  const torpsToDelete = (torpedoTokenIds ?? []).filter(id => canvas.scene.tokens.get(id));
  if (torpsToDelete.length > 0) {
    const deleted = await destroyOrdnanceTokens(torpsToDelete);
    if ((deleted?.tokensDeleted ?? 0) !== torpsToDelete.length) {
      return { ok: false, reason: "torpedoDestructionFailed" };
    }
    await postResultChat(`<b>${torName ?? "Torpedo"}</b> detonation destroyed ${torpsToDelete.length} torpedo(es) in the blast radius.`);
  }

  // Apply hull damage to strike craft in the blast
  const craftDestroyed = [];
  for (const { tokenId, damage, diceCount, diceSize, warheadCount = 1, damageMultiplier = 1 } of (craftDamages ?? [])) {
    const td = canvas.scene.tokens.get(tokenId);
    if (!td?.actor) continue;
    const isDestroyed = await this.withActorActionTransaction(td.actor, async () => {
      const resolutionId = detonationId ? `${detonationId}:${tokenId}` : null;
      const resolvedIds = td.actor.getFlag(MODULE_ID, "resolvedDetonationIds") ?? [];
      if (resolutionId && resolvedIds.includes(resolutionId)) {
        const hull = SystemAdapter.current.getShipData(td.actor)?.hull ?? { value: 0, max: 1 };
        return SystemAdapter.current.hullDisplayMode === "hpRemaining"
          ? (hull.value ?? 0) <= 0
          : (hull.value ?? 0) >= hull.max;
      }
      let resolvedDamage = damage;
      if (diceCount && diceSize && warheadCount > 0) {
        const damageRoll = await new Roll(`${diceCount * warheadCount}${diceSize}`).evaluate();
        if (game.dice3d) game.dice3d.showForRoll(damageRoll, game.user, true);
        resolvedDamage = Math.max(0, Math.round(damageRoll.total * damageMultiplier));
      }
      const hull = SystemAdapter.current.getShipData(td.actor)?.hull ?? { value: 0, max: 1 };
      const isHP = SystemAdapter.current.hullDisplayMode === "hpRemaining";
      const newValue = isHP
        ? Math.max(0, (hull.value ?? 0) - resolvedDamage)
        : Math.min(hull.max, (hull.value ?? 0) + resolvedDamage);
      const updates = { [SystemAdapter.current.systemPath("hull.value")]: newValue };
      if (resolutionId) {
        updates[`flags.${MODULE_ID}.resolvedDetonationIds`] = [...resolvedIds, resolutionId].slice(-20);
      }
      await td.actor.update(updates);
      return isHP ? newValue <= 0 : newValue >= hull.max;
    });
    if (isDestroyed) craftDestroyed.push(tokenId);
  }
  if (craftDestroyed.length > 0) {
    const deleted = await destroyOrdnanceTokens(craftDestroyed);
    if ((deleted?.tokensDeleted ?? 0) !== craftDestroyed.length) {
      return { ok: false, reason: "craftDestructionFailed" };
    }
    await postResultChat(`<b>${torName ?? "Torpedo"}</b> detonation destroyed ${craftDestroyed.length} strike craft flight(s).`);
  }
  return { ok: true };
}
