/**
 * Gunner / Master of Ordnance role.
 *
 * Resources (persisting, capped):
 *   - Ammo   0-20  (+2/round passive)    -  shared by all Macro Cannon weapons
 *   - Charge 0-20  (no passive; +5/core, +N via Augur divert)  -  Lance Battery weapons
 *   - Heat          (mirrors Engineer)   -  shared by all Plasma Cannon weapons
 *
 * Turn flow:
 *   1. Roll Ranged/Ordnance once per turn → SL pool.
 *   2. Allocate SL between Accuracy, Penetration, and Firepower via +/− buttons.
 *   3. First fire action locks allocation for the rest of the turn.
 *   4. Fire weapons using the shared resource tracks.
 *
 * Core action (choose one per turn):
 *   - Charge Ammo Track: +6 Ammo or +5 Charge.
 *   - Weapon Arc Overlay: Show firing arcs to the Helmsman.
 */
import { emitToGM, emitToAll } from "../socket.js";
import { MODULE_ID, MACRO_FIRE_TIERS, buildChargeTiers, GUNNER_CORE_ACTIONS, CRIT_LOCATIONS } from "../constants.js";
import { TargetingPopup } from "../apps/TargetingPopup.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { heatColor } from "../theme.js";

// ── Constants ────────────────────────────────────────────────────────────────

const CORE_AMMO_BONUS   = 6;
const CORE_POWER_BONUS  = 5;

function _getOrdnanceBayCaps(shipActor) {
  const bay = shipActor?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "weaponsBay");
  return {
    ammoMax:   bay?.system?.bayAmmoCapacity ?? 20,
  };
}

function _getHeatCapacity(shipActor) {
  const reactor = shipActor?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "reactor");
  return reactor?.system?.heatCapacity ?? 0;
}

function _getAuxPowerCapacity(shipActor) {
  const reactor = shipActor?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "reactor");
  return reactor?.system?.bankCapacity ?? 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _resolveGunnerActor(sheet) {
  const sys = sheet.actor.system;
  const ref = sys.crewActors?.gunner;
  if (ref?.uuid) {
    try { return await fromUuid(ref.uuid); } catch { /* ignore */ }
  }
  const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "gunner");
  if (entry) {
    const user = game.users.get(entry[0]);
    return user?.character ?? null;
  }
  return null;
}

// ── Action handlers (static, `this` = sheet instance) ────────────────────────

/**
 * Roll Ordnance once per turn → set SL pool for allocation.
 * Mirrors the Helmsman pattern: one roll, then allocate before acting.
 */
async function _onRollOrdnance() {
  const sys = this.actor.system;
  if (sys.resources?.gunner?.ordnanceRolled) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.AlreadyRolledOrdnance"));
  }

  const crewActor = await _resolveGunnerActor(this);
  if (!crewActor) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoGunnerAssigned"));
  }

  const captainHitBonus = sys.resources?.gunner?.captainHitBonus ?? 0;
  const result = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.gunner ?? "gunner",
    captainHitBonus ? { modifier: captainHitBonus } : {});
  if (!result) return;

  const sl = Math.max(0, result.SL);
  emitToGM("updateResource", { roleId: "gunner", key: "ordnanceSL", value: sl });
  emitToGM("updateResource", { roleId: "gunner", key: "ordnanceRolled", value: true });
  emitToGM("updateResource", { roleId: "gunner", key: "allocAccuracy", value: 0 });
  emitToGM("updateResource", { roleId: "gunner", key: "allocPenetration", value: 0 });
  emitToGM("updateResource", { roleId: "gunner", key: "allocFirepower", value: 0 });
  emitToGM("updateResource", { roleId: "gunner", key: "slLocked", value: false });
}

/**
 * Allocate SL points between Accuracy, Penetration, and Firepower.
 * data-stat = "accuracy" | "penetration" | "firepower"
 * data-delta = "+1" | "-1"
 */
async function _onAllocGunnerSL(event, target) {
  const sys = this.actor.system;
  const gunner = sys.resources?.gunner ?? {};

  // Cannot allocate if locked (already fired) or not yet rolled
  if (gunner.slLocked || !gunner.ordnanceRolled) return;

  const stat  = target.dataset.stat;
  const delta = Number(target.dataset.delta);
  const pool  = gunner.ordnanceSL ?? 0;
  const acc   = gunner.allocAccuracy ?? 0;
  const pen   = gunner.allocPenetration ?? 0;
  const fp    = gunner.allocFirepower ?? 0;

  let newAcc = acc, newPen = pen, newFp = fp;
  if (stat === "accuracy")    newAcc = Math.max(0, acc + delta);
  if (stat === "penetration") newPen = Math.max(0, pen + delta);
  if (stat === "firepower")   newFp  = Math.max(0, fp + delta);

  // Total allocated cannot exceed pool
  if (newAcc + newPen + newFp > pool) return;

  emitToGM("updateResource", { roleId: "gunner", key: `alloc${stat.charAt(0).toUpperCase() + stat.slice(1)}`, value: stat === "accuracy" ? newAcc : stat === "penetration" ? newPen : newFp });
}

