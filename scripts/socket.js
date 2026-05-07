import { CORE_MODULE_ID, WEAPON_FIRED_HOOK } from "./constants.js";
import { ShipCombatState } from "./state/ShipCombatState.js";

let _socket;

export function setupSocket() {
  _socket = socketlib.registerModule(CORE_MODULE_ID);
  for (const action of [
    "assignRole",
    "markOvercharge", "toggleTurnDone", "updateResource",
    "assignWeapon", "unassignComponent", "assignEquipment",
    "startCombat", "endCombat", "advanceRound", "endShipTurn",
    "confirmMovement", "resetHelmState", "fullReset",
    "emergencyVent", "reduceInternalFire", "setInternalFire",
    "stagePowerCore", "unstagePowerCore", "dispatchStagedCores",
    "pilotRetrograde", "pilotOverdrive", "pilotStrafe", "pilotFlipAndBurn", "pilotRam", "apToThrust",
    "commitShieldCores", "uncommitShieldCore", "commitAuxCore", "uncommitAuxCore", "spendBankedCores", "adjustShieldZone", "fluxToCharge",
    "fireWeapon",
    "repairHull",
    "addSensorEffect",
    "upgradeLock",
    "spawnOrdnance",
    "setOrdnanceRtb",
    "setOrdnanceTurnDone",
    "designateHostileTorpedo",
    "torpedoPowerBoost",
    "consumeLock",
    "removeLock",
    "resolveBDA",
    "setFireCorrection",
    "spendAP",
    "torpedoDamage",
    "blastOrdnance",
    "strikeCraftAttack",
    "triageCondition",
    "drawCards",
    "playCard",
    "discardCard",
    "mulligan",
    "fullRedraw",
    "captainPayloadActivate",
    "captainCoreAction",
  ]) {
    _socket.register(action, (payload) => _handleAction(action, payload));
  }

  // Broadcast handler: runs on ALL connected clients simultaneously
  _socket.register("animateTokenPath", (payload) => _handleAnimateTokenPath(payload));
  _socket.register("showGunnerArcs", (payload) => _handleShowGunnerArcs(payload));
  _socket.register("playWeaponAnimation", (payload) => _handlePlayWeaponAnimation(payload));
}

