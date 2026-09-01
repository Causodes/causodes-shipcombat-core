import { CORE_MODULE_ID, ORDNANCE_MASTER_ACTIONS, WEAPON_FIRED_HOOK } from "./constants.js";
import { confirmAllocationCommit } from "./apps/allocation-warning.js";
import { SystemAdapter } from "./systems/SystemAdapter.js";
import { ShipCombatState } from "./state/ShipCombatState.js";

let _socket;

const SHIP_SCOPED_ACTIONS = new Set([
  "assignRole", "consumePowerCore", "toggleTurnDone", "updateResource", "updateResources", "adjustResources",
  "assignWeapon", "unassignComponent", "assignEquipment", "advanceRound", "endShipTurn",
  "confirmMovement", "resetHelmState", "fullReset",
  "emergencyVent", "reduceInternalFire", "manageHeat", "setInternalFire",
  "stagePowerCore", "unstagePowerCore", "dispatchStagedCores",
  "pilotRetrograde", "pilotOverdrive", "apToThrust", "pilotStrafe", "pilotFlipAndBurn",
  "commitShieldCores", "uncommitShieldCore", "commitAuxCore", "uncommitAuxCore", "spendBankedCores",
  "adjustShieldZone", "fluxToCharge", "repairHull",
  "addSensorEffect", "setRecommendedTarget", "stripQuadrantShields", "upgradeLock", "upgradeAllLocks",
  "registerSensorContacts", "removeLock", "resolveBDA", "completeBDA", "setFireCorrection", "spendAP",
  "commitOrdnanceAction", "cancelOrdnanceCommitment", "completeOrdnanceCommitment",
  "triageCondition", "playCard", "discardCard", "mulligan", "captainPayloadActivate", "captainCoreAction",
  "beginDeadReckoning", "completeDeadReckoning", "cancelDeadReckoning",
]);

function _confirmAllocationAction(action, payload) {
  const ship = payload.shipActorId ? game.actors.get(payload.shipActorId) : ShipCombatState.ship;
  if (!ship) return null;

  const policies = {
    confirmMovement: ["pilot", "pilot.move", "SHIPCOMBAT.Helm.Confirm"],
    pilotFlipAndBurn: ["pilot", "pilot.flipAndBurn", "SHIPCOMBAT.Action.PilotFlipAndBurn"],
    pilotRam: ["pilot", "pilot.ram", "SHIPCOMBAT.Helm.Ram"],
    commitOrdnanceAction: ["ordnance", "ordnance.commit", ORDNANCE_MASTER_ACTIONS[payload.actionId]?.label],
    mulligan: ["captain", "captain.mulligan", "SHIPCOMBAT.Captain.Mulligan"],
    beginDeadReckoning: ["captain", "captain.deadReckoning", "SHIPCOMBAT.Captain.Core.DeadReckoning.label"],
  };

  let policy = policies[action];
  if (action === "fireWeapon") {
    if (payload.actorId && payload.actorId !== ship.id) return null;
    policy = ["gunner", "gunner.fire", ship.items.get(payload.weaponId)?.name];
  } else if (action === "pilotRam" && payload.rammingActorId && payload.rammingActorId !== ship.id) {
    return null;
  }
  if (!policy) return null;

  const [roleId, trigger, label] = policy;
  const actionLabel = label?.startsWith?.("SHIPCOMBAT.") ? game.i18n.localize(label) : label;
  return confirmAllocationCommit(
    SystemAdapter.current.getShipData(ship),
    roleId,
    trigger,
    actionLabel ?? action,
  );
}