/**
 * Core action: Consume the assigned Power Core → gain +6 Ammo or +5 Auxiliary Power.
 * data-track = "ammo" | "power"
 */
async function _onConsumeCore(event, target) {
  const sys   = this.actor.system;
  const track = target.dataset.track;

  const hasCoreAvail = (sys.resources?.gunner?.coreCount ?? 0) > 0;
  if (!hasCoreAvail) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NeedsPowerCore"));
  }

  const actionLabel = track === "ammo" ? "coreAmmo" : "corePower";
  const played = [...(sys.resources?.gunner?.coreActionsPlayed ?? []), actionLabel];

  if (track === "ammo") {
    const current = sys.resources?.gunner?.ammo ?? 0;
    const caps = _getOrdnanceBayCaps(this.actor);
    const next    = Math.min(caps.ammoMax, current + CORE_AMMO_BONUS);
    emitToGM("updateResource", { roleId: "gunner", key: "ammo", value: next });
  } else if (track === "power") {
    const current = sys.resources?.engineer?.auxiliaryPower ?? 0;
    const cap = _getAuxPowerCapacity(this.actor);
    const next = Math.min(cap, current + CORE_POWER_BONUS);
    emitToGM("updateResource", { roleId: "engineer", key: "auxiliaryPower", value: next });
  }

  // Record played action then consume core
  emitToGM("updateResource", { roleId: "gunner", key: "coreActionsPlayed", value: played });
  emitToGM("markOvercharge", { roleId: "gunner" });
}

/**
 * Core action: Gunner picks one of two core action modes:
 *   showArcs       – broadcast fire arc overlay to helmsman (consume core)
 *   chooseCritLoc  – activate choose-crit-location flag for next crit (consume core)
 */
async function _onGunnerCoreAction(event, target) {
  const sys    = this.actor.system;
  const action = target.dataset.coreAction;

  const hasCoreAvail = (sys.resources?.gunner?.coreCount ?? 0) > 0;
  if (!hasCoreAvail) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NeedsPowerCore"));
  }

  if (action === "extendRange") {
    const played = [...(sys.resources?.gunner?.coreActionsPlayed ?? []), "extendRange"];
    emitToGM("updateResource", { roleId: "gunner", key: "coreActionsPlayed", value: played });
    emitToGM("markOvercharge", { roleId: "gunner" });
    emitToGM("updateResource", { roleId: "gunner", key: "sensorBandExpanded", value: true });
  } else if (action === "chooseCritLoc") {
    // Gunner picks the location NOW (player-side dialog), stores choice for the next crit.
    const buttons = CRIT_LOCATIONS.map(l => ({
      action: l.id,
      label:  game.i18n.localize(l.label),
      icon:   "fa-solid fa-crosshairs",
    }));
    const locId = await new Promise(resolve => {
      new foundry.applications.api.DialogV2({
        window:  { title: game.i18n.localize("SHIPCOMBAT.Gunner.Core.CritLocTitle") },
        content: `<p>${game.i18n.localize("SHIPCOMBAT.Gunner.Core.CritLocPrompt")}</p>`,
        buttons,
        close:  () => resolve(null),
        submit: r  => resolve(r),
      }).render(true);
    });
    if (!locId) return; // cancelled  -  do NOT consume core
    const played = [...(sys.resources?.gunner?.coreActionsPlayed ?? []), "chooseCritLoc"];
    emitToGM("updateResource", { roleId: "gunner", key: "coreActionsPlayed", value: played });
    emitToGM("markOvercharge", { roleId: "gunner" });
    emitToGM("updateResource", { roleId: "gunner", key: "chooseCritLocation", value: true });
    emitToGM("updateResource", { roleId: "gunner", key: "critLocationChoice",  value: locId });
  } else if (action === "emergencyResupply") {
    // Emergency Resupply: immediately replenish 25% ammo from reserves
    const caps    = _getOrdnanceBayCaps(this.actor);
    const current = sys.resources?.gunner?.ammo ?? 0;
    const gain    = Math.max(1, Math.ceil(caps.ammoMax * 0.25));
    const next    = Math.min(caps.ammoMax, current + gain);
    const played  = [...(sys.resources?.gunner?.coreActionsPlayed ?? []), "emergencyResupply"];
    emitToGM("updateResource", { roleId: "gunner", key: "coreActionsPlayed", value: played });
    emitToGM("markOvercharge", { roleId: "gunner" });
    emitToGM("updateResource", { roleId: "gunner", key: "ammo", value: next });
  }
}

