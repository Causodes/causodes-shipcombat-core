import { CORE_MODULE_ID, ORDNANCE_MASTER_ACTIONS, WEAPON_FIRED_HOOK } from "./constants.js";
import { confirmAllocationCommit } from "./apps/allocation-warning.js";
import { SystemAdapter } from "./systems/SystemAdapter.js";
import { ShipCombatState } from "./state/ShipCombatState.js";
import { isOrdnance } from "./actors/ordnance/ordnance-types.js";
import { IdempotencyGate } from "./state/idempotency.js";

let _socket;
const _requestGate = new IdempotencyGate();

const _shipAction = Object.freeze({ scope: "ship" });
const _parentShipAction = Object.freeze({ scope: "parentShip" });
const _sourceAction = sourceKey => Object.freeze({ scope: "source", sourceKey });
const _ordnanceAction = sourceKey => Object.freeze({ scope: "ordnance", sourceKey });

/** Single authoritative catalog for registration and actor-scope injection. */
export const ACTION_CONTRACTS = Object.freeze({
  assignRole: _shipAction,
  consumePowerCore: _shipAction,
  toggleTurnDone: _shipAction,
  updateResource: _shipAction,
  updateResources: _shipAction,
  adjustResources: _shipAction,
  assignWeapon: _shipAction,
  unassignComponent: _shipAction,
  assignEquipment: _shipAction,
  startCombat: _shipAction,
  endCombat: _shipAction,
  advanceRound: _shipAction,
  endShipTurn: _shipAction,
  confirmMovement: _shipAction,
  resetHelmState: _shipAction,
  fullReset: _shipAction,
  emergencyVent: _shipAction,
  reduceInternalFire: _shipAction,
  manageHeat: _shipAction,
  setInternalFire: _shipAction,
  stagePowerCore: _shipAction,
  unstagePowerCore: _shipAction,
  dispatchStagedCores: _shipAction,
  pilotRetrograde: _shipAction,
  pilotOverdrive: _shipAction,
  pilotStrafe: _shipAction,
  pilotFlipAndBurn: _shipAction,
  pilotRam: _sourceAction("rammingActorId"),
  apToThrust: _shipAction,
  commitShieldCores: _shipAction,
  uncommitShieldCore: _shipAction,
  commitAuxCore: _shipAction,
  uncommitAuxCore: _shipAction,
  spendBankedCores: _shipAction,
  adjustShieldZone: _shipAction,
  fluxToCharge: _shipAction,
  fireWeapon: _sourceAction("actorId"),
  repairHull: _shipAction,
  executeSensorAction: _shipAction,
  executeSensorCoreAction: _shipAction,
  setRecommendedTarget: _shipAction,
  registerSensorContacts: _shipAction,
  executeOrdnanceLaunch: _shipAction,
  executeCraftRecovery: _shipAction,
  deleteOrdnanceTokens: _parentShipAction,
  destroyOrdnanceTokens: _parentShipAction,
  commitOrdnanceAction: _shipAction,
  cancelOrdnanceCommitment: _shipAction,
  completeOrdnanceCommitment: _shipAction,
  setOrdnanceRtb: _parentShipAction,
  setOrdnanceTurnDone: _parentShipAction,
  resolveBDA: _shipAction,
  applyBdaCorrection: _shipAction,
  torpedoDamage: _ordnanceAction("torpedoActorId"),
  blastOrdnance: _ordnanceAction("torpedoActorId"),
  strikeCraftAttack: _ordnanceAction("craftActorId"),
  triageCondition: _shipAction,
  playCard: _shipAction,
  discardCard: _shipAction,
  mulligan: _shipAction,
  captainPayloadActivate: _shipAction,
  captainCoreAction: _shipAction,
  beginDeadReckoning: _shipAction,
  completeDeadReckoning: _shipAction,
  cancelDeadReckoning: _shipAction,
});

const REQUEST_ACTIONS = Object.freeze(Object.keys(ACTION_CONTRACTS));

