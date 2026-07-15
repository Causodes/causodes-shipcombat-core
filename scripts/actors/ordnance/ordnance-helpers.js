/**
 * Stored strike-craft actors describe one craft. The weapons bay supplies the
 * actual flight size when a token is launched.
 *
 * Mutates and returns actorData so callers can use it before previewing or
 * persisting a loaded template.
 */
export function normalizeStrikeCraftTemplateHull(actorData, slotType, hullDisplayMode) {
  if (slotType !== "strikeCraft" || !actorData) return actorData;
  actorData.system ??= {};
  actorData.system.hull = {
    ...(actorData.system.hull ?? {}),
    value: hullDisplayMode === "hpRemaining" ? 1 : 0,
    max: 1,
  };
  return actorData;
}
