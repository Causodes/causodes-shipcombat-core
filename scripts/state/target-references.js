/** Return every scene Token ID retained by ship targeting state. */
export function collectTargetReferenceIds(data = {}) {
  const sensors = data.resources?.sensors ?? {};
  const captain = data.resources?.captain ?? {};
  const ids = new Set([
    sensors.recommendedTargetId,
    captain.priorityTargetId,
    sensors.fireCorrection?.targetTokenId,
    ...Object.keys(sensors.contacts ?? {}),
    ...(sensors.locks ?? []).map(lock => lock?.targetTokenId),
    ...(sensors.effects ?? []).map(effect => effect?.targetTokenId),
    ...Object.values(sensors.bdaAttacks ?? {}).map(attack => attack?.targetTokenId),
  ]);
  ids.delete(null);
  ids.delete(undefined);
  ids.delete("");
  ids.delete("__self__");
  return ids;
}

/** Return valid target Token IDs across all world Scenes, not only the viewed Scene. */
export function collectExistingTargetTokenIds(scenes = []) {
  return [...new Set([...scenes].flatMap(scene =>
    [...(scene?.tokens ?? [])]
      .filter(tokenDoc => Boolean(tokenDoc?.actor))
      .map(tokenDoc => tokenDoc.id)
  ))];
}

/**
 * Build Foundry deletion-operator updates for selected keys in an object field.
 * Assigning an empty object is not a clear operation because Document updates
 * recursively merge object values, including when the final key is removed.
 */
export function buildRecordDeletionUpdates(path, record = {}, shouldDelete = () => true) {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, value]) => shouldDelete(key, value))
      .map(([key]) => [`${path}.-=${key}`, null]),
  );
}

/** Build one atomic update that removes all references to the supplied Token IDs. */
export function buildTargetReferenceCleanup(data = {}, targetTokenIds = []) {
  const removed = new Set(targetTokenIds);
  if (removed.size === 0) return {};

  const sensors = data.resources?.sensors ?? {};
  const captain = data.resources?.captain ?? {};
  const updates = {};

  if (removed.has(sensors.recommendedTargetId)) {
    updates["resources.sensors.recommendedTargetId"] = null;
  }
  if (removed.has(captain.priorityTargetId)) {
    updates["resources.captain.priorityTargetId"] = null;
  }
  if (removed.has(sensors.fireCorrection?.targetTokenId)) {
    updates["resources.sensors.fireCorrection"] = null;
  }

  const locks = sensors.locks ?? [];
  const nextLocks = locks.filter(lock => !removed.has(lock?.targetTokenId));
  if (nextLocks.length !== locks.length) updates["resources.sensors.locks"] = nextLocks;

  const effects = sensors.effects ?? [];
  const nextEffects = effects.filter(effect => !removed.has(effect?.targetTokenId));
  if (nextEffects.length !== effects.length) updates["resources.sensors.effects"] = nextEffects;

  const contacts = sensors.contacts ?? {};
  Object.assign(updates, buildRecordDeletionUpdates(
    "resources.sensors.contacts",
    contacts,
    targetTokenId => removed.has(targetTokenId),
  ));

  const bdaAttacks = sensors.bdaAttacks ?? {};
  Object.assign(updates, buildRecordDeletionUpdates(
    "resources.sensors.bdaAttacks",
    bdaAttacks,
    (_attackId, attack) => removed.has(attack?.targetTokenId),
  ));

  return updates;
}
