/**
 * ordnance-types.js  –  Type identity helpers for ship ordnance actors.
 *
 * All code that previously compared actor.type against the literal strings
 * `${MODULE_ID}.torpedo` or `${MODULE_ID}.strikeCraft` should import and use
 * these helpers instead.  This keeps the logic in one place and makes the
 * shipOrdnance migration transparent to callers.
 *
 * During the migration period BOTH the legacy types (torpedo, strikeCraft)
 * AND the new unified type (shipOrdnance) are registered.  All helpers
 * accept either form so old world data continues to work while the migration
 * hook runs.
 */

import { MODULE_ID } from "../../constants.js";

/** The unified ordnance actor type string. */
export function ordnanceTypeName() {
  return `${MODULE_ID}.shipOrdnance`;
}

/** True if the actor is any kind of ship ordnance (legacy or unified). */
export function isOrdnance(actor) {
  const t = actor?.type;
  return (
    t === `${MODULE_ID}.shipOrdnance` ||
    t === `${MODULE_ID}.torpedo` ||
    t === `${MODULE_ID}.strikeCraft`
  );
}

/** True if the actor is a torpedo (legacy or unified). */
export function isTorpedo(actor) {
  if (!actor) return false;
  if (actor.type === `${MODULE_ID}.torpedo`) return true;
  if (actor.type === `${MODULE_ID}.shipOrdnance`) {
    return actor.system?.subtype === "torpedo";
  }
  return false;
}

/** True if the actor is a strike craft (legacy or unified). */
export function isStrikeCraft(actor) {
  if (!actor) return false;
  if (actor.type === `${MODULE_ID}.strikeCraft`) return true;
  if (actor.type === `${MODULE_ID}.shipOrdnance`) {
    return actor.system?.subtype === "strikeCraft";
  }
  return false;
}

/** Returns "torpedo" | "strikeCraft" | null for any ordnance actor. */
export function ordnanceSubtype(actor) {
  if (!actor) return null;
  if (actor.type === `${MODULE_ID}.torpedo`) return "torpedo";
  if (actor.type === `${MODULE_ID}.strikeCraft`) return "strikeCraft";
  if (actor.type === `${MODULE_ID}.shipOrdnance`) {
    const sub = actor.system?.subtype;
    if (sub === "torpedo" || sub === "strikeCraft") return sub;
    console.error(`causodes-shipcombat-core | shipOrdnance actor "${actor.name}" (${actor.id}) has missing or invalid subtype: "${sub}"`);
    return null;
  }
  return null;
}

/** Like isTorpedo but operates on a raw actorType string + optional subtype. */
export function actorTypeIsTorpedo(actorType, actorSubtype) {
  if (actorType === `${MODULE_ID}.torpedo`) return true;
  if (actorType === `${MODULE_ID}.shipOrdnance`) return actorSubtype === "torpedo";
  return false;
}

export function actorTypeIsStrikeCraft(actorType, actorSubtype) {
  if (actorType === `${MODULE_ID}.strikeCraft`) return true;
  if (actorType === `${MODULE_ID}.shipOrdnance`) return actorSubtype === "strikeCraft";
  return false;
}

export function actorTypeIsOrdnance(actorType) {
  return (
    actorType === `${MODULE_ID}.shipOrdnance` ||
    actorType === `${MODULE_ID}.torpedo` ||
    actorType === `${MODULE_ID}.strikeCraft`
  );
}
