import { resolvePersistedActorType } from "../actor-identity.js";
import { buildInitialCaptainZones } from "../captain/deck-state.js";
import { buildRecordDeletionUpdates } from "./target-references.js";

/** Pure projection of every player-ship state write required at combat start. */
export function buildCombatStartUpdates(data, { coreOutput, maxVoidFlux }) {
  const captainZones = buildInitialCaptainZones(data.crewSize);
  const updates = {
    active: true, round: 1, internalFire: 0,
    "resources.pilot.prevTurnMove": 0,
    "resources.engineer.powerCores": coreOutput,
    "resources.engineer.heat": 0,
    "resources.engineer.actionChoices": [],
    "resources.engineer.extraActions": 0,
    "shieldPool.current": maxVoidFlux,
    "shieldPool.committed": 0,
    ventLocked: false,
    ventPending: false,
    "conditions.hull": { tier: null, lockedRole: null, blindedSectionId: null },
    "conditions.engines": { tier: null, lockedRole: null, blindedSectionId: null },
    "conditions.manoeuvring": { tier: null, lockedRole: null, blindedSectionId: null },
    "conditions.coreSystems": { tier: null, lockedRole: null, blindedSectionId: null },
    "conditions.weaponsSensors": { tier: null, lockedRole: null, blindedSectionId: null },
    "resources.captain.stance": "none",
    "resources.captain.pendingStance": "",
    "resources.captain.hand": captainZones.hand,
    "resources.captain.drawPile": captainZones.drawPile,
    "resources.captain.discardPile": captainZones.discardPile,
    "resources.captain.currentHandCap": 3,
    "resources.captain.mulligansSpent": 0,
    "resources.captain.allocationLocked": false,
    "resources.captain.triageCount": 2,
    "resources.captain.triageConditionsUsed": [],
    "resources.captain.payload": "",
    "resources.captain.leadershipRolled": false,
    "resources.captain.leadershipSL": 0,
    "resources.captain.prevTurnInitiativeBonus": 0,
    "resources.captain.allocInspire": 0,
    "resources.captain.allocResolve": 0,
    "resources.captain.allocInitiative": 0,
    "resources.captain.handCapBonus": 0,
    "resources.captain.playedCards": [],
    "resources.captain.priorityTargetId": null,
  };
  Object.assign(updates,
    buildRecordDeletionUpdates("resources.sensors.contacts", data.resources?.sensors?.contacts),
  );
  updates["resources.sensors.nextContactOrdinal"] = 1;
  updates["resources.sensors.recommendedTargetId"] = null;
  for (const roleId of Object.keys(data.turnDone ?? {})) updates[`turnDone.${roleId}`] = false;
  for (const roleId of Object.keys(data.overchargeUsed ?? {})) updates[`overchargeUsed.${roleId}`] = false;
  for (const uid of Object.keys(data.assignedCores ?? {})) updates[`assignedCores.${uid}`] = false;
  for (const uid of Object.keys(data.reactions ?? {})) updates[`reactions.${uid}`] = false;
  for (const uid of Object.keys(data.resources?.engineer?.stagedCores ?? {})) {
    updates[`resources.engineer.stagedCores.${uid}`] = false;
  }
  for (const roleId of ["engineer", "captain", "gunner", "pilot", "sensors", "ordnance"]) {
    updates[`resources.${roleId}.coreCount`] = 0;
  }
  for (const stationRole of ["gunner", "pilot", "sensors", "ordnance"]) {
    updates[`resources.${stationRole}.coreActionsPlayed`] = [];
  }
  const ordnanceActors = data.ordnanceActors ?? {};
  if ((ordnanceActors.torpedo ?? []).length > 0) updates["resources.ordnance.armedTorpedoes"] = 1;
  if ((ordnanceActors.strikeCraft ?? []).length > 0) updates["resources.ordnance.armedCraft"] = 1;
  updates["resources.ordnance.availablePayloads"] = 1;
  updates["resources.ordnance.autoArmTimer"] = 3;
  updates["resources.ordnance.autoLoadTimer"] = 2;
  return updates;
}

/**
 * Resolve and initialize every distinct player ship participating in a combat.
 * Native Foundry Combat startup is the authoritative lifecycle boundary; sheet
 * buttons and socket callers must not be required to establish combat state.
 */
export function getCombatPlayerShips(combat, moduleId) {
  const ships = new Map();
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant?.actor;
    const actorType = resolvePersistedActorType({
      actorId: combatant?.actorId,
      baseActor: combatant?.token?.baseActor,
      actor,
    });
    if (actorType !== `${moduleId}.ship` || !actor) continue;
    ships.set(actor.uuid ?? actor.id, actor);
  }
  return [...ships.values()];
}

export async function initializePlayerShipsForCombat(combat, { moduleId, stateClass }) {
  const ships = getCombatPlayerShips(combat, moduleId);
  for (const ship of ships) {
    const initialized = await stateClass.forShip(ship).startCombat();
    if (initialized !== true) {
      throw new Error(`Failed to initialize Ship Combat state for ${ship.name ?? ship.id}`);
    }
  }
  return ships.length;
}

/** Foundry starts a Combat by atomically advancing it to round 1, turn 0. */
export function isCombatStartTransition(changes = {}) {
  return Number(changes.round) === 1 && Number(changes.turn) === 0;
}