/** Single authoritative catalog for broadcasts received by every client. */
const BROADCAST_HANDLERS = Object.freeze({
  animateTokenPath: _handleAnimateTokenPath,
  showGunnerArcs: _handleShowGunnerArcs,
  playWeaponAnimation: _handlePlayWeaponAnimation,
});

function _hasValidOutgoingActorScope(action, payload) {
  const contract = ACTION_CONTRACTS[action];
  if (!contract || !payload.shipActorId) return false;
  if (contract.scope === "source") {
    return payload[contract.sourceKey] === payload.shipActorId;
  }
  if (contract.scope === "ordnance") return Boolean(payload[contract.sourceKey]);
  return contract.scope === "ship" || contract.scope === "parentShip";
}

function _ordnanceBelongsToShip(ordnanceActor, shipActor) {
  if (!ordnanceActor || !shipActor || !isOrdnance(ordnanceActor) || !canvas?.scene) return false;
  const parentShipTokenId = SystemAdapter.current.getShipData(ordnanceActor)?.parentShipTokenId;
  return canvas.scene.tokens.get(parentShipTokenId)?.actorId === shipActor.id;
}

function _getOwnedOrdnanceTokenIds(shipActor, tokenIds = []) {
  if (!shipActor || !canvas?.scene || !Array.isArray(tokenIds)) return [];
  return [...new Set(tokenIds)].filter(tokenId => {
    const tokenDoc = canvas.scene.tokens.get(tokenId);
    if (!tokenDoc?.actor || !isOrdnance(tokenDoc.actor)) return false;
    const parentShipTokenId = SystemAdapter.current.getShipData(tokenDoc.actor)?.parentShipTokenId;
    return canvas.scene.tokens.get(parentShipTokenId)?.actorId === shipActor.id;
  });
}

async function _broadcastShipTokenPath(state, payload, finalRotation = payload.newRotation) {
  if (!payload.waypoints?.length) return true;
  const token = state.ship?.getActiveTokens()?.[0];
  if (!token) return false;
  await emitToAll("animateTokenPath", {
    tokenUuid: token.document.uuid,
    waypoints: payload.waypoints,
    finalX: payload.newX,
    finalY: payload.newY,
    finalRotation,
  });
  return true;
}

/** Keep socket results small and consistent instead of returning Foundry Documents. */
async function _booleanActionResult(operation) {
  const result = await operation;
  return result !== false && result !== null && result?.ok !== false;
}

