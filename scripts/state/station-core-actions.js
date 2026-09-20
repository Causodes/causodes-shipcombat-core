import { CRIT_LOCATIONS, GUNNER_CORE_ACTIONS, ORDNANCE_MASTER_CORE_ACTIONS } from "../constants.js";
import { getPowerCoreCount, getPowerCorePoolRole } from "../roles/crew-operators.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { applyOrdnanceCompletionEffect } from "./ordnance-reservations.js";

export function buildGunnerCoreEffectUpdates(data, actionId, {
  ammoCapacity = 0,
  critLocationChoice = null,
} = {}) {
  if (!GUNNER_CORE_ACTIONS.some(action => action.id === actionId)) {
    return { ok: false, reason: "invalidAction" };
  }
  if (actionId === "extendRange") {
    return { ok: true, updates: { "resources.gunner.sensorBandExpanded": true } };
  }
  if (actionId === "chooseCritLoc") {
    if (!CRIT_LOCATIONS.some(location => location.id === critLocationChoice)) {
      return { ok: false, reason: "invalidCritLocation" };
    }
    return {
      ok: true,
      updates: {
        "resources.gunner.chooseCritLocation": true,
        "resources.gunner.critLocationChoice": critLocationChoice,
      },
    };
  }
  const current = Math.max(0, Number(data?.resources?.gunner?.ammo) || 0);
  const gain = Math.max(1, Math.ceil(ammoCapacity * 0.25));
  return {
    ok: true,
    updates: { "resources.gunner.ammo": Math.min(ammoCapacity, current + gain) },
  };
}

export function buildOrdnanceCoreEffectUpdates(data, actionId, {
  choice = null,
  commitmentId = null,
  index = -1,
  componentManpower = 0,
  ammoCapacity = 0,
  auxPowerCapacity = 0,
  reserveMultiplier = 0,
  hullDisplayMode = "damageTaken",
} = {}) {
  if (!ORDNANCE_MASTER_CORE_ACTIONS.some(action => action.id === actionId)) {
    return { ok: false, reason: "invalidAction" };
  }
  const ordnance = data?.resources?.ordnance ?? {};
  const updates = {};

  if (actionId === "combatRecoveryDoctrine") {
    if (choice === "destroyed" && (ordnance.craftDestroyed ?? 0) > 0) {
      updates["resources.ordnance.craftDestroyed"] = ordnance.craftDestroyed - 1;
      updates["resources.ordnance.craftPartialRecovery"] = (ordnance.craftPartialRecovery ?? 0) + 1;
    } else if (choice === "partial" && (ordnance.craftPartialRecovery ?? 0) > 0) {
      updates["resources.ordnance.craftPartialRecovery"] = ordnance.craftPartialRecovery - 1;
    } else {
      return { ok: false, reason: "invalidRecovery" };
    }
  } else if (actionId === "shockLoadingRotation") {
    const commitments = [...(ordnance.commitments ?? [])];
    const commitmentIndex = commitmentId
      ? commitments.findIndex(commitment => commitment.id === commitmentId)
      : Number(index);
    if (commitmentIndex < 0 || commitmentIndex >= commitments.length) {
      return { ok: false, reason: "commitmentNotFound" };
    }
    const [commitment] = commitments.splice(commitmentIndex, 1);
    const manpowerMax = ordnance.manpowerMax || componentManpower;
    updates["resources.ordnance.commitments"] = commitments;
    updates["resources.ordnance.manpower"] = Math.min(
      manpowerMax,
      (ordnance.manpower ?? 0) + (commitment.crewCount ?? 0),
    );
    applyOrdnanceCompletionEffect(updates, data, commitment.action, {
      ammoCapacity,
      auxPowerCapacity,
      reserveMultiplier,
      hullDisplayMode,
    });
  } else if (actionId === "magazineCrossfeed") {
    const ammo = Math.max(0, Number(data?.resources?.gunner?.ammo) || 0);
    const cost = choice === "torpedo" ? 6 : choice === "payload" ? 4 : Infinity;
    if (ammo < cost) return { ok: false, reason: "insufficientAmmo" };
    updates["resources.gunner.ammo"] = ammo - cost;
    if (choice === "torpedo") {
      updates["resources.ordnance.armedTorpedoes"] = (ordnance.armedTorpedoes ?? 0) + 1;
    } else {
      updates["resources.ordnance.availablePayloads"] = (ordnance.availablePayloads ?? 0) + 1;
    }
  } else if (actionId === "deckConsciption") {
    const manpowerMax = ordnance.manpowerMax ?? 12;
    const manpower = ordnance.manpower ?? 0;
    const permanentLoss = Math.max(0, componentManpower - manpowerMax);
    if (choice === "recover" && permanentLoss > 0) {
      const restore = Math.max(1, Math.ceil(permanentLoss * 0.1));
      const restoredMax = Math.min(componentManpower, manpowerMax + restore);
      updates["resources.ordnance.manpowerMax"] = restoredMax;
      updates["resources.ordnance.manpower"] = Math.min(restoredMax, manpower + restore);
    } else if (choice === "temp" || (choice == null && permanentLoss === 0)) {
      updates["resources.ordnance.manpower"] = manpower + Math.max(1, Math.ceil(manpowerMax * 0.25));
    } else {
      return { ok: false, reason: "invalidConscription" };
    }
  } else if (actionId === "rapidRearm") {
    updates["resources.ordnance.armedTorpedoes"] = (ordnance.armedTorpedoes ?? 0) + 1;
    updates["resources.ordnance.autoArmTimer"] = 3;
    if ((data?.crewSize ?? 6) >= 6) {
      updates["resources.ordnance.availablePayloads"] = (ordnance.availablePayloads ?? 0) + 1;
      updates["resources.ordnance.autoLoadTimer"] = 2;
    } else if (data?.conditions?.coreSystems?.tier !== "high") {
      const gain = Math.floor(reserveMultiplier / 2);
      if (gain > 0) {
        const current = Math.max(0, Number(data?.resources?.engineer?.auxiliaryPower) || 0);
        updates["resources.engineer.auxiliaryPower"] = Math.min(auxPowerCapacity, current + gain);
      }
    }
  }
  return { ok: true, updates };
}

