/** Resolve station ownership consistently across every supported crew layout. */
import { SystemAdapter } from "../systems/SystemAdapter.js";

function _shipData(shipOrData) {
  return shipOrData?.system
    ? SystemAdapter.current.getShipData(shipOrData)
    : shipOrData;
}

/**
 * Return the canonical crew role operating a station for the current layout.
 * Station state remains stored under its full-crew id (for example, `pilot`);
 * only the human operator changes.
 */
export function getStationOperatorRole(shipOrData, stationRole) {
  const sys = _shipData(shipOrData);
  const crewSize = sys?.crewSize ?? 6;

  if (stationRole === "pilot" && crewSize <= 3) return "engineer";
  if (stationRole === "sensors" && crewSize <= 4) return "captain";
  if (stationRole === "ordnance") {
    if (crewSize <= 4) return "gunner";
    if (crewSize === 5) return "captain";
  }
  return stationRole;
}

export function getStationOperatorUserId(shipActor, stationRole) {
  const sys = _shipData(shipActor);
  const roleId = getStationOperatorRole(sys, stationRole);
  return Object.entries(sys?.roles ?? {}).find(([, role]) => role === roleId)?.[0] ?? null;
}

export async function resolveStationOperatorActor(shipActor, stationRole) {
  const sys = _shipData(shipActor);
  const roleId = getStationOperatorRole(sys, stationRole);
  const ref = sys?.crewActors?.[roleId];
  if (ref?.uuid) {
    try {
      const actor = await fromUuid(ref.uuid);
      if (actor) return actor;
    } catch { /* fall through to the assigned user's character */ }
  }

  const userId = getStationOperatorUserId(shipActor, stationRole);
  return userId ? (game.users.get(userId)?.character ?? null) : null;
}

/** Synchronous variant for sheet context fields that cannot await UUID lookup. */
export function resolveStationOperatorActorSync(shipActor, stationRole) {
  const sys = _shipData(shipActor);
  const roleId = getStationOperatorRole(sys, stationRole);
  const ref = sys?.crewActors?.[roleId];
  if (ref?.uuid && typeof fromUuidSync === "function") {
    try {
      const actor = fromUuidSync(ref.uuid);
      if (actor) return actor;
    } catch { /* fall through to the assigned user's character */ }
  }
  const userId = getStationOperatorUserId(shipActor, stationRole);
  return userId ? (game.users.get(userId)?.character ?? null) : null;
}

/** True when a user is the assigned operator for a station in this layout. */
export function userOperatesStation(shipActor, user, stationRole) {
  if (!shipActor || !user) return false;
  const sys = _shipData(shipActor);
  const operatorRole = getStationOperatorRole(sys, stationRole);
  if (sys?.roles?.[user.id] === operatorRole) return true;

  const ref = sys?.crewActors?.[operatorRole];
  const actorId = ref?.id ?? (ref?.uuid?.startsWith("Actor.") ? ref.uuid.slice(6) : null);
  const actor = actorId ? game.actors.get(actorId) : null;
  if (!actor) return false;
  if (user.character?.id && user.character.id === actor.id) return true;
  const level = Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0);
  return level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
}

/** Deployed ordnance control differs from who operates the launch station at 5 crew. */
export function getOrdnanceControllerRole(shipOrData, subtype) {
  const sys = _shipData(shipOrData);
  const crewSize = sys?.crewSize ?? 6;
  if (crewSize >= 6) return "ordnance";
  if (crewSize === 5 && subtype === "strikeCraft") return "captain";
  return "gunner";
}

export function getOrdnanceControllerUserId(shipActor, subtype) {
  const sys = _shipData(shipActor);
  const roleId = getOrdnanceControllerRole(sys, subtype);
  return Object.entries(sys?.roles ?? {}).find(([, role]) => role === roleId)?.[0] ?? null;
}

// Compatibility names for the BDA call sites.
export function getSensorsOperatorRole(shipOrData) {
  return getStationOperatorRole(shipOrData, "sensors");
}

export function getSensorsOperatorUserId(shipActor) {
  return getStationOperatorUserId(shipActor, "sensors");
}

export async function resolveSensorsOperatorActor(shipActor) {
  return resolveStationOperatorActor(shipActor, "sensors");
}