function _confirmAllocationAction(action, payload) {
  const ship = payload.shipActorId ? game.actors.get(payload.shipActorId) : ShipCombatState.ship;
  if (!ship) return null;

  const policies = {
    confirmMovement: ["pilot", "pilot.move", "SHIPCOMBAT.Helm.Confirm"],
    pilotFlipAndBurn: ["pilot", "pilot.flipAndBurn", "SHIPCOMBAT.Action.PilotFlipAndBurn"],
    pilotRam: ["pilot", "pilot.ram", "SHIPCOMBAT.Helm.Ram"],
    commitOrdnanceAction: ["ordnance", "ordnance.commit", ORDNANCE_MASTER_ACTIONS[payload.actionId]?.label],
    executeOrdnanceLaunch: ["ordnance", "ordnance.commit", ORDNANCE_MASTER_ACTIONS[payload.actionId]?.label],
    executeCraftRecovery: ["ordnance", "ordnance.commit", ORDNANCE_MASTER_ACTIONS.recallCraft.label],
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
  for (const action of REQUEST_ACTIONS) {
    _socket.register(action, (payload = {}) => _handleActionOnce(action, payload));
  }

  // Broadcast handlers run on ALL connected clients simultaneously.
  for (const [action, handler] of Object.entries(BROADCAST_HANDLERS)) {
    _socket.register(action, handler);
  }
}

export function _handleActionOnce(action, payload = {}) {
  const requestId = payload.requestId;
  const key = requestId ? `${action}:${payload.shipActorId ?? ""}:${requestId}` : null;
  return _requestGate.run(key, () => _handleAction(action, payload));
}

async function _handleAction(action, payload = {}) {
  const contract = ACTION_CONTRACTS[action];
  if (!contract) return false;
  const shipActor = payload.shipActorId ? game.actors.get(payload.shipActorId) : null;
  if (contract.scope === "ship" && shipActor?.type !== `${SystemAdapter.current.moduleId}.ship`) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return false;
  }
  if (contract.scope === "parentShip") {
    const allowedTypes = new Set([
      `${SystemAdapter.current.moduleId}.ship`,
      `${SystemAdapter.current.moduleId}.npcShip`,
    ]);
    if (!shipActor || !allowedTypes.has(shipActor.type)) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return false;
    }
  }
  if (contract.scope === "ordnance") {
    const allowedTypes = new Set([
      `${SystemAdapter.current.moduleId}.ship`,
      `${SystemAdapter.current.moduleId}.npcShip`,
    ]);
    const sourceActorId = payload[contract.sourceKey];
    const sourceActor = sourceActorId ? game.actors.get(sourceActorId) : null;
    if (!shipActor || !allowedTypes.has(shipActor.type) || !_ordnanceBelongsToShip(sourceActor, shipActor)) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return false;
    }
  }
  if (contract.scope === "source") {
    const allowedTypes = new Set([
      `${SystemAdapter.current.moduleId}.ship`,
      `${SystemAdapter.current.moduleId}.npcShip`,
    ]);
    if (!shipActor || !allowedTypes.has(shipActor.type) || payload[contract.sourceKey] !== shipActor.id) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return false;
    }
  }
  const state = shipActor ? ShipCombatState.forShip(shipActor) : ShipCombatState;

  switch (action) {

    case "assignRole": {
      return _booleanActionResult(state.assignRole(
        payload.userId,
        payload.roleId,
        payload.actorRef ?? null,
      ));
    }

    case "consumePowerCore":
      return state.consumePowerCore(payload.roleId, payload.actionId ?? null);

    case "toggleTurnDone":
      return _booleanActionResult(state.toggleTurnDone(payload.roleId));

    case "updateResource":
      return _booleanActionResult(state.updateResource(payload.roleId, payload.key, payload.value));

    case "updateResources":
      return _booleanActionResult(state.updateResources(payload.updates));

    case "adjustResources":
      return state.adjustResources(payload.adjustments, payload.requirements);

    case "assignWeapon":
    case "unassignComponent":
    case "assignEquipment": {
      if (action === "assignWeapon") return _booleanActionResult(state.assignWeapon(payload));
      if (action === "unassignComponent") return _booleanActionResult(state.unassignComponent(payload));
      return _booleanActionResult(state.assignEquipment(payload));
    }

    case "startCombat":
      return _booleanActionResult(state.withAllocationTransaction(() => state.startCombat()));

    case "endCombat":
      return _booleanActionResult(state.withAllocationTransaction(() => state.endCombat()));

    case "advanceRound": {
      return _booleanActionResult(state.withAllocationTransaction(() => state.advanceRound()));
    }

    case "endShipTurn":
      return _booleanActionResult(state.endShipTurn());


    case "confirmMovement": {
      const result = await state.confirmMovement(payload);
      if (result === false) return false;
      if (!(await _broadcastShipTokenPath(state, payload))) return false;
      return result ?? true;
    }

    case "resetHelmState":
      return _booleanActionResult(state.resetHelmState());

    case "fullReset": {
      return _booleanActionResult(state.withAllocationTransaction(() => state.fullReset()));
    }

    case "emergencyVent":
      return _booleanActionResult(state.emergencyVent());

    case "reduceInternalFire":
      return _booleanActionResult(state.reduceInternalFire(payload.amount ?? 0, payload.auxiliaryPowerSpent ?? 0));

    case "manageHeat":
      return _booleanActionResult(state.manageHeat(payload.auxiliaryPowerSpent ?? 0, payload.sl ?? 0));

    case "setInternalFire":
      return _booleanActionResult(state.setInternalFire(payload.value ?? 0));

    case "stagePowerCore":
      return _booleanActionResult(state.stagePowerCore(payload.targetRoleId));

    case "unstagePowerCore":
      return _booleanActionResult(state.unstagePowerCore(payload.targetRoleId));

    case "dispatchStagedCores":
      return _booleanActionResult(state.dispatchStagedCores());

    case "pilotRetrograde": {
      const result = await state.pilotRetrograde(
        payload.userId,
        payload.retroValue,
        payload.newX,
        payload.newY,
        payload.newRotation,
        payload.waypoints,
      );
      if (result === false) return false;
      const finalRotation = state.ship?.getActiveTokens()?.[0]?.document?.rotation ?? payload.newRotation;
      if (!(await _broadcastShipTokenPath(state, payload, finalRotation))) return false;
      return result ?? true;
    }

    case "pilotOverdrive":
      return state.pilotOverdrive(payload.userId);

    case "apToThrust":
      return state.apToThrust(payload.userId);

    case "pilotStrafe": {
      const result = await state.pilotStrafe(
        payload.userId,
        payload.newX,
        payload.newY,
        payload.newRotation,
        payload.dist,
        payload.waypoints,
      );
      if (result === false) return false;
      if (!(await _broadcastShipTokenPath(state, payload))) return false;
      return result ?? true;
    }

    case "pilotFlipAndBurn": {
      const result = await state.pilotFlipAndBurn(
        payload.userId,
        payload.halfSpeedUnits,
        payload.newX,
        payload.newY,
        payload.newRotation,
        payload.waypoints,
      );
      if (result === false) return false;
      if (!(await _broadcastShipTokenPath(state, payload))) return false;
      return result ?? true;
    }

    case "pilotRam": {
      const impactToken = payload.targetTokenId ? canvas?.tokens?.get(payload.targetTokenId) : null;
      const impactLocation = impactToken
        ? { x: impactToken.center.x, y: impactToken.center.y }
        : null;
      const ramResult = await state.pilotRam(
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
      if (ramResult === false) return false;
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
          : state.ship;
        const tokenRam = rammingActor?.getActiveTokens?.()?.[0];
        if (tokenRam) {
          const finalX = ramResult?.finalX ?? payload.newX;
          const finalY = ramResult?.finalY ?? payload.newY;
          const finalRotation = ramResult?.finalRotation ?? payload.newRotation;
          const waypoints = [
            ...payload.waypoints,
            { x: finalX, y: finalY, rotation: finalRotation },
          ];
          await emitToAll("animateTokenPath", {
            tokenUuid:     tokenRam.document.uuid,
            waypoints,
            finalX,
            finalY,
            finalRotation,
          });
        }
      }
      return ramResult;
    }

    case "commitShieldCores":
      return _booleanActionResult(state.commitShieldCores(payload.count ?? 1));

    case "uncommitShieldCore":
      return _booleanActionResult(state.uncommitShieldCore());

    case "commitAuxCore":
      return _booleanActionResult(state.commitAuxCore());

    case "uncommitAuxCore":
      return _booleanActionResult(state.uncommitAuxCore());

    case "spendBankedCores":
      return (await state.spendBankedCores(payload.count ?? 1)) > 0;

    case "adjustShieldZone":
      return _booleanActionResult(state.adjustShieldZone(payload.sector, payload.value));
    case "fluxToCharge":
      return _booleanActionResult(state.fluxToCharge());

    case "fireWeapon": {
      const _fwResult = await state.fireWeapon(payload);
      if (_fwResult === false) return false;
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
      return _fwResult;
    }

    case "repairHull":
      return _booleanActionResult(state.repairHull(payload.auxiliaryPowerSpent, payload.sl));

    case "executeSensorAction":
      return state.executeSensorAction(payload);

    case "executeSensorCoreAction":
      return state.executeSensorCoreAction(payload);

    case "setRecommendedTarget":
      return _booleanActionResult(state.setRecommendedTarget(payload));

    case "registerSensorContacts":
      return _booleanActionResult(state.registerSensorContacts(payload));

    case "executeOrdnanceLaunch":
      return state.executeOrdnanceLaunch(payload);

    case "executeCraftRecovery":
      return state.executeCraftRecovery(payload);

    case "deleteOrdnanceTokens": {
      const tokenIds = _getOwnedOrdnanceTokenIds(state.ship, payload.tokenIds);
      return ShipCombatState.deleteOrdnanceTokens(tokenIds, {
        suppressDestroyTracking: payload.suppressDestroyTracking === true,
      });
    }
    case "destroyOrdnanceTokens": {
      const tokenIds = _getOwnedOrdnanceTokenIds(state.ship, payload.tokenIds);
      return ShipCombatState.destroyOrdnanceTokens(tokenIds);
    }

    case "commitOrdnanceAction":
      return state.commitOrdnanceAction(payload.actionId);

    case "cancelOrdnanceCommitment":
      return state.cancelOrdnanceCommitment(payload);

    case "completeOrdnanceCommitment":
      return state.completeOrdnanceCommitment(payload);

    case "setOrdnanceRtb":
      if (!_getOwnedOrdnanceTokenIds(state.ship, [payload.tokenId]).length) return false;
      return _booleanActionResult(ShipCombatState.setOrdnanceRtb(payload.tokenId, payload.rtb));

    case "setOrdnanceTurnDone":
      if (!_getOwnedOrdnanceTokenIds(state.ship, [payload.tokenId]).length) return false;
      return ShipCombatState.setOrdnanceTurnDone(payload.tokenId, payload.done);

    case "resolveBDA":
      return _booleanActionResult(state.resolveBDA(payload));

    case "applyBdaCorrection":
      return state.applyBdaCorrection(payload);

    case "torpedoDamage":
      return state.torpedoDamage(payload);

    case "blastOrdnance":
      return state.blastOrdnance(payload);

    case "strikeCraftAttack": {
      const _scResult = await state.strikeCraftAttack(payload);
      if (_scResult === false || _scResult?.ok === false) return _scResult;
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
      return _scResult;
    }

    case "triageCondition":
      return _booleanActionResult(state.triageCondition(payload));

    case "playCard":
      return _booleanActionResult(state.playCard(payload));

    case "discardCard":
      return _booleanActionResult(state.discardCard(payload));

    case "mulligan":
      return _booleanActionResult(state.mulligan(payload));

    case "captainPayloadActivate":
      return _booleanActionResult(state.captainPayloadActivate(payload));

    case "captainCoreAction":
      return _booleanActionResult(state.captainCoreAction(payload));

    case "beginDeadReckoning":
      return state.beginDeadReckoning();

    case "completeDeadReckoning":
      return state.completeDeadReckoning(payload);

    case "cancelDeadReckoning":
      return state.cancelDeadReckoning(payload);

    default:
      console.warn(`${CORE_MODULE_ID} | Unknown socket action: ${action}`);
      return false;
  }
}