export function setupSocket() {
  _socket = socketlib.registerModule(CORE_MODULE_ID);
  for (const action of [
    "assignRole",
    "consumePowerCore", "toggleTurnDone", "updateResource", "updateResources", "adjustResources",
    "assignWeapon", "unassignComponent", "assignEquipment",
    "startCombat", "endCombat", "advanceRound", "endShipTurn",
    "confirmMovement", "resetHelmState", "fullReset",
    "emergencyVent", "reduceInternalFire", "manageHeat", "setInternalFire",
    "stagePowerCore", "unstagePowerCore", "dispatchStagedCores",
    "pilotRetrograde", "pilotOverdrive", "pilotStrafe", "pilotFlipAndBurn", "pilotRam", "apToThrust",
    "commitShieldCores", "uncommitShieldCore", "commitAuxCore", "uncommitAuxCore", "spendBankedCores", "adjustShieldZone", "fluxToCharge",
    "fireWeapon",
    "repairHull",
    "addSensorEffect",
    "setRecommendedTarget",
    "stripQuadrantShields",
    "upgradeLock",
    "upgradeAllLocks",
    "registerSensorContacts",
    "spawnOrdnance",
    "deleteOrdnanceTokens",
    "commitOrdnanceAction",
    "cancelOrdnanceCommitment",
    "completeOrdnanceCommitment",
    "setOrdnanceRtb",
    "setOrdnanceTurnDone",
    "designateHostileTorpedo",
    "torpedoPowerBoost",
    "consumeLock",
    "removeLock",
    "resolveBDA",
    "completeBDA",
    "setFireCorrection",
    "spendAP",
    "torpedoDamage",
    "blastOrdnance",
    "strikeCraftAttack",
    "triageCondition",
    "playCard",
    "discardCard",
    "mulligan",
    "captainPayloadActivate",
    "captainCoreAction",
    "beginDeadReckoning", "completeDeadReckoning", "cancelDeadReckoning",
  ]) {
    _socket.register(action, (payload) => _handleAction(action, payload));
  }

  // Broadcast handler: runs on ALL connected clients simultaneously
  _socket.register("animateTokenPath", (payload) => _handleAnimateTokenPath(payload));
  _socket.register("showGunnerArcs", (payload) => _handleShowGunnerArcs(payload));
  _socket.register("playWeaponAnimation", (payload) => _handlePlayWeaponAnimation(payload));
}

