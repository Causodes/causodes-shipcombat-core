/** Shared stance rules used by UI previews and authoritative resolution. */

export function getStance(shipData) {
  return shipData?.resources?.captain?.stance ?? "none";
}

/** A stance affects attacks made by the ship and attacks made against it. */
export function getAttackStanceModifier(attackerData, targetData, step) {
  const modifierFor = data => {
    const stance = getStance(data);
    return stance === "aggressive" ? step : stance === "defensive" ? -step : 0;
  };
  return modifierFor(attackerData) + modifierFor(targetData);
}

/** Devastation Protocol applies when either participant has the stance. */
export function hasDevastationProtocol(attackerData, targetData) {
  return getStance(attackerData) === "devastation"
    || getStance(targetData) === "devastation";
}

export function getStanceMovementModifiers(shipData) {
  const stance = getStance(shipData);
  if (stance === "aggressive") return { speed: -1, maneuverability: -1 };
  if (stance === "defensive") return { speed: 1, maneuverability: 1 };
  return { speed: 0, maneuverability: 0 };
}