/**
 * Broadcast a token path animation to all connected clients.
 * Each client animates locally using the canvas Token API (no server sync).
 * The GM commits the final position after the chain completes.
 */
async function _handleAnimateTokenPath({ tokenUuid, waypoints, finalX, finalY, finalRotation }) {
  if (!canvas?.ready || !waypoints?.length) return false;

  // Resolve the TokenDocument from its UUID so any client can find it
  let tokenDoc;
  try { tokenDoc = await fromUuid(tokenUuid); }
  catch { return false; }

  const canvasToken = tokenDoc?.object;
  if (!canvasToken) return false;

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
  try {
    await promises[promises.length - 1];
  } catch (error) {
    // Visual interpolation is best-effort. The GM must still commit the
    // authoritative destination so movement cannot be partially applied.
    console.error(`${CORE_MODULE_ID} | Token path animation failed`, error);
  }

  // Only the GM commits the authoritative final position
  if (game.user.isGM) {
    await tokenDoc.update(
      { x: finalX, y: finalY, rotation: finalRotation },
      { animate: false }
    );
  }
  return true;
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

function _resolveRequestShipActor(actor, contract) {
  if (!actor) return null;
  if (contract.scope !== "ordnance" && !isOrdnance(actor)) return actor;
  const parentShipTokenId = SystemAdapter.current.getShipData(actor)?.parentShipTokenId;
  return parentShipTokenId ? canvas?.scene?.tokens.get(parentShipTokenId)?.actor ?? null : null;
}

/**
 * Request a GM action using an Actor document as the sole identity source.
 * Identity fields supplied in payload are overwritten from the contract.
 */
function requestGMAction(action, actor, payload = {}) {
  const contract = ACTION_CONTRACTS[action];
  if (!contract) {
    console.error(`${CORE_MODULE_ID} | Unknown GM action contract: ${action}`);
    return false;
  }
  const sourceActor = actor?.actor ?? actor;
  const actorId = typeof sourceActor === "string" ? sourceActor : sourceActor?.id ?? null;
  if (typeof sourceActor === "string" && !["ship", "parentShip"].includes(contract.scope)) {
    console.error(`${CORE_MODULE_ID} | ${action} requires a source Actor document.`);
    return false;
  }
  const shipActor = typeof sourceActor === "string"
    ? null
    : _resolveRequestShipActor(sourceActor, contract);
  const scopedPayload = {
    ...payload,
    requestId: payload.requestId ?? foundry.utils.randomID(),
    shipActorId: typeof sourceActor === "string" ? sourceActor : shipActor?.id ?? null,
  };
  if (contract.sourceKey) scopedPayload[contract.sourceKey] = actorId;
  return emitToGM(action, scopedPayload);
}

/** Create one file-local requester that resolves its Actor from call context. */
export function createActionRequester(resolveActor) {
  if (typeof resolveActor !== "function") {
    throw new TypeError("createActionRequester requires an Actor resolver function.");
  }
  return (context, action, payload = {}) => requestGMAction(
    action,
    resolveActor(context, action, payload),
    payload,
  );
}

/**
 * Send an action request to the GM.
 * Uses socketlib if available (guaranteed GM execution), otherwise raw socket.
 * @deprecated Use createActionRequester so actor identity is injected from the contract.
 */
export function emitToGM(action, payload = {}) {
  if (!_hasValidOutgoingActorScope(action, payload)) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return false;
  }
  payload = { ...payload, requestId: payload.requestId ?? foundry.utils.randomID() };
  const confirmation = _confirmAllocationAction(action, payload);
  if (confirmation) {
    return confirmation.then(proceed => proceed ? _emitToGM(action, payload) : false);
  }
  return _emitToGM(action, payload);
}

function _emitToGM(action, payload) {
  if (game.user.isGM) {
    return _handleActionOnce(action, payload);
  }
  if (!_socket) {
    console.error(`${CORE_MODULE_ID} | Cannot dispatch ${action}: socket is not ready.`);
    return false;
  }
  return _socket.executeAsGM(action, payload);
}

/**
 * Broadcast an action to ALL connected clients (including the sender).
 */
export function emitToAll(action, payload = {}) {
  if (!BROADCAST_HANDLERS[action]) {
    console.error(`${CORE_MODULE_ID} | Unknown broadcast action: ${action}`);
    return false;
  }
  if (!_socket) {
    console.error(`${CORE_MODULE_ID} | Cannot broadcast ${action}: socket is not ready.`);
    return false;
  }
  return _socket.executeForEveryone(action, payload);
}