/**
 * Fire weapon  -  opens the targeting popup for a weapon with a specific fire mode.
 * Reads data-weapon-id, data-fire-mode from the button.
 * Replaces the base impmal `rollTest` action for this sheet.
 */
async function _onFireWeapon(event, target) {
  const weaponId = target.closest("[data-id]")?.dataset.id ?? target.dataset.weaponId;
  const fireMode = target.dataset.fireMode;
  if (!weaponId || !fireMode) return;

  const weapon = this.actor.items.get(weaponId);
  if (!weapon) return;

  // Validate resource availability
  const sys = this.actor.system;

  const gunnerRes = sys.resources?.gunner ?? {};
  const weaponType = weapon.system.resourceType;

  if (weaponType === "ammo") {
    const tier = MACRO_FIRE_TIERS.find(t => t.id === fireMode);
    if (!tier) return;
    const ammo = gunnerRes.ammo ?? 0;
    if (ammo < tier.ammo) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAmmo"));
    }
  } else if (weaponType === "heat") {
    const heat = sys.resources?.engineer?.heat ?? 0;
    const heatMax = _getHeatCapacity(this.actor);
    const traits = weapon.system?.traits ?? {};
    const heatPerShot = 1;
    const heatCost = heatPerShot * Math.max(1, weapon.system?.salvoSize ?? 1);
    if (heat + heatCost > heatMax) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.HeatMaxed"));
    }
  } else if (weaponType === "power") {
    const power = sys.resources?.engineer?.auxiliaryPower ?? 0;
    if (power <= 0) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
    }
  }

  // Check range & degreeOfFire are configured
  if (!weapon.system.range || !weapon.system.degreeOfFire) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.WeaponNotConfigured"));
  }

  const popup = new TargetingPopup({ weapon, fireMode });
  popup.render(true);
}

/**
 * Override the base rollTest action so weapon fire buttons don't fall through
 * to impmal's standard WeaponTestDialog (which expects hasAmmo()).
 */
async function _onRollTest(event, target) {
  const type = target.dataset.type;
  if (type === "weapon") {
    return _onFireWeapon.call(this, event, target);
  }
}

// ── Context builder ──────────────────────────────────────────────────────────

/**
 * Enrich a single weapon item with fire-mode details for the template.
 */
function _enrichWeapon(item, gunnerCtx) {
  const sys = item.system;
  const type = sys.resourceType;
  const enriched = {
    id:        item.id,
    uuid:      item.uuid,
    name:      item.name,
    img:       item.img,
    system:    sys,
    traitsHtml: sys.traitsHtml ?? "",
    traitTags: _buildTraitTags(sys.traits, sys.resource),
    isMisconfigured: !sys.range || !sys.degreeOfFire,
  };

  if (type === "ammo") {
    const baseSalvo = sys.salvoSize ?? 1;
    enriched.fireTiers = MACRO_FIRE_TIERS.map(tier => {
      const totalSalvo = Math.ceil(baseSalvo * tier.salvoMult);
      return {
        id:         tier.id,
        label:      game.i18n.localize(tier.label),
        desc:       tier.desc ? game.i18n.localize(tier.desc) : null,
        ammo:       tier.ammo,
        hitMod:     tier.hitMod,
        salvoSize:  totalSalvo,
        canAfford:  (gunnerCtx.ammo >= tier.ammo),
        isExclusive: tier.exclusive,
      };
    });
  }

  if (type === "heat") {
    const dmgBonus = 0;
    const traits = sys.traits ?? {};
    const heatPerShot = 1;
    const salvoSize = sys.salvoSize ?? 1;
    const heatCost = heatPerShot * salvoSize;
    enriched.plasma = {
      heatPerShot,
      heatPerVolley: heatCost,
      dmgBonus,
      baseDamage:   sys.damage,
      totalDamage:  sys.damage + dmgBonus,
      salvoSize,
      canFire:      (gunnerCtx.heat + heatCost <= gunnerCtx.heatMax),
      shotsRemaining: Math.max(0, Math.floor((gunnerCtx.heatMax - gunnerCtx.heat) / Math.max(1, heatPerShot))),
    };
  }

  if (type === "power") {
    const power = gunnerCtx.power;
    const step = sys.chargeStep || 5;
    const tiers = buildChargeTiers(step);
    const maxCharge = step * 4;
    const effectiveCharge = Math.min(power, maxCharge);
    enriched.lance = {
      power,
      powerMax:   gunnerCtx.powerMax,
      powerPct:   gunnerCtx.powerPct,
      canFire:     power > 0,
      tiers: tiers.map(t => ({
        label:      game.i18n.localize(t.label),
        min:        t.min,
        max:        t.max,
        multiplier: t.multiplier,
        isActive:   effectiveCharge >= t.min && effectiveCharge <= t.max,
        damage:     Math.round(sys.damage * t.multiplier),
      })),
      activeTier: tiers.find(t => effectiveCharge >= t.min && effectiveCharge <= t.max),
    };
    if (enriched.lance.activeTier) {
      enriched.lance.activeDamage = Math.round(sys.damage * enriched.lance.activeTier.multiplier);
      enriched.lance.activeTierLabel = game.i18n.localize(enriched.lance.activeTier.label);
    }
  }

  if (type === "pointDefense") {
    enriched.pd = {
      canFire: true,
    };
  }

  return enriched;
}

