/**
 * Resolve the persisted Actor behind a document boundary which may expose a
 * host-system synthetic Actor instead. Persisted identity controls routing and
 * defaults; callers should still use the synthetic Actor for token-local data.
 */
export function resolvePersistedActor({ actorId, baseActor, actor } = {}, actors = globalThis.game?.actors) {
  return actors?.get?.(actorId) ?? baseActor ?? actor?.baseActor ?? actor ?? null;
}

export function resolvePersistedActorType(source, actors) {
  const actor = resolvePersistedActor(source, actors);
  return actor?._source?.type ?? actor?.type;
}

/** Project authoritative creation defaults for module-defined ship Tokens. */
export function getShipTokenCreationDefaults({ token, data, moduleId, actors = globalThis.game?.actors }) {
  const actor = resolvePersistedActor({
    actorId: data?.actorId ?? token?.actorId ?? token?._source?.actorId,
    baseActor: token?.baseActor,
    actor: token?.actor,
  }, actors);
  const actorType = actor?._source?.type ?? actor?.type;
  if (actorType === `${moduleId}.ship`) {
    return { actorLink: actor.prototypeToken?.actorLink ?? true };
  }
  if (actorType === `${moduleId}.npcShip`) {
    return {
      actorLink: actor.prototypeToken?.actorLink ?? false,
      hidden: true,
    };
  }
  return null;
}