async function commitCoreAction(state, roleId, actionId, effect) {
  if (!effect.ok) return effect;
  const data = state.getData(state.ship) ?? {};
  const poolRole = getPowerCorePoolRole(data, roleId);
  const coreCount = getPowerCoreCount(data, roleId);
  if (coreCount <= 0) return { ok: false, reason: "noPowerCore" };
  const priorActions = data.resources?.[roleId]?.coreActionsPlayed ?? [];
  await state.update({
    ...effect.updates,
    [`resources.${poolRole}.coreCount`]: coreCount - 1,
    [`resources.${roleId}.coreActionsPlayed`]: [...priorActions, actionId],
  }, state.ship);
  return { ok: true };
}

export async function executeGunnerCoreAction({ actionId, critLocationChoice = null } = {}) {
  if (!game.user.isGM || !this.ship) return { ok: false, reason: "notGM" };
  return this.withAllocationTransaction(
    () => this.withPowerCoreTransaction(async () => {
      const data = this.getData(this.ship) ?? {};
      const effect = buildGunnerCoreEffectUpdates(data, actionId, {
        ammoCapacity: this.getOrdnanceBayStats(this.ship).ammoCapacity ?? 0,
        critLocationChoice,
      });
      return commitCoreAction(this, "gunner", actionId, effect);
    }, this.ship),
    this.ship,
  );
}

export async function executeOrdnanceCoreAction(payload = {}) {
  if (!game.user.isGM || !this.ship) return { ok: false, reason: "notGM" };
  return this.withAllocationTransaction(
    () => this.withPowerCoreTransaction(async () => {
      const data = this.getData(this.ship) ?? {};
      if (payload.actionId === "rapidRearm") {
        const torpedoIds = new Set(
          (data.ordnanceActors?.torpedo ?? []).map(entry => entry?.id).filter(Boolean),
        );
        const hasTorpedo = (data.activeOrdnance ?? []).some(entry => (
          entry?.type === "torpedo" && torpedoIds.has(entry.actorId)
        ));
        if (!hasTorpedo) return { ok: false, reason: "noTorpedoConfig" };
      }
      const bay = this.getOrdnanceBayStats(this.ship);
      const reactor = this.getReactorStats(this.ship);
      const effect = buildOrdnanceCoreEffectUpdates(data, payload.actionId, {
        ...payload,
        componentManpower: bay.manpower ?? 0,
        ammoCapacity: bay.ammoCapacity ?? 0,
        ...reactor,
        hullDisplayMode: SystemAdapter.current.hullDisplayMode,
      });
      return commitCoreAction(this, "ordnance", payload.actionId, effect);
    }, this.ship),
    this.ship,
  );
}