/**
 * Build an array of trait tag objects for display on weapon cards.
 */
function _buildTraitTags(traits, resourceType) {
  if (!traits) return [];
  const tags = [];
  const _tag = (key, label, desc, value = null) => {
    const badge = value !== null ? `${label} (${value})` : label;
    const tooltip = desc ? `${badge}  -  ${desc}` : badge;
    return { key, label, value, tooltip };
  };
  if (traits.shieldBypass)
    tags.push(_tag("shieldBypass",      game.i18n.localize("SHIPCOMBAT.Trait.ShieldBypass"),      game.i18n.localize("SHIPCOMBAT.Trait.ShieldBypassDesc")));
  if (traits.unlimitedRof)
    tags.push(_tag("unlimitedRof",      game.i18n.localize("SHIPCOMBAT.Trait.UnlimitedRof"),      game.i18n.localize("SHIPCOMBAT.Trait.UnlimitedRofDesc")));
  if (traits.shieldBurn > 0 && traits.shieldBurnEnabled)
    tags.push(_tag("shieldBurn",        game.i18n.localize("SHIPCOMBAT.Trait.ShieldBurn"),        game.i18n.localize("SHIPCOMBAT.Trait.ShieldBurnDesc"),        traits.shieldBurn));
  if (traits.rend > 0 && traits.rendEnabled)
    tags.push(_tag("rend",              game.i18n.localize("SHIPCOMBAT.Trait.Rend"),              game.i18n.localize("SHIPCOMBAT.Trait.RendDesc"),              traits.rend));
  if (traits.armourPenetration > 0 && traits.armourPenetrationEnabled)
    tags.push(_tag("armourPenetration", game.i18n.localize("SHIPCOMBAT.Trait.ArmourPenetration"), game.i18n.localize("SHIPCOMBAT.Trait.ArmourPenetrationDesc"), traits.armourPenetration));
  if (traits.devastating > 0 && traits.devastatingEnabled)
    tags.push(_tag("devastating",       game.i18n.localize("SHIPCOMBAT.Trait.Devastating"),       game.i18n.localize("SHIPCOMBAT.Trait.DevastatingDesc"),       traits.devastating));
  if (traits.unreliable)
    tags.push(_tag("unreliable",        game.i18n.localize("SHIPCOMBAT.Trait.Unreliable"),        game.i18n.localize("SHIPCOMBAT.Trait.UnreliableDesc")));
  if (traits.overcharge && resourceType === "heat")
    tags.push(_tag("overcharge",        game.i18n.localize("SHIPCOMBAT.Trait.Overcharge"),        game.i18n.localize("SHIPCOMBAT.Trait.OverchargeDesc")));
  if (traits.hitRatingModifier !== 0 && traits.hitRatingModifier !== undefined && traits.hitRatingModifierEnabled) {
    const val = traits.hitRatingModifier > 0 ? `+${traits.hitRatingModifier}` : traits.hitRatingModifier;
    tags.push(_tag("hitRatingModifier", game.i18n.localize("SHIPCOMBAT.Trait.HitRatingModifier"), game.i18n.localize("SHIPCOMBAT.Trait.HitRatingModifierDesc"), val));
  }
  return tags;
}

