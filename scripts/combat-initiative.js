import { recordPlayerShipInitiative, setCombatantInitiative } from "./initiative.js";
import { resolvePersistedActorType } from "./actor-identity.js";

/**
 * Resolve the persisted actor type which identifies a ship combatant.
 *
 * Unlinked Tokens expose a synthetic actor whose system may normalize its
 * type to a native value (for example, SF2e's `vehicle`). The world/base
 * actor retains the module-defined ship type and is therefore authoritative
 * for routing, while the synthetic actor remains authoritative for data.
 */
export function resolveCombatantActorType(combatant, actors = globalThis.game?.actors) {
  return resolvePersistedActorType({
    actorId: combatant?.actorId,
    baseActor: combatant?.token?.baseActor,
    actor: combatant?.actor,
  }, actors);
}

/**
 * Execute ship initiative through the configured adapter, then delegate all
 * non-ship combatants to the host system's original implementation.
 *
 * Dependencies are injectable so this complete boundary contract can be
 * exercised without booting Foundry.
 */
export async function rollCombatInitiative({
  combat,
  ids,
  options,
  moduleId,
  adapter,
  resolveCaptain,
  resolveActorType = resolveCombatantActorType,
  recordPlayerInitiative = recordPlayerShipInitiative,
  persistInitiative = setCombatantInitiative,
  warn = message => ui.notifications.warn(message),
  localize = key => game.i18n.localize(key),
  getSpeaker = actor => ChatMessage.getSpeaker({ actor }),
  delegate,
}) {
  const combatantIds = Array.isArray(ids) ? ids : [ids];
  const playerType = `${moduleId}.ship`;
  const npcType = `${moduleId}.npcShip`;
  const otherIds = [];

  for (const id of combatantIds) {
    const combatant = combat.combatants.get(id);
    const ship = combatant?.actor;
    const actorType = resolveActorType(combatant);
    if (actorType === playerType) {
      const crewActor = await resolveCaptain(ship);
      if (!crewActor) {
        warn(localize("SHIPCOMBAT.Warning.NoCaptainAssigned"));
        continue;
      }
      const data = adapter.getShipData(ship) ?? {};
      const { total } = await adapter.rollShipInitiative(
        crewActor,
        data.roleSkillOverrides?.captain ?? "leadership",
        {
          flavor: localize("SHIPCOMBAT.Captain.RollInitiativeBtn"),
          speaker: getSpeaker(crewActor),
        },
      );
      await recordPlayerInitiative({
        shipActor: ship,
        rawTotal: total,
        combat,
        combatantId: id,
      });
    } else if (actorType === npcType) {
      const data = adapter.getShipData(ship) ?? {};
      const { total } = await adapter.rollShipInitiativeFromAttribute(
        data.attributes?.piloting ?? 0,
        localize("SHIPCOMBAT.NpcShip.RollInitiative"),
        { speaker: getSpeaker(ship) },
      );
      await persistInitiative({
        combat,
        combatantId: id,
        initiative: adapter.toCombatantInitiative(total, ship),
      });
    } else {
      otherIds.push(id);
    }
  }

  if (otherIds.length > 0) return delegate(otherIds, options);
  return combat;
}

/** Install the executable initiative contract on a Foundry Combat class. */
export function installCombatInitiativeHandler({
  CombatClass,
  moduleId,
  adapter,
  resolveCaptain,
  resolveActorType,
  recordPlayerInitiative,
  persistInitiative,
  warn,
  localize,
  getSpeaker,
}) {
  const original = CombatClass.prototype.rollInitiative;
  CombatClass.prototype.rollInitiative = function (ids, options) {
    return rollCombatInitiative({
      combat: this,
      ids,
      options,
      moduleId,
      adapter,
      resolveCaptain,
      resolveActorType,
      recordPlayerInitiative,
      persistInitiative,
      warn,
      localize,
      getSpeaker,
      delegate: (otherIds, delegatedOptions) => original.call(this, otherIds, delegatedOptions),
    });
  };
  return original;
}
