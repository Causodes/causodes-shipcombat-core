import { SystemAdapter } from "./systems/SystemAdapter.js";

export function getPlayerShipCombatant({
  shipActor,
  combat = game.combat,
  combatantId = null,
}) {
  if (!combat || !shipActor) return null;
  return combatantId
    ? combat.combatants.get(combatantId) ?? null
    : combat.combatants.find(c => c.actor?.id === shipActor.id) ?? null;
}

export function hasPlayerShipInitiative({ shipActor, combat = game.combat }) {
  const initiative = getPlayerShipCombatant({ shipActor, combat })?.initiative;
  return initiative != null && Number.isFinite(Number(initiative));
}

export async function applyPlayerShipInitiativeBonus({
  shipActor,
  bonus = 0,
  previousBonus = 0,
  combat = game.combat,
}) {
  const combatant = getPlayerShipCombatant({ shipActor, combat });
  if (!combatant || combatant.initiative == null) return null;

  const currentInitiative = Number(combatant.initiative);
  const prior = Number(previousBonus);
  const nextBonus = Number(bonus);
  if (![currentInitiative, prior, nextBonus].every(Number.isFinite)) return null;

  const nextInitiative = currentInitiative - prior + nextBonus;
  await combat.setInitiative(combatant.id, nextInitiative);
  return nextInitiative;
}

/**
 * Store a player ship's initiative in the matching Foundry combatant. A fresh
 * roll replaces any previously modified tracker value, so its applied-bonus
 * delta is reset at the same time.
 *
 * @param {object} params
 * @param {Actor} params.shipActor
 * @param {number} params.rawTotal
 * @param {Combat|null} [params.combat]
 * @param {string|null} [params.combatantId]
 * @returns {Promise<number|null>} The initiative value stored in the tracker.
 */
export async function recordPlayerShipInitiative({
  shipActor,
  rawTotal,
  combat = game.combat,
  combatantId = null,
}) {
  if (!shipActor) return null;

  const rawInitiative = Number(rawTotal);
  if (!Number.isFinite(rawInitiative)) return null;

  const adapter = SystemAdapter.current;
  const trackerInitiative = Number(adapter.toCombatantInitiative(rawInitiative, shipActor));
  if (!Number.isFinite(trackerInitiative)) return null;

  await shipActor.update({
    [adapter.systemPath("resources.captain.prevTurnInitiativeBonus")]: 0,
  });

  const combatant = getPlayerShipCombatant({ shipActor, combat, combatantId });
  if (combatant) await combat.setInitiative(combatant.id, trackerInitiative);

  return trackerInitiative;
}