async function _handleAction(action, payload = {}) {
  switch (action) {

    case "assignRole":
      await ShipCombatState.assignRole(payload.userId, payload.roleId, payload.actorRef ?? null);
      break;

    case "markOvercharge":
      await ShipCombatState.markOverchargeUsed(payload.roleId);
      break;

    case "toggleTurnDone":
      await ShipCombatState.toggleTurnDone(payload.roleId);
      break;

    case "updateResource":
      await ShipCombatState.updateResource(payload.roleId, payload.key, payload.value);
      break;

    case "assignWeapon":
      await ShipCombatState.assignWeapon(payload);
      break;

    case "unassignComponent":
      await ShipCombatState.unassignComponent(payload);
      break;

    case "assignEquipment":
      await ShipCombatState.assignEquipment(payload);
      break;

    case "startCombat":
      await ShipCombatState.startCombat();
      break;

    case "endCombat":
      await ShipCombatState.endCombat();
      break;

    case "advanceRound":
      await ShipCombatState.advanceRound();
      break;

    case "endShipTurn":
      await ShipCombatState.endShipTurn();
      break;


    case "confirmMovement":
      await ShipCombatState.confirmMovement(payload);
      if (payload.waypoints?.length) {
        const ship = ShipCombatState.ship;
        const token = ship?.getActiveTokens()?.[0];
        if (token) {
          emitToAll("animateTokenPath", {
            tokenUuid:     token.document.uuid,
            waypoints:     payload.waypoints,
            finalX:        payload.newX,
            finalY:        payload.newY,
            finalRotation: payload.newRotation,
          });
        }
      }
      break;

    case "resetHelmState":
      await ShipCombatState.resetHelmState();
      break;

    case "fullReset":
      await ShipCombatState.fullReset();
      break;

    case "emergencyVent":
      await ShipCombatState.emergencyVent();
      break;

    case "reduceInternalFire":
      await ShipCombatState.reduceInternalFire(payload.amount ?? 0);
      break;

    case "setInternalFire":
      await ShipCombatState.setInternalFire(payload.value ?? 0);
      break;

    case "stagePowerCore":
      await ShipCombatState.stagePowerCore(payload.targetRoleId);
      break;

    case "unstagePowerCore":
      await ShipCombatState.unstagePowerCore(payload.targetRoleId);
      break;

    case "dispatchStagedCores":
      await ShipCombatState.dispatchStagedCores();
      break;

    case "pilotRetrograde":
      await ShipCombatState.pilotRetrograde(payload.userId, payload.retroValue, payload.newX, payload.newY, payload.newRotation, payload.waypoints);
      if (payload.waypoints?.length) {
        const ship = ShipCombatState.ship;
        const token = ship?.getActiveTokens()?.[0];
        if (token) {
          emitToAll("animateTokenPath", {
            tokenUuid:     token.document.uuid,
            waypoints:     payload.waypoints,
            finalX:        payload.newX,
            finalY:        payload.newY,
            finalRotation: token.document.rotation,
          });
        }
      }
      break;

    case "pilotOverdrive":
      await ShipCombatState.pilotOverdrive(payload.userId);
      break;

    case "apToThrust":
      await ShipCombatState.apToThrust(payload.userId);
      break;

    case "pilotStrafe":
      await ShipCombatState.pilotStrafe(payload.userId, payload.newX, payload.newY, payload.newRotation, payload.dist, payload.waypoints);
      if (payload.waypoints?.length) {
        const ship = ShipCombatState.ship;
        const token = ship?.getActiveTokens()?.[0];
        if (token) {
          emitToAll("animateTokenPath", {
            tokenUuid:     token.document.uuid,
            waypoints:     payload.waypoints,
            finalX:        payload.newX,
            finalY:        payload.newY,
            finalRotation: payload.newRotation,
          });
        }
      }
      break;

    case "pilotFlipAndBurn":
      await ShipCombatState.pilotFlipAndBurn(payload.userId, payload.halfSpeedUnits, payload.newX, payload.newY, payload.newRotation, payload.waypoints);
      if (payload.waypoints?.length) {
        const ship2 = ShipCombatState.ship;
        const token2 = ship2?.getActiveTokens()?.[0];
        if (token2) {
          emitToAll("animateTokenPath", {
            tokenUuid:     token2.document.uuid,
            waypoints:     payload.waypoints,
            finalX:        payload.newX,
            finalY:        payload.newY,
            finalRotation: payload.newRotation,
          });
        }
      }
      break;

    case "pilotRam":
      await ShipCombatState.pilotRam(
        payload.userId,
        payload.targetTokenId,
        payload.fuelUsed,
        payload.driftUsed ?? 0,
        payload.speed,
        payload.newX,
        payload.newY,
        payload.newRotation,
        payload.waypoints,
        payload.attackAngle ?? 0,
        payload.powerMax ?? 100,
        payload.rammingActorId ?? null,
        payload.maxBearingDeg ?? 30,
      );
      if (payload.waypoints?.length) {
        // Animate path for the ramming token (player ship or NPC)
        const rammingActor = payload.rammingActorId
          ? game.actors?.get(payload.rammingActorId)
          : ShipCombatState.ship;
        const tokenRam = rammingActor?.getActiveTokens?.()?.[0];
        if (tokenRam) {
          emitToAll("animateTokenPath", {
            tokenUuid:     tokenRam.document.uuid,
            waypoints:     payload.waypoints,
            finalX:        payload.newX,
            finalY:        payload.newY,
            finalRotation: payload.newRotation,
          });
        }
      }
      break;

    case "commitShieldCores":
      await ShipCombatState.commitShieldCores(payload.count ?? 1);
      break;

    case "uncommitShieldCore":
      await ShipCombatState.uncommitShieldCore();
      break;

    case "commitAuxCore":
      await ShipCombatState.commitAuxCore();
      break;

    case "uncommitAuxCore":
      await ShipCombatState.uncommitAuxCore();
      break;

    case "spendBankedCores":
      await ShipCombatState.spendBankedCores(payload.count ?? 1);
      break;

    case "adjustShieldZone":
      await ShipCombatState.adjustShieldZone(payload.sector, payload.value);
      break;
    case "fluxToCharge":
      await ShipCombatState.fluxToCharge();
      break;

    case "fireWeapon": {
      const _fwResult = await ShipCombatState.fireWeapon(payload);
      // Broadcast animation to all clients (including GM) via socket
      const _aActor  = payload.actorId  ? game.actors.get(payload.actorId)  : null;
      const _aWeapon = _aActor?.items.get(payload.weaponId) ?? null;
      if (_aWeapon?.system?.weaponCategory) {
        emitToAll("playWeaponAnimation", {
          weaponCategory: _aWeapon.system.weaponCategory,
          fireMode:       payload.fireMode ?? "",
          firingActorId:  payload.actorId  ?? null,
          targetTokenId:  payload.targetToken ?? null,
          totalHits:      _fwResult?.totalHits ?? 0,
          totalSalvo:     _fwResult?.totalSalvo ?? 0,
          isNpcFire:      payload.isNpcFire ?? false,
        });
      }
      break;
    }

    case "repairHull":
      await ShipCombatState.repairHull(payload.plasmaSpent, payload.sl);
      break;

    case "addSensorEffect":
      await ShipCombatState.addSensorEffect(payload);
      break;

    case "upgradeLock":
      await ShipCombatState.upgradeLock(payload);
      break;

    case "spawnOrdnance":
      await ShipCombatState.spawnOrdnance(payload);
      break;

    case "setOrdnanceRtb":
      await ShipCombatState.setOrdnanceRtb(payload.tokenId, payload.rtb);
      break;

    case "setOrdnanceTurnDone":
      await ShipCombatState.setOrdnanceTurnDone(payload.tokenId, payload.done);
      break;

    case "designateHostileTorpedo":
      await ShipCombatState.designateHostileTorpedo(payload.tokenId);
      break;

    case "torpedoPowerBoost":
      await ShipCombatState.torpedoPowerBoost(payload.tokenId);
      break;

    case "consumeLock":
      await ShipCombatState.consumeLock(payload);
      break;

    case "removeLock":
      await ShipCombatState.removeLock(payload.targetTokenId);
      break;

    case "resolveBDA":
      await ShipCombatState.resolveBDA(payload);
      break;

    case "setFireCorrection":
      await ShipCombatState.setFireCorrection(payload);
      break;

    case "spendAP":
      await ShipCombatState.spendAP(payload.cost);
      break;

    case "torpedoDamage":
      await ShipCombatState.torpedoDamage(payload);
      break;

    case "blastOrdnance":
      await ShipCombatState.blastOrdnance(payload);
      break;

    case "strikeCraftAttack": {
      const _scResult = await ShipCombatState.strikeCraftAttack(payload);
      if (payload.craftActorId && payload.targetTokenId) {
        emitToAll("playWeaponAnimation", {
          weaponCategory: "laser_pdc",
          fireMode:       "",
          firingActorId:  payload.craftActorId,
          targetTokenId:  payload.targetTokenId,
          totalHits:      _scResult?.totalHits ?? 0,
          totalSalvo:     payload.salvoSize    ?? 1,
          isNpcFire:      false,
        });
      }
      break;
    }

    case "triageCondition":
      await ShipCombatState.triageCondition(payload);
      break;

    case "drawCards":
      await ShipCombatState.drawCards(payload);
      break;

    case "playCard":
      await ShipCombatState.playCard(payload);
      break;

    case "discardCard":
      await ShipCombatState.discardCard(payload);
      break;

    case "mulligan":
      await ShipCombatState.mulligan(payload);
      break;

    case "fullRedraw":
      await ShipCombatState.fullRedraw();
      break;

    case "captainPayloadActivate":
      await ShipCombatState.captainPayloadActivate(payload);
      break;

    case "captainCoreAction":
      await ShipCombatState.captainCoreAction(payload);
      break;

    default:
      console.warn(`${MODULE_ID} | Unknown socket action: ${action}`);
  }
}