async function _handleAction(action, payload = {}) {
  const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
  if (SHIP_SCOPED_ACTIONS.has(action) && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return null;
  }
  if (action === "fireWeapon") {
    const allowedTypes = new Set([
      `${SystemAdapter.current.moduleId}.ship`,
      `${SystemAdapter.current.moduleId}.npcShip`,
    ]);
    if (!shipActor || !allowedTypes.has(shipActor.type) || payload.actorId !== shipActor.id) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return false;
    }
  }
  const state = shipActor ? ShipCombatState.forShip(shipActor) : ShipCombatState;

  switch (action) {

    case "assignRole": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (payload.shipActorId && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return;
      }
      await ShipCombatState.assignRole(
        payload.userId,
        payload.roleId,
        payload.actorRef ?? null,
        shipActor,
      );
      break;
    }

    case "consumePowerCore": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (!payload.shipActorId || shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return false;
      }
      return ShipCombatState.consumePowerCore(payload.roleId, payload.actionId ?? null, shipActor);
    }

    case "toggleTurnDone":
      await state.toggleTurnDone(payload.roleId);
      break;

    case "updateResource": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (!payload.shipActorId || shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      return ShipCombatState.updateResource(payload.roleId, payload.key, payload.value, shipActor);
    }

    case "updateResources": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (!payload.shipActorId || shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      return ShipCombatState.updateResources(payload.updates, shipActor);
    }

    case "adjustResources": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (!payload.shipActorId || shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      return ShipCombatState.adjustResources(payload.adjustments, payload.requirements, shipActor);
    }

    case "assignWeapon":
    case "unassignComponent":
    case "assignEquipment": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (payload.shipActorId && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return;
      }
      if (action === "assignWeapon") await ShipCombatState.assignWeapon(payload, shipActor);
      else if (action === "unassignComponent") await ShipCombatState.unassignComponent(payload, shipActor);
      else await ShipCombatState.assignEquipment(payload, shipActor);
      break;
    }

    case "startCombat":
      await ShipCombatState.startCombat();
      break;

    case "endCombat":
      await ShipCombatState.endCombat();
      break;

    case "advanceRound": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (payload.shipActorId && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      await ShipCombatState.advanceRound(shipActor);
      break;
    }

    case "endShipTurn":
      await state.endShipTurn();
      break;


    case "confirmMovement":
      await state.confirmMovement(payload);
      if (payload.waypoints?.length) {
        const ship = state.ship;
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
      await state.resetHelmState();
      break;

    case "fullReset": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (payload.shipActorId && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return;
      }
      await ShipCombatState.fullReset(shipActor);
      break;
    }

    case "emergencyVent":
      await state.emergencyVent();
      break;

    case "reduceInternalFire":
      await state.reduceInternalFire(payload.amount ?? 0, payload.auxiliaryPowerSpent ?? 0);
      break;

    case "manageHeat":
      await state.manageHeat(payload.auxiliaryPowerSpent ?? 0, payload.sl ?? 0);
      break;

    case "setInternalFire":
      await state.setInternalFire(payload.value ?? 0);
      break;

    case "stagePowerCore":
      await state.stagePowerCore(payload.targetRoleId);
      break;

    case "unstagePowerCore":
      await state.unstagePowerCore(payload.targetRoleId);
      break;

    case "dispatchStagedCores":
      await state.dispatchStagedCores();
      break;

    case "pilotRetrograde":
      await state.pilotRetrograde(payload.userId, payload.retroValue, payload.newX, payload.newY, payload.newRotation, payload.waypoints);
      if (payload.waypoints?.length) {
        const ship = state.ship;
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
      await state.pilotOverdrive(payload.userId);
      break;

    case "apToThrust":
      await state.apToThrust(payload.userId);
      break;

    case "pilotStrafe":
      await state.pilotStrafe(payload.userId, payload.newX, payload.newY, payload.newRotation, payload.dist, payload.waypoints);
      if (payload.waypoints?.length) {
        const ship = state.ship;
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
      await state.pilotFlipAndBurn(payload.userId, payload.halfSpeedUnits, payload.newX, payload.newY, payload.newRotation, payload.waypoints);
      if (payload.waypoints?.length) {
        const ship = state.ship;
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

    case "pilotRam": {
      const impactToken = payload.targetTokenId ? canvas?.tokens?.get(payload.targetTokenId) : null;
      const impactLocation = impactToken
        ? { x: impactToken.center.x, y: impactToken.center.y }
        : null;
      const ramResult = await ShipCombatState.pilotRam(
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
      const impactDelay = Math.max(0, (payload.waypoints?.length ?? 0) * 50);
      if (ramResult?.rammedTokenId) {
        emitToAll("playWeaponAnimation", {
          weaponCategory: "ram_collision",
          targetTokenId: ramResult.rammedTokenId,
          totalHits: 1,
          startDelay: impactDelay,
          impactLocation,
        });
      }
      for (const tokenId of [
        ramResult?.rammedDestroyed ? ramResult.rammedTokenId : null,
        ramResult?.rammingDestroyed ? ramResult.rammingTokenId : null,
      ].filter(Boolean)) {
        emitToAll("playWeaponAnimation", {
          weaponCategory: "ship_destruction",
          targetTokenId: tokenId,
          totalHits: 1,
          startDelay: impactDelay + 150,
        });
      }
      if (payload.waypoints?.length) {
        // Animate path for the ramming token (player ship or NPC)
        const rammingActor = payload.rammingActorId
          ? game.actors?.get(payload.rammingActorId)
          : ShipCombatState.ship;
        const tokenRam = rammingActor?.getActiveTokens?.()?.[0];
        if (tokenRam) {
          const finalX = ramResult?.finalX ?? payload.newX;
          const finalY = ramResult?.finalY ?? payload.newY;
          const finalRotation = ramResult?.finalRotation ?? payload.newRotation;
          const waypoints = [
            ...payload.waypoints,
            { x: finalX, y: finalY, rotation: finalRotation },
          ];
          emitToAll("animateTokenPath", {
            tokenUuid:     tokenRam.document.uuid,
            waypoints,
            finalX,
            finalY,
            finalRotation,
          });
        }
      }
      break;
    }

    case "commitShieldCores":
      await state.commitShieldCores(payload.count ?? 1);
      break;

    case "uncommitShieldCore":
      await state.uncommitShieldCore();
      break;

    case "commitAuxCore":
      await state.commitAuxCore();
      break;

    case "uncommitAuxCore":
      await state.uncommitAuxCore();
      break;

    case "spendBankedCores":
      await state.spendBankedCores(payload.count ?? 1);
      break;

    case "adjustShieldZone":
      await state.adjustShieldZone(payload.sector, payload.value);
      break;
    case "fluxToCharge":
      await state.fluxToCharge();
      break;

    case "fireWeapon": {
      const _fwResult = await state.fireWeapon(payload);
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
      await state.repairHull(payload.auxiliaryPowerSpent, payload.sl);
      break;

    case "addSensorEffect":
      await state.addSensorEffect(payload);
      break;

    case "setRecommendedTarget":
      await state.setRecommendedTarget(payload);
      break;

    case "stripQuadrantShields":
      await state.stripQuadrantShields(payload);
      break;

    case "upgradeLock":
      await state.upgradeLock(payload);
      break;

    case "upgradeAllLocks":
      await state.upgradeAllLocks(payload);
      break;

    case "registerSensorContacts":
      await state.registerSensorContacts(payload);
      break;

    case "spawnOrdnance":
      await ShipCombatState.spawnOrdnance(payload);
      break;

    case "deleteOrdnanceTokens":
      return ShipCombatState.deleteOrdnanceTokens(payload.tokenIds);

    case "commitOrdnanceAction": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (payload.shipActorId && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      return ShipCombatState.commitOrdnanceAction(payload.actionId, shipActor);
    }

    case "cancelOrdnanceCommitment": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (payload.shipActorId && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      return ShipCombatState.cancelOrdnanceCommitment(payload, shipActor);
    }

    case "completeOrdnanceCommitment": {
      const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
      if (!payload.shipActorId || shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
        return null;
      }
      return ShipCombatState.completeOrdnanceCommitment(payload, shipActor);
    }

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
      await state.removeLock(payload.targetTokenId);
      break;

    case "resolveBDA":
      await state.resolveBDA(payload);
      break;

    case "completeBDA":
      await state.completeBDA(payload);
      break;

    case "setFireCorrection":
      await state.setFireCorrection(payload);
      break;

    case "spendAP":
      await state.spendAP(payload.cost);
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
      await state.triageCondition(payload);
      break;

    case "playCard":
      await state.playCard(payload);
      break;

    case "discardCard":
      await state.discardCard(payload);
      break;

    case "mulligan":
      await state.mulligan(payload);
      break;

    case "captainPayloadActivate":
      await state.captainPayloadActivate(payload);
      break;

    case "captainCoreAction":
      await state.captainCoreAction(payload);
      break;

    case "beginDeadReckoning":
      return state.beginDeadReckoning();

    case "completeDeadReckoning":
      return state.completeDeadReckoning(payload);

    case "cancelDeadReckoning":
      return state.cancelDeadReckoning(payload);

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
        { duration: 50, chain: i > 0 }
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
function _handlePlayWeaponAnimation({ weaponCategory, fireMode, firingActorId, targetTokenId, totalHits, totalSalvo, isNpcFire, blastRadius, startDelay, impactLocation }) {
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
    startDelay,
    impactLocation,
  });
}

/**
 * Send an action request to the GM.
 * Uses socketlib if available (guaranteed GM execution), otherwise raw socket.
 */
export function emitToGM(action, payload = {}) {
  const confirmation = _confirmAllocationAction(action, payload);
  if (confirmation) {
    return confirmation.then(proceed => proceed ? _emitToGM(action, payload) : false);
  }
  return _emitToGM(action, payload);
}

function _emitToGM(action, payload) {
  if (game.user.isGM) {
    return _handleAction(action, payload);
  }
  return _socket.executeAsGM(action, payload);
}

/**
 * Broadcast an action to ALL connected clients (including the sender).
 */
export function emitToAll(action, payload = {}) {
  _socket.executeForEveryone(action, payload);
}
