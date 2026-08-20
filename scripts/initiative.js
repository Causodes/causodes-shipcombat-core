import { SystemAdapter } from "./systems/SystemAdapter.js";

/**
 * Persist a player ship's rolled initiative baseline and mirror it to the
 * matching Foundry combatant. Captain initiative allocation is applied later
 * as a bonus to this stored tracker value at the start of a new round.
 *
 * Keeping these writes together prevents system-specific combat-tracker
 * overrides from setting the visible initiative while leaving the Captain's
 * stored baseline at its schema default of zero.
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
    [adapter.systemPath("resources.captain.rolledInitiative")]: trackerInitiative,
  });

  if (combat) {
    const combatant = combatantId
      ? combat.combatants.get(combatantId)
      : combat.combatants.find(c => c.actor?.id === shipActor.id);
    if (combatant) await combat.setInitiative(combatant.id, trackerInitiative);
  }

  return trackerInitiative;
}