/**
 * Broadcast a token path animation to all connected clients.
 * Each client animates locally using the canvas Token API (no server sync).
 * The GM commits the final position after the chain completes.
 */
async function _handleAnimateTokenPath({ tokenUuid, waypoints, finalX, finalY, finalRotation }) {
  if (!canvas?.ready || !waypoints?.length) return;

  // Resolve the TokenDocument from its UUID so any client can find it
  let tokenDoc;
  try { tokenDoc = await fromUuid(tokenUuid); }
  catch { return; }

  const canvasToken = tokenDoc?.object;
  if (!canvasToken) return;

  // Fire all waypoint animations immediately with chain:true.
  // Foundry queues them and plays them back-to-back with no gaps.
  const promises = [];
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    promises.push(
      canvasToken.animate(
        { x: wp.x, y: wp.y, rotation: wp.rotation },
        { chain: i > 0 }
      )
    );
  }

  // Wait for the full animation chain to finish
  await promises[promises.length - 1];

  // Only the GM commits the authoritative final position
  if (game.user.isGM) {
    await tokenDoc.update(
      { x: finalX, y: finalY, rotation: finalRotation },
      { animate: false }
    );
  }
}

/**
 * Show / refresh gunner weapon arc overlay on all clients.
 * Primarily useful so the Helmsman can see firing arcs when the Gunner
 * spends a core action on arc visibility.
 */
async function _handleShowGunnerArcs(_payload) {
  try {
    const { WeaponArcOverlay } = await import("./canvas/WeaponArcOverlay.js");
    const ship = ShipCombatState.ship;
    if (ship && WeaponArcOverlay.activate) {
      WeaponArcOverlay.activate(ship);
    }
  } catch { /* overlay module not available on this client */ }
}

/**
 * Broadcast weapon animation to all clients.
 * Resolves token placeables locally on each client by ID.
 */
function _handlePlayWeaponAnimation({ weaponCategory, fireMode, firingActorId, targetTokenId, totalHits, totalSalvo, isNpcFire, blastRadius }) {
  if (!canvas?.ready) return;
  const firingActor = firingActorId ? game.actors.get(firingActorId) : null;
  const targetToken = targetTokenId ? canvas.tokens.get(targetTokenId) : null;
  Hooks.callAll(WEAPON_FIRED_HOOK, {
    weaponCategory,
    fireMode,
    firingActor,
    targetToken,
    totalHits,
    totalSalvo,
    isNpcFire,
    blastRadius,
  });
}

/**
 * Send an action request to the GM.
 * Uses socketlib if available (guaranteed GM execution), otherwise raw socket.
 */
export function emitToGM(action, payload = {}) {
  if (game.user.isGM) {
    _handleAction(action, payload);
  } else {
    _socket.executeAsGM(action, payload);
  }
}

/**
 * Broadcast an action to ALL connected clients (including the sender).
 */
export function emitToAll(action, payload = {}) {
  _socket.executeForEveryone(action, payload);
}
