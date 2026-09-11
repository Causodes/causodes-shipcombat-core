/**
 * Pure ordnance turn-state transitions.
 *
 * Keeping these decisions free of Foundry documents makes every legal state
 * transition testable without a running Foundry world.
 */

export function getOrdnanceLaunchTurnState(subtype) {
  const launchDriftPending = subtype === "torpedo";
  return {
    turnComplete: launchDriftPending,
    launchDriftPending,
  };
}

export function canSetOrdnanceTurnDone(ordnanceData, done) {
  const requestedDone = Boolean(done);
  if (ordnanceData?.subtype === "torpedo"
    && ordnanceData?.launchDriftPending === true
    && !requestedDone) {
    return false;
  }
  return true;
}

export function getOrdnanceLifecycleTransition(ordnanceData) {
  const isTorpedo = ordnanceData?.subtype === "torpedo";
  return {
    wasTurnComplete: Boolean(ordnanceData?.turnComplete),
    isLaunchTurn: isTorpedo && ordnanceData?.launchDriftPending === true,
    nextTurnComplete: false,
    nextLaunchDriftPending: false,
  };
}

export function actorTypeHasOrdnanceLifecycle(actorType, moduleId) {
  return actorType === `${moduleId}.ship` || actorType === `${moduleId}.npcShip`;
}

export async function processParentOrdnanceLifecycle(actor, { moduleId, stateClass }) {
  if (!actorTypeHasOrdnanceLifecycle(actor?.type, moduleId)) return false;
  const state = stateClass.forShip(actor);
  if (!state) return false;
  await state.processOrdnanceLifecycle(actor);
  return true;
}