export function buildGunnerContext(sys, opts = {}) {
  const ammo   = sys.resources?.gunner?.ammo ?? 0;
  const auxiliaryPower = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const heat   = sys.resources?.engineer?.heat ?? 0;
  const gunner = sys.resources?.gunner ?? {};

  const { reactorStats, ordnanceBayStats } = opts;
  const heatMax   = reactorStats?.heatCapacity ?? 0;
  const ammoMax   = ordnanceBayStats?.ammoCapacity ?? 0;
  const powerMax = reactorStats?.auxPowerCapacity ?? 0;

  const ordnanceSL      = gunner.ordnanceSL ?? 0;
  const allocAccuracy   = gunner.allocAccuracy ?? 0;
  const allocPenetration = gunner.allocPenetration ?? 0;
  const allocFirepower  = gunner.allocFirepower ?? 0;
  const slLocked        = gunner.slLocked ?? false;
  const ordnanceRolled  = gunner.ordnanceRolled ?? false;
  const remainingSL     = ordnanceSL - allocAccuracy - allocPenetration - allocFirepower;

  const hasCoreAssigned = (sys.resources?.gunner?.coreCount ?? 0) > 0;
  const isCoreSpent     = false;  // deprecated  -  coreCount drives availability now
  const canConsumeCore  = hasCoreAssigned;

  // ── Captain card: Inspired Targeting ────────────────────────────────────────
  const captainHitBonus = sys.resources?.gunner?.captainHitBonus ?? 0;
  const GUNNER_BOOST_CARDS = ["gunsHot", "inspiredTargeting"];
  const captainPlayedCards = sys.resources?.captain?.playedCards ?? [];
  const captainBoosts = captainPlayedCards
    .filter(id => GUNNER_BOOST_CARDS.includes(id))
    .map(id => ({
      id,
      label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${id}`),
    }));

  const coreActions = GUNNER_CORE_ACTIONS.map(a => ({
    ...a,
    labelLocalized: game.i18n.localize(a.label),
    descLocalized:  game.i18n.localize(a.desc),
    canAfford: canConsumeCore,
  }));

  const coreActivatedLabel = null;  // Actions played are shown in the top bar banner

  // Played core actions this turn (for banner display)
  const coreActionsPlayed = sys.resources?.gunner?.coreActionsPlayed ?? [];
  const coreActionsPlayedLabels = coreActionsPlayed.map(id => {
    const entry = GUNNER_CORE_ACTIONS.find(a => a.id === id);
    return entry ? game.i18n.localize(entry.label) : id;
  });

  // ── Crit condition / stance effects ──────────────────────────────────────────────────
  const conditions        = sys.conditions ?? {};
  const weaponsSensorsTier = conditions.weaponsSensors?.tier;
  const blindedSectionId    = conditions.weaponsSensors?.blindedSectionId ?? null;
  const fireControlPenalty  = weaponsSensorsTier === "high" ? -20 : 0;
  const stance             = sys.resources?.captain?.stance ?? "none";
  const stanceHitMod       = stance === "aggressive" ? 10 : stance === "defensive" ? -10 : 0;

  return {
    ammo,
    ammoMax,
    ammoPct:    ammoMax > 0 ? Math.min(100, Math.round((ammo / ammoMax) * 100)) : 0,
    power: auxiliaryPower,
    powerMax,
    powerPct:  powerMax > 0 ? Math.min(100, Math.round((auxiliaryPower / powerMax) * 100)) : 0,
    heat,
    heatMax,
    heatPct:    heatMax > 0 ? Math.round((heat / heatMax) * 100) : 0,
    heatColor:  heatColor(heatMax > 0 ? Math.round((heat / heatMax) * 100) : 0),
    hasCoreAssigned,
    isCoreSpent,
    canConsumeCore,
    hasCaptainFreeCore: false,
    coreActionsPlayedLabels,
    coreActions,
    coreActivatedLabel,
    // SL allocation
    ordnanceRolled,
    ordnanceSL,
    allocAccuracy,
    allocPenetration,
    allocFirepower,
    slLocked,
    remainingSL,
    allocLocked: slLocked || !ordnanceRolled,
    // Arc overlay
    arcOverlayActive:    gunner.arcOverlayActive ?? false,
    chooseCritLocation:  gunner.chooseCritLocation ?? false,
    // Condition / stance
    stanceHitMod,
    captainHitBonus,
    captainBoosts,
    fireControlPenalty,
    blindedSectionId,
    hasGunnerCondition: fireControlPenalty !== 0 || blindedSectionId !== null || stanceHitMod !== 0,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

export { _enrichWeapon as enrichWeaponForGunner };

export const GUNNER_ACTIONS = {
  rollOrdnance:     _onRollOrdnance,
  allocGunnerSL:    _onAllocGunnerSL,
  gunnerCoreAction: _onGunnerCoreAction,
  fireWeapon:       _onFireWeapon,
  rollTest:         _onRollTest,
};
