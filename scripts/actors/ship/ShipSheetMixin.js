/**
 * ShipSheetMixin – system-agnostic player ship actor sheet.
 *
 * Usage:
 *   import { ShipSheetMixin } from ".../ShipSheetMixin.js";
 *   export class ShipSheet extends ShipSheetMixin(SystemAdapter.current.SheetBaseClass) {}
 *
 * DEFAULT_OPTIONS.classes is intentionally empty — the concrete class injects
 * system-specific CSS classes.
 */

import {
  MODULE_ID, CORE_MODULE_ID,
  ROLES, ROLE_ACTIONS, SHIP_CLASSIFICATIONS, PAYLOAD_TYPES, CRIT_CONDITIONS, CRIT_LOCATIONS,
} from "../../constants.js";
import { isTorpedo, isStrikeCraft } from "../ordnance/ordnance-types.js";
import { emitToGM } from "../../socket.js";
import { ShipCombatState } from "../../state/ShipCombatState.js";

import { OVERVIEW_ACTIONS } from "../../roles/overview.js";
import { SHARED_ACTIONS, adjustShieldSectorDelta } from "../../roles/shared.js";
import { PILOT_ACTIONS, buildHelmContext, helmOnRender, helmUpdatePreview } from "../../roles/pilot.js";
import { ENGINEER_ACTIONS, buildEngineerContext } from "../../roles/engineer.js";
import { SENSORS_ACTIONS, buildSensorsContext } from "../../roles/sensors.js";
import { GUNNER_ACTIONS, buildGunnerContext, enrichWeaponForGunner } from "../../roles/gunner.js";
import { ORDNANCE_ACTIONS, buildOrdnanceContext } from "../../roles/ordnance.js";
import { CAPTAIN_ACTIONS, buildCaptainContext } from "../../roles/captain.js";
import { HelmPreview } from "../../canvas/HelmPreview.js";
import { WeaponArcOverlay } from "../../canvas/WeaponArcOverlay.js";
import { SensorRadar } from "../../canvas/SensorRadar.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";

// ── Constants ─────────────────────────────────────────────────────────────
const ROLE_IDS = Object.keys(ROLES);
const SECTORS  = ["bow", "stern", "port", "starboard"];
const SECTOR_ABBR = { bow: "BOW", stern: "STN", port: "PRT", starboard: "STBD" };
const WEAPON_SECTIONS = [
  { id: "prow",      label: "SHIPCOMBAT.Slot.Prow" },
  { id: "dorsal",    label: "SHIPCOMBAT.Slot.Dorsal" },
  { id: "port",      label: "SHIPCOMBAT.Slot.Port" },
  { id: "starboard", label: "SHIPCOMBAT.Slot.Starboard" },
  { id: "stern",     label: "SHIPCOMBAT.Slot.Stern" },
];
const EQUIPMENT_SECTIONS = [
  { id: "shields",    label: "SHIPCOMBAT.Slot.Shields" },
  { id: "armour",     label: "SHIPCOMBAT.Slot.Armour"  },
  { id: "engine",     label: "SHIPCOMBAT.Slot.Engine"  },
  { id: "sensor",     label: "SHIPCOMBAT.Slot.Sensor"  },
  { id: "reactor",    label: "SHIPCOMBAT.Slot.Reactor" },
  { id: "weaponsBay", label: "SHIPCOMBAT.Slot.WeaponsBay" },
];
/**
 * Default mapping from bridge role → main skill spec, sourced lazily from
 * `SystemAdapter.current.getDefaultRoleSkillMapping()` and cached for the
 * lifetime of the world. Each entry: { skillKey, specialisation, rootLabel, label }.
 */
let _roleMainSkillsCache = null;
function getRoleMainSkills() {
  if (!_roleMainSkillsCache) {
    _roleMainSkillsCache = SystemAdapter.current.getDefaultRoleSkillMapping() ?? {};
  }
  return _roleMainSkillsCache;
}

/**
 * Returns the effective skill spec string "skillKey|specialisation" for a role.
 * Uses the explicit roleSkillOverride when set; falls back to the adapter's
 * default mapping (which is what the system companion module configures at
 * startup). Exported so that role modules (e.g. pilot.js) can use the same logic.
 */
export function getEffectiveSkillSpec(sys, roleId) {
  const override = sys.roleSkillOverrides?.[roleId];
  if (override) return override;
  const def = getRoleMainSkills()[roleId];
  return def ? `${def.skillKey}|${def.specialisation}` : null;
}

function _norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getRoleMainSkillData(actor, roleId) {
  const cfg = getRoleMainSkills()[roleId];
  if (!cfg) return { label: "", value: null };
  const skill = actor?.system?.skills?.[cfg.skillKey];
  const list = Array.isArray(skill?.specialisations) ? skill.specialisations : [];
  const spec = list.find(s => _norm(s?.name).includes(_norm(cfg.specialisation)));
  const total = Number(spec?.system?.total ?? skill?.total ?? NaN);
  return {
    label: game.i18n.localize(cfg.label),
    value: Number.isFinite(total) ? total : null,
    hasValue: Number.isFinite(total),
  };
}

function getComponentSlot(item) {
  return item.system?.slot ?? "prow";
}

function _resolveRollLabel(sys, roleId, fallbackLocKey) {
  const effective = getEffectiveSkillSpec(sys, roleId);
  if (effective?.includes("|")) {
    const idx  = effective.indexOf("|");
    const spec = effective.slice(idx + 1);
    const key  = effective.slice(0, idx);
    const skillName = SystemAdapter.current.getSkillLabel(key);
    return `Roll ${spec || skillName}`;
  }
  return game.i18n.localize(fallbackLocKey);
}

function _resolveSlLabel(sys, roleId, fallbackLocKey) {
  const effective = getEffectiveSkillSpec(sys, roleId);
  if (effective?.includes("|")) {
    const idx  = effective.indexOf("|");
    const spec = effective.slice(idx + 1);
    const key  = effective.slice(0, idx);
    const skillName = SystemAdapter.current.getSkillLabel(key);
    return `${spec || skillName} SL`;
  }
  return game.i18n.localize(fallbackLocKey);
}

const ROLE_SL_TOOLTIP_CFG = {
  captain:  { slName: "Command",         allocs: ["Inspire", "Resolve", "Initiative"] },
  gunner:   { slName: "Gunnery",         allocs: ["Accuracy", "Penetration", "Firepower"] },
  ordnance: { slName: "Ordnance Master", allocs: ["Efficiency", "Expedience"] },
};

function _resolveSlTooltip(sys, roleId, fallbackLocKey) {
  const effective = getEffectiveSkillSpec(sys, roleId);
  const cfg = ROLE_SL_TOOLTIP_CFG[roleId];
  if (!cfg || !effective?.includes("|")) return game.i18n.localize(fallbackLocKey);
  const idx  = effective.indexOf("|");
  const key  = effective.slice(0, idx);
  const spec = effective.slice(idx + 1);
  const skillName    = SystemAdapter.current.getSkillLabel(key);
  const skillDisplay = spec ? `${skillName} (${spec})` : skillName;
  const allocs = cfg.allocs;
  const allocStr = allocs.length === 2
    ? `${allocs[0]} and ${allocs[1]}`
    : `${allocs.slice(0, -1).join(", ")}, and ${allocs[allocs.length - 1]}`;
  return `Roll ${skillDisplay} to generate ${cfg.slName} SL for ${allocStr} allocation.`;
}

function buildSectionedItems(definitions, items, slotConfig, keyFn = getComponentSlot) {
  return definitions.map(def => {
    const sectionItems = items.filter(item => keyFn(item) === def.id);
    const slotCount = Math.max(0, Number(slotConfig?.[def.id] ?? 0));
    return {
      ...def,
      labelLocalized: game.i18n.localize(def.label),
      slotCount,
      emptySlots: Math.max(0, slotCount - sectionItems.length),
      items: sectionItems,
    };
  });
}

// ── Mixin ─────────────────────────────────────────────────────────────────

export const ShipSheetMixin = (BaseClass) => {
  class ShipSheetBase extends BaseClass {

    _resolveRoleForUser(user = game.user) {
      const sys = this.actor.system;
      const direct = sys.roles?.[user.id] ?? null;
      if (direct) return direct;
      const crewActors = sys.crewActors ?? {};
      for (const [roleId, ref] of Object.entries(crewActors)) {
        const actor = ref?.id ? game.actors.get(ref.id) : null;
        if (!actor) continue;
        if (user.character?.id && user.character.id === actor.id) return roleId;
        const level = Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0);
        if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return roleId;
      }
      return null;
    }

    get isEditable() { return true; }

    static DEFAULT_OPTIONS = {
      // classes intentionally empty — concrete class provides system-specific classes
      classes: [],
      actions: {
        ...OVERVIEW_ACTIONS,
        ...SHARED_ACTIONS,
        ...PILOT_ACTIONS,
        ...ENGINEER_ACTIONS,
        ...SENSORS_ACTIONS,
        ...GUNNER_ACTIONS,
        ...ORDNANCE_ACTIONS,
        ...CAPTAIN_ACTIONS,
        openItem:            ShipSheetBase._onOpenItem,
        openOrdnanceActor:   ShipSheetBase._onOpenOrdnanceActor,
        removeOrdnanceActor: ShipSheetBase._onRemoveOrdnanceActor,
        clearOrdnanceSlot:   ShipSheetBase._onClearOrdnanceSlot,
        addToInventory:      ShipSheetBase._onAddToInventory,
        unassignWeapon:      ShipSheetBase._onUnassignWeapon,
        unassignEquipment:   ShipSheetBase._onUnassignEquipment,
      },
      position: { width: 720, height: 820 },
      defaultTab: "overview",
    };

    static PARTS = {
      header:        { template: `modules/${CORE_MODULE_ID}/templates/actor/partials/ship-header.hbs`,     classes: ["vehicle-header"], scrollable: [""] },
      tabs:          { template: "templates/generic/tab-navigation.hbs" },
      overview:      { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/ship-overview.hbs`,        scrollable: [""] },
      captain:       { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/captain.hbs`,            scrollable: [""] },
      captain4man:   { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/4/captain.hbs`,            scrollable: [""] },
      captain5man:   { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/captain.hbs`,            scrollable: [""] },
      engineer3man: { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/3/engineer.hbs`,          scrollable: [""] },
      engineer5man: { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/engineer.hbs`,          scrollable: [""] },
      engineer:     { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/engineer.hbs`,          scrollable: [""] },
      pilot:         { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/pilot.hbs`,              scrollable: [""] },
      sensors:       { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/sensors.hbs`,            scrollable: [""] },
      gunner4man:    { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/4/gunner.hbs`,             scrollable: [""] },
      gunner5man:    { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/gunner.hbs`,             scrollable: [""] },
      gunner:        { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/gunner.hbs`,             scrollable: [""] },
      ordnance:      { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/ordnance.hbs`,           scrollable: [""] },
      config:        { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/ship-config.hbs`,          scrollable: [""] },
    };

    static TABS = {
      overview:      { id: "overview",      group: "primary", label: "SHIPCOMBAT.Tab.Overview"    },
      captain:       { id: "captain",       group: "primary", label: "SHIPCOMBAT.Role.Captain"    },
      captain4man:   { id: "captain4man",   group: "primary", label: "SHIPCOMBAT.Role.Captain"    },
      captain5man:   { id: "captain5man",   group: "primary", label: "SHIPCOMBAT.Role.Captain"    },
      engineer3man: { id: "engineer3man", group: "primary", label: "SHIPCOMBAT.Role.Engineer"  },
      engineer5man: { id: "engineer5man", group: "primary", label: "SHIPCOMBAT.Role.Engineer"  },
      engineer:     { id: "engineer",     group: "primary", label: "SHIPCOMBAT.Role.Engineer"  },
      pilot:         { id: "pilot",         group: "primary", label: "SHIPCOMBAT.Role.Pilot"      },
      sensors:       { id: "sensors",       group: "primary", label: "SHIPCOMBAT.Role.Sensors"    },
      gunner4man:    { id: "gunner4man",    group: "primary", label: "SHIPCOMBAT.Role.Gunner"     },
      gunner5man:    { id: "gunner5man",    group: "primary", label: "SHIPCOMBAT.Role.Gunner"     },
      gunner:        { id: "gunner",        group: "primary", label: "SHIPCOMBAT.Role.Gunner"     },
      ordnance:      { id: "ordnance",      group: "primary", label: "SHIPCOMBAT.Role.Ordnance"   },
      config:        { id: "config",        group: "primary", label: "SHIPCOMBAT.Tab.Config"      },
    };

    _getDisabledRoles() {
      const crewSize = this.actor.system.crewSize ?? 6;
      const disabled = new Set();
      if (crewSize <= 5) disabled.add("ordnance");
      if (crewSize <= 4) disabled.add("sensors");
      if (crewSize <= 3) disabled.add("pilot");
      return disabled;
    }

    _allowedParts() {
      const disabled = this._getDisabledRoles();
      const useCombinedCaptain = disabled.has("ordnance");
      const useCombinedSensors = disabled.has("sensors");
      const useCombinedPilot   = disabled.has("pilot");

      if (game.user.isGM) {
        const all = new Set(Object.keys(ShipSheetBase.PARTS));
        for (const r of disabled) all.delete(r);
        if (useCombinedCaptain) {
          all.delete("captain");    all.add("captain5man");
          all.delete("engineer");  all.add("engineer5man");
          all.delete("gunner");     all.add("gunner5man");
        } else {
          all.delete("captain5man"); all.delete("engineer5man"); all.delete("gunner5man");
        }
        if (useCombinedSensors) {
          all.delete("captain5man"); all.add("captain4man");
          all.delete("gunner5man");  all.add("gunner4man");
        } else {
          all.delete("captain4man"); all.delete("gunner4man");
        }
        if (useCombinedPilot) {
          all.delete("engineer5man"); all.add("engineer3man");
        } else {
          all.delete("engineer3man");
        }
        return all;
      }

      const myRole   = this._resolveRoleForUser(game.user);
      const level    = this.actor.getUserLevel(game.user) ?? 0;
      const isOwner  = level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const canObserve = level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
      const allowed  = new Set(["header", "tabs"]);
      if (canObserve) allowed.add("overview");
      if (isOwner)    allowed.add("config");

      const effectivePart = (myRole === "engineer" && useCombinedPilot)    ? "engineer3man"
        : (myRole === "captain"   && useCombinedSensors)  ? "captain4man"
        : (myRole === "captain"   && useCombinedCaptain) ? "captain5man"
        : (myRole === "engineer" && useCombinedCaptain) ? "engineer5man"
        : (myRole === "gunner"    && useCombinedSensors)  ? "gunner4man"
        : (myRole === "gunner"    && useCombinedCaptain) ? "gunner5man"
        : myRole;
      if (effectivePart && !disabled.has(effectivePart)) allowed.add(effectivePart);
      return allowed;
    }

    _configureRenderOptions(options) {
      super._configureRenderOptions(options);
      const allowed = this._allowedParts();
      options.parts = (options.parts ?? Object.keys(ShipSheetBase.PARTS))
        .filter(p => allowed.has(p));
    }

    _prepareTabs(options) {
      const tabs = super._prepareTabs(options);
      const allowed = this._allowedParts();
      for (const key of Object.keys(tabs)) {
        if (!allowed.has(key)) delete tabs[key];
      }
      const tabToRole = {
        captain: "captain", captain4man: "captain", captain5man: "captain",
        engineer: "engineer", engineer3man: "engineer", engineer5man: "engineer",
        pilot: "pilot", sensors: "sensors",
        gunner: "gunner", gunner4man: "gunner", gunner5man: "gunner",
        ordnance: "ordnance",
      };
      const roleTitles = this.actor.system?.roleTitles ?? {};
      for (const [tabId, roleId] of Object.entries(tabToRole)) {
        if (tabs[tabId] && roleTitles[roleId]) {
          tabs[tabId].label = roleTitles[roleId];
        }
      }
      return tabs;
    }

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const sys     = this.actor.system;
      const userId  = game.user.id;
      const myRole  = this._resolveRoleForUser(game.user);
      const stagedCoresMap = sys.resources?.engineer?.stagedCores ?? {};

      const disabledRoles = this._getDisabledRoles();
      const crewSize = sys.crewSize ?? 6;

      const allSkillOptions = await SystemAdapter.current.getRoleSkillOptions();

      const rolesArray = await Promise.all(ROLE_IDS.filter(id => !disabledRoles.has(id)).map(async roleId => {
        const role         = ROLES[roleId];
        const assignEntry  = Object.entries(sys.roles ?? {}).find(([, r]) => r === roleId);
        const assignedUid  = assignEntry?.[0] ?? null;
        const assignedUser = assignedUid ? game.users.get(assignedUid) : null;
        const actorRef     = sys.crewActors?.[roleId] ?? null;
        let assignedActor  = null;
        if (actorRef?.uuid) {
          try { assignedActor = await fromUuid(actorRef.uuid); }
          catch (e) { assignedActor = null; }
        }
        const actions         = ROLE_ACTIONS[roleId];
        const turnDone        = sys.turnDone?.[roleId] ?? false;
        const overchargedUsed = sys.overchargeUsed?.[roleId] ?? false;
        const mainSkill       = assignedActor ? getRoleMainSkillData(assignedActor, roleId) : { label: "", value: null };
        const override        = sys.roleSkillOverrides?.[roleId];
        const roleDef         = getRoleMainSkills()[roleId];
        const defaultSkillLabel  = roleDef ? game.i18n.localize(roleDef.label) : "";
        const defaultSkillVal    = roleDef ? `${roleDef.skillKey}|${roleDef.specialisation}` : null;
        const currentSkillOverride = override ?? defaultSkillVal;

        const skillOptions = allSkillOptions.map(opt => {
          let label = opt.label;
          if (assignedActor) {
            const skillData = assignedActor.system?.skills?.[opt.skillKey];
            const specList  = Array.isArray(skillData?.specialisations) ? skillData.specialisations : [];
            const specItem  = specList.find(s => _norm(s?.name) === _norm(opt.specName));
            const score     = Number(specItem?.system?.total ?? skillData?.total ?? NaN);
            if (Number.isFinite(score)) label = `${opt.label} [${score}]`;
          }
          return { ...opt, label, selected: opt.value === currentSkillOverride };
        });

        const payloadId  = sys.resources?.[roleId]?.payload ?? "";
        const payloadDef = payloadId ? PAYLOAD_TYPES[payloadId] : null;

        return {
          ...role,
          labelLocalized:    sys.roleTitles?.[roleId] || game.i18n.localize(role.label),
          defaultLabel:      game.i18n.localize(role.label),
          assignedUser,
          actorRef,
          assignedActor: assignedActor ? {
            id: assignedActor.id, uuid: assignedActor.uuid,
            name: assignedActor.name, img: assignedActor.img,
          } : (actorRef ?? null),
          assignedUserId: assignedUid,
          isMyRole:       assignedUid === userId,
          hasCoreAssigned: !!(sys.assignedCores?.[roleId]) && sys.assignedCores?.[roleId] !== "spent",
          hasCaptainFreeCore: false,
          isCoreSpent: false,
          coreCount:    sys.resources?.[roleId]?.coreCount ?? 0,
          hasCoreStaged: !!(stagedCoresMap[roleId]),
          standardUsed:  turnDone,
          overchargedUsed,
          turnDone,
          actionAvailable: !turnDone,
          mainSkill,
          defaultSkillLabel,
          currentSkillOverride,
          skillOptions,
          standardAction:    { label: game.i18n.localize(actions.standard.label),    desc: game.i18n.localize(actions.standard.desc)    },
          overchargedAction: { label: game.i18n.localize(actions.overcharged.label), desc: game.i18n.localize(actions.overcharged.desc) },
          payloadId,
          payloadLabel: payloadDef ? game.i18n.localize(payloadDef.label) : "",
          payloadDesc:  payloadDef ? game.i18n.localize(payloadDef.desc)  : "",
        };
      }));

      const roles = {};
      for (const r of rolesArray) roles[r.id] = r;

      const myRoleData   = myRole ? roles[myRole] : null;
      const hasPowerCore = (sys.resources?.pilot?.coreCount ?? 0) > 0;
      const shieldCfg    = ShipCombatState.getShieldStats();

      const sectors = SECTORS.map(sector => ({
        id:            sector,
        label:         game.i18n.localize(`SHIPCOMBAT.Sector.${sector.charAt(0).toUpperCase() + sector.slice(1)}`),
        armour:        sys.armour?.[sector]  ?? 0,
        shield:        sys.shields?.[sector] ?? 0,
        zoneThreshold: shieldCfg.zoneThresholds?.[sector] ?? 8,
      }));

      const powerCoresMax         = ShipCombatState.getReactorStats(this.actor).coreOutput;
      const stagedCoreCount       = Object.values(stagedCoresMap).filter(Boolean).length;
      const stagedShieldCoreCount = sys.resources?.engineer?.stagedShieldCores ?? 0;
      const stagedAuxCoreCount    = sys.resources?.engineer?.stagedAuxCores ?? 0;
      const committedAuxCoreCount = sys.resources?.engineer?.committedAuxCores ?? 0;
      const shieldCommittedCount  = sys.shieldPool?.committed ?? 0;
      const assignedCoreCount     = Object.values(sys.assignedCores ?? {}).filter(Boolean).length;
      const distributedCores      = stagedCoreCount + stagedShieldCoreCount + stagedAuxCoreCount + committedAuxCoreCount + shieldCommittedCount + assignedCoreCount;
      const powerCoresAvailable   = Math.max(0, powerCoresMax - distributedCores);
      const totalCoreCount        = powerCoresAvailable + distributedCores;

      const components          = this.actor.items.filter(i => i.type === `${MODULE_ID}.component`);
      const equippedComponents  = components.filter(c => c.system.equipped !== false);
      const weaponComponents    = equippedComponents.filter(c => c.system.slot === "weapon");
      const equipmentComponents = equippedComponents.filter(c => c.system.slot !== "weapon" && !["torpedo", "strikeCraft"].includes(c.system.slot));

      const ownerLevel   = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const observerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
      const userLevel    = this.actor.getUserLevel(game.user) ?? 0;

      const _ordnanceValidIds = new Set([
        ...(sys.ordnanceActors?.torpedo     ?? []).filter(Boolean).map(e => e.id).filter(Boolean),
        ...(sys.ordnanceActors?.strikeCraft ?? []).filter(Boolean).map(e => e.id).filter(Boolean),
      ]);

      Object.assign(context, {
        sys,
        isGM:              game.user.isGM,
        isOwner:           userLevel >= ownerLevel,
        canObserve:        userLevel >= observerLevel,
        canEditComponents: userLevel >= observerLevel || game.user.isGM,
        myUserId:          userId,
        myRole,
        myRoleData,
        hasPowerCore,
        roles,
        sectors,
        powerCoresAvailable,
        powerCoresMax,
        powerCorePips: Array.from({ length: totalCoreCount }, (_, i) => {
          if (i < assignedCoreCount) return { state: "assigned" };
          if (i < assignedCoreCount + stagedCoreCount) return { state: "staged" };
          if (i < assignedCoreCount + stagedCoreCount + stagedShieldCoreCount) return { state: "shield-staged" };
          if (i < assignedCoreCount + stagedCoreCount + stagedShieldCoreCount + shieldCommittedCount) return { state: "shield-committed" };
          if (i < assignedCoreCount + stagedCoreCount + stagedShieldCoreCount + shieldCommittedCount + stagedAuxCoreCount) return { state: "aux-staged" };
          if (i < assignedCoreCount + stagedCoreCount + stagedShieldCoreCount + shieldCommittedCount + stagedAuxCoreCount + committedAuxCoreCount) return { state: "aux-committed" };
          return { state: "available" };
        }),
        shipSectors: sectors.map(sector => ({
          ...sector,
          abbr:          SECTOR_ABBR[sector.id] ?? sector.id.toUpperCase(),
          shieldLabel:   game.i18n.localize("SHIPCOMBAT.Label.Shield"),
          armourLabel:   game.i18n.localize("SHIPCOMBAT.Label.Armour"),
          armourRendVal: sys.armourRend?.[sector.id] ?? 0,
        })),
        weaponSections: buildSectionedItems(
          WEAPON_SECTIONS, weaponComponents, sys.weaponSlots,
          item => {
            const pos = item.system?.weaponPosition ?? "prow";
            return pos === "flank" ? (item.system?.weaponBay ?? "port") : pos;
          },
        ).filter(s => s.slotCount > 0),
        weaponSectionsAll: (() => {
          const unequipped = components.filter(c => c.system.slot === "weapon" && c.system.equipped === false);
          return buildSectionedItems(
            WEAPON_SECTIONS, weaponComponents, sys.weaponSlots,
            item => {
              const pos = item.system?.weaponPosition ?? "prow";
              return pos === "flank" ? (item.system?.weaponBay ?? "port") : pos;
            },
          ).map(s => ({
            ...s,
            slotFull: s.slotCount > 0 && s.items.length >= s.slotCount,
            inventory: unequipped.filter(c => {
              const pos = c.system.weaponPosition ?? "prow";
              if (s.id === "prow")     return pos === "prow";
              if (s.id === "dorsal")   return pos === "dorsal";
              if (s.id === "stern")    return pos === "stern";
              return pos === "flank";
            }).map(c => ({ id: c.id, name: c.name })),
          }));
        })(),
        equipmentSections: buildSectionedItems(EQUIPMENT_SECTIONS, equipmentComponents, sys.equipmentSlots)
          .filter(s => s.items.length > 0 || s.slotCount > 0),
        ordnanceActors:    sys.ordnanceActors ?? { torpedo: [], strikeCraft: [] },
        ordnanceSlotCount: Math.max(0, Number(sys.ordnanceSlots?.ordnance ?? 1)),
        ordnanceSelectorSlots: (() => {
          const slotMax     = Math.max(0, Number(sys.ordnanceSlots?.ordnance ?? 1));
          const activeOrd   = sys.activeOrdnance ?? [];
          const useStrikeCraft = sys.useStrikeCraft !== false;
          const tArr        = (sys.ordnanceActors?.torpedo ?? []).filter(Boolean);
          const scArr       = useStrikeCraft ? (sys.ordnanceActors?.strikeCraft ?? []).filter(Boolean) : [];
          const inventory   = [
            ...tArr.map(e =>  ({ id: e.id, name: e.name, img: e.img ?? null, slotType: "torpedo",     value: `torpedo:${e.id}`     })),
            ...scArr.map(e => ({ id: e.id, name: e.name, img: e.img ?? null, slotType: "strikeCraft", value: `strikeCraft:${e.id}` })),
          ];
          return Array.from({ length: slotMax }, (_, i) => {
            const active = activeOrd[i] ?? null;
            const found  = (active?.actorId && _ordnanceValidIds.has(active.actorId)) ? inventory.find(t => t.id === active.actorId) : null;
            return {
              index:       i,
              slotNum:     i + 1,
              activeType:  active?.type    ?? null,
              activeId:    active?.actorId ?? null,
              activeName:  found?.name     ?? null,
              activeImg:   found?.img      ?? null,
              activeValue: active?.type && active?.actorId ? `${active.type}:${active.actorId}` : "",
            };
          });
        })(),
        ordnanceInventory: (() => {
          const useStrikeCraft = sys.useStrikeCraft !== false;
          const tArr  = (sys.ordnanceActors?.torpedo ?? []).filter(Boolean);
          const scArr = useStrikeCraft ? (sys.ordnanceActors?.strikeCraft ?? []).filter(Boolean) : [];
          const loadedIds = new Set((sys.activeOrdnance ?? []).filter(a => a?.actorId && _ordnanceValidIds.has(a.actorId)).map(a => a.actorId));
          return [
            ...tArr.filter(e => !loadedIds.has(e.id)).map(e => ({ id: e.id, name: e.name, img: e.img ?? null, slotType: "torpedo",     value: `torpedo:${e.id}`     })),
            ...scArr.filter(e => !loadedIds.has(e.id)).map(e => ({ id: e.id, name: e.name, img: e.img ?? null, slotType: "strikeCraft", value: `strikeCraft:${e.id}` })),
          ];
        })(),
        ordnanceOccupiedCount: (() => {
          const slotMax = Math.max(0, Number(sys.ordnanceSlots?.ordnance ?? 1));
          const active  = sys.activeOrdnance ?? [];
          let count = 0;
          for (let i = 0; i < slotMax; i++) { if (active[i]?.actorId && _ordnanceValidIds.has(active[i].actorId)) count++; }
          return count;
        })(),
        ordnanceHasRoom: (() => {
          const slotMax  = Math.max(0, Number(sys.ordnanceSlots?.ordnance ?? 1));
          const active   = sys.activeOrdnance ?? [];
          const occupied = active.slice(0, slotMax).filter(a => a?.actorId && _ordnanceValidIds.has(a.actorId)).length;
          return occupied < slotMax;
        })(),
        nextOrdnanceSlotIndex: (() => {
          const slotMax = Math.max(0, Number(sys.ordnanceSlots?.ordnance ?? 1));
          const active  = sys.activeOrdnance ?? [];
          for (let i = 0; i < slotMax; i++) { if (!active[i]?.actorId || !_ordnanceValidIds.has(active[i].actorId)) return i; }
          return slotMax;
        })(),
        components,
        weaponComponents,
        equipmentComponents,
        shipSlotSummary: (() => {
          const getWeaponPos = item => {
            const pos = item.system?.weaponPosition ?? "prow";
            return pos === "flank" ? (item.system?.weaponBay ?? "port") : pos;
          };
          const weaponGrid = weaponComponents.length > 0 ? [
            { pos: "prow",      label: game.i18n.localize("SHIPCOMBAT.Slot.Prow"),      items: weaponComponents.filter(c => getWeaponPos(c) === "prow"),      slotCount: Math.max(0, Number(sys.weaponSlots?.prow      ?? 0)) },
            { pos: "dorsal",    label: game.i18n.localize("SHIPCOMBAT.Slot.Dorsal"),    items: weaponComponents.filter(c => getWeaponPos(c) === "dorsal"),    slotCount: Math.max(0, Number(sys.weaponSlots?.dorsal    ?? 0)) },
            { pos: "port",      label: game.i18n.localize("SHIPCOMBAT.Slot.Port"),      items: weaponComponents.filter(c => getWeaponPos(c) === "port"),      slotCount: Math.max(0, Number(sys.weaponSlots?.port      ?? 0)) },
            { pos: "starboard", label: game.i18n.localize("SHIPCOMBAT.Slot.Starboard"), items: weaponComponents.filter(c => getWeaponPos(c) === "starboard"), slotCount: Math.max(0, Number(sys.weaponSlots?.starboard ?? 0)) },
            { pos: "stern",     label: game.i18n.localize("SHIPCOMBAT.Slot.Stern"),     items: weaponComponents.filter(c => getWeaponPos(c) === "stern"),     slotCount: Math.max(0, Number(sys.weaponSlots?.stern     ?? 0)) },
          ].filter(s => s.slotCount > 0) : null;
          const ordnanceSlotMax = Math.max(0, Number(sys.ordnanceSlots?.ordnance ?? 1));
          const equipment = [
            { slotId: "shields",    label: game.i18n.localize("SHIPCOMBAT.Slot.Shields"),    items: components.filter(c => c.system.slot === "shields") },
            { slotId: "armour",     label: game.i18n.localize("SHIPCOMBAT.Slot.Armour"),     items: components.filter(c => c.system.slot === "armour") },
            { slotId: "engine",     label: game.i18n.localize("SHIPCOMBAT.Slot.Engine"),     items: components.filter(c => c.system.slot === "engine") },
            { slotId: "sensor",     label: game.i18n.localize("SHIPCOMBAT.Slot.Sensor"),     items: components.filter(c => c.system.slot === "sensor") },
            { slotId: "reactor",    label: game.i18n.localize("SHIPCOMBAT.Slot.Reactor"),    items: components.filter(c => c.system.slot === "reactor") },
            { slotId: "weaponsBay", label: game.i18n.localize("SHIPCOMBAT.Slot.WeaponsBay"), items: components.filter(c => c.system.slot === "weaponsBay") },
          ].filter(s => s.items.length > 0);
          return { weaponGrid, equipment, hasAny: !!weaponGrid || ordnanceSlotMax > 0 || equipment.length > 0 };
        })(),
        helm: (() => {
          const h = buildHelmContext(sys, {
            engineComponent:  components.find(i => i.system.slot === "engine" && i.system.equipped !== false),
            reactorStats:     ShipCombatState.getReactorStats(this.actor),
            shipRotation:     this.actor.getActiveTokens()?.[0]?.document?.rotation ?? 0,
            velocityBearingMode: this._velocityBearingMode ?? "relative",
          });
          h.hasRamTargets = (() => {
            if (!canvas?.ready) return false;
            const token = this.actor.getActiveTokens()?.[0];
            if (!token) return false;
            const isRealistic   = game.settings.get(MODULE_ID, "movementMode") === "realistic";
            const fuelBurned    = sys.resources?.pilot?.fuelBurned ?? 0;
            const baseSpeed     = sys.movement?.speed ?? 6;
            const allocSpeed    = sys.resources?.pilot?.allocSpeed ?? 0;
            const effSpeed      = Math.max(0, baseSpeed + allocSpeed);
            const overdrive     = sys.resources?.pilot?.overdrive ?? false;
            const apBonus       = sys.resources?.pilot?.apThrustBonus ?? 0;
            const powerMax      = (overdrive ? 200 : 100) + apBonus;
            const powerRemaining = Math.max(0, powerMax - fuelBurned);
            const baseMano      = sys.movement?.maneuverability ?? 2;
            const allocMano     = sys.resources?.pilot?.allocMano ?? 0;
            const maxBearingDeg = Math.max(0, baseMano + allocMano) * 15;
            const vx            = isRealistic ? (sys.resources?.pilot?.velocityX ?? 0) : 0;
            const vy            = isRealistic ? (sys.resources?.pilot?.velocityY ?? 0) : 0;
            const carryPct      = isRealistic ? (this._helmState?.carryPct ?? 0) : 0;
            const prevTurnMove  = sys.resources?.pilot?.prevTurnMove ?? 0;
            const minMove       = Math.ceil(prevTurnMove / 2);
            const minMovePx     = (!isRealistic && fuelBurned === 0) ? minMove : 0;
            const shipBasis     = HelmPreview._tokenBasis(token);
            const gridSize      = canvas.grid.size;
            return canvas.tokens.placeables.some(t => {
              if (t === token || t.document.hidden || !t.document.actor) return false;
              const tW = t.document.width  * gridSize;
              const tH = t.document.height * gridSize;
              const tx = t.document.x + tW / 2;
              const ty = t.document.y + tH / 2;
              const reach = isRealistic
                ? HelmPreview.canReachRealistic(shipBasis, tx, ty, effSpeed, maxBearingDeg, powerRemaining, powerMax, vx, vy, carryPct)
                : HelmPreview.canReach(shipBasis, tx, ty, effSpeed, maxBearingDeg, powerRemaining, powerMax, minMovePx);
              if (!reach) return false;
              const cx   = token.document.x + token.document.width  * gridSize / 2;
              const cy   = token.document.y + token.document.height * gridSize / 2;
              const dist = Math.hypot((tx - cx) / gridSize, (ty - cy) / gridSize);
              return ShipCombatState.getEffectiveLockTier(t.id, dist) >= 1;
            });
          })();
          return h;
        })(),
        engineerCtx: buildEngineerContext(sys, {
          reactorStats: ShipCombatState.getReactorStats(this.actor),
          shieldStats:  ShipCombatState.getShieldStats(this.actor),
        }),
        sensorsCtx: buildSensorsContext(sys, {
          sensorStats:  ShipCombatState.getSensorStats(this.actor),
          reactorStats: ShipCombatState.getReactorStats(this.actor),
        }),
        gunnerCtx: (() => {
          const ctx = buildGunnerContext(sys, {
            reactorStats:     ShipCombatState.getReactorStats(this.actor),
            ordnanceBayStats: ShipCombatState.getOrdnanceBayStats(this.actor),
          });
          ctx.rollLabel = _resolveRollLabel(sys, "gunner", "SHIPCOMBAT.Gunner.RollOrdnance");
          ctx.slLabel   = _resolveSlLabel(sys, "gunner", "SHIPCOMBAT.Gunner.OrdnanceSL");
          ctx.slTooltip = _resolveSlTooltip(sys, "gunner", "SHIPCOMBAT.Gunner.OrdnanceSLTooltip");
          return ctx;
        })(),
        ordnanceCtx: (() => {
          const ctx = buildOrdnanceContext(sys, {
            shipActor:        this.actor,
            ordnanceBayStats: ShipCombatState.getOrdnanceBayStats(this.actor),
            reactorStats:     ShipCombatState.getReactorStats(this.actor),
            useStrikeCraft:   sys.useStrikeCraft !== false,
            crewScale:        sys.crewScale ?? "warship",
          });
          ctx.rollLabel = _resolveRollLabel(sys, "ordnance", "SHIPCOMBAT.Ordnance.RollRequisition");
          ctx.slLabel   = _resolveSlLabel(sys, "ordnance", "SHIPCOMBAT.Ordnance.RequisitionSL");
          ctx.slTooltip = _resolveSlTooltip(sys, "ordnance", "SHIPCOMBAT.Ordnance.RequisitionDesc");
          return ctx;
        })(),
        captainCtx: (() => {
          const ctx = buildCaptainContext(sys, {
            reactorStats: ShipCombatState.getReactorStats(this.actor),
            shieldStats:  ShipCombatState.getShieldStats(this.actor),
          });
          ctx.rollLabel = _resolveRollLabel(sys, "captain", "SHIPCOMBAT.Captain.RollLeadership");
          ctx.slLabel   = _resolveSlLabel(sys, "captain", "SHIPCOMBAT.Captain.LeadershipSL");
          ctx.slTooltip = _resolveSlTooltip(sys, "captain", "SHIPCOMBAT.Captain.LeadershipSLTooltip");
          return ctx;
        })(),
        isEngineerOrGM: game.user.isGM || myRole === "engineer",
        shipClassifications: SHIP_CLASSIFICATIONS,
        componentInventoryBySlot: (() => {
          const groups = [];
          const weaponItems = components.filter(c => c.system.slot === "weapon");
          if (weaponItems.length) {
            const WEAPON_POS_GROUPS = [
              { pos: "prow",   label: game.i18n.localize("SHIPCOMBAT.Label.WeaponBow") },
              { pos: "dorsal", label: game.i18n.localize("SHIPCOMBAT.Label.WeaponDorsal") },
              { pos: "flank",  label: game.i18n.localize("SHIPCOMBAT.Label.WeaponFlank") },
              { pos: "stern",  label: game.i18n.localize("SHIPCOMBAT.Label.WeaponStern") },
            ];
            const assigned = new Set();
            for (const { pos, label } of WEAPON_POS_GROUPS) {
              const items = weaponItems.filter(c => c.system.weaponPosition === pos)
                .map(c => { assigned.add(c.id); return { id: c.id, uuid: c.uuid, name: c.name, img: c.img, equipped: c.system.equipped !== false }; });
              if (items.length) groups.push({ slotId: `weapon-${pos}`, slotLabel: label, items });
            }
            const unassigned = weaponItems.filter(c => !assigned.has(c.id))
              .map(c => ({ id: c.id, uuid: c.uuid, name: c.name, img: c.img, equipped: c.system.equipped !== false }));
            if (unassigned.length) groups.push({ slotId: "weapon-unassigned", slotLabel: game.i18n.localize("SHIPCOMBAT.Label.Unassigned"), items: unassigned });
          }
          for (const s of EQUIPMENT_SECTIONS) {
            const items = components.filter(c => c.system.slot === s.id)
              .map(c => ({ id: c.id, uuid: c.uuid, name: c.name, img: c.img, equipped: c.system.equipped !== false }));
            if (items.length) groups.push({ slotId: s.id, slotLabel: game.i18n.localize(s.label), items });
          }
          return groups;
        })(),
        equipmentDropdowns: EQUIPMENT_SECTIONS.map(def => {
          const allOfType = components.filter(c => c.system.slot === def.id);
          const installed = allOfType.find(c => c.system.equipped !== false);
          return {
            id:            def.id,
            label:         game.i18n.localize(def.label),
            installedId:   installed?.id ?? "",
            installedName: installed?.name ?? "",
            installedImg:  installed?.img ?? "",
            options:       allOfType.map(c => ({ id: c.id, name: c.name, img: c.img, selected: c.id === (installed?.id ?? "") })),
            hasAny:        allOfType.length > 0,
          };
        }).filter(d => d.hasAny),
        weaponInventory: components.filter(c => c.system.slot === "weapon" && c.system.equipped === false),
        crewSize,
        crewSizeOptions: [
          { value: 6, label: "6", selected: crewSize === 6 },
          { value: 5, label: "5", selected: crewSize === 5 },
          { value: 4, label: "4", selected: crewSize === 4 },
          { value: 3, label: "3", selected: crewSize === 3 },
        ],
        useStrikeCraft:      sys.useStrikeCraft !== false,
        crewScaleWarship:    (sys.crewScale ?? "warship") === "warship",
        crewScaleSmallCraft: sys.crewScale === "smallcraft",
        crewScaleLabel: sys.crewScale === "smallcraft"
          ? game.i18n.localize("SHIPCOMBAT.Config.CrewScaleSmallCraft")
          : game.i18n.localize("SHIPCOMBAT.Config.CrewScaleWarship"),
        ordnanceLaunchSides: (() => {
          const SIDE_LABELS = {
            bow:       game.i18n.localize("SHIPCOMBAT.Sector.Bow"),
            port:      game.i18n.localize("SHIPCOMBAT.Sector.Port"),
            starboard: game.i18n.localize("SHIPCOMBAT.Sector.Starboard"),
            stern:     game.i18n.localize("SHIPCOMBAT.Sector.Stern"),
          };
          const SIDE_ICONS = { bow: "fa-arrow-up", port: "fa-arrow-left", starboard: "fa-arrow-right", stern: "fa-arrow-down" };
          const toArr = src => Object.entries(SIDE_LABELS).map(([key, label]) => ({
            key, label, icon: SIDE_ICONS[key], value: src?.[key] ?? (key !== "stern"),
          }));
          return {
            torpedo:    toArr(sys.ordnanceLaunchSides?.torpedo),
            strikeCraft: toArr(sys.ordnanceLaunchSides?.strikeCraft),
          };
        })(),
        allRolesReady: rolesArray.every(r => r.turnDone),
        isInCombat: !!(game.combat?.combatants?.some(c => c.actor?.id === this.actor.id)),
        isActiveCombatant: (() => {
          if (!game.combat) return false;
          const activeCombatant = game.combat.combatant;
          return !!(activeCombatant?.actor?.id === this.actor.id);
        })(),
      });

      const allEffects = Array.from(this.actor.effects ?? []);
      context.effects = {
        temporary: allEffects.filter(e => !e.disabled && e.isTemporary),
        passive:   allEffects.filter(e => !e.disabled && !e.isTemporary),
        disabled:  allEffects.filter(e => e.disabled),
      };

      const gunnerCtx = context.gunnerCtx;
      context.weaponSections = context.weaponSections.map(section => ({
        ...section,
        items: section.items.map(item => enrichWeaponForGunner(item, gunnerCtx)),
      }));

      return context;
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    static _onOpenItem(event, target) {
      const row    = target.closest("[data-id]");
      const itemId = row?.dataset?.id;
      if (!itemId) return;
      this.actor.items.get(itemId)?.sheet?.render(true);
    }

    static async _onOpenOrdnanceActor(event, target) {
      const row      = target.closest("[data-ordnance-id]");
      if (!row) return;
      const slotType = row.dataset.ordnanceSlot;
      const entryId  = row.dataset.ordnanceId;
      if (!slotType || !entryId) return;
      const entries = this.actor.system.ordnanceActors?.[slotType] ?? [];
      const entry   = entries.find(e => e.id === entryId);
      if (!entry?.actorData) {
        const uuid = row.dataset.uuid;
        if (uuid) { const actor = await fromUuid(uuid); actor?.sheet?.render(true); }
        return;
      }
      const editData = foundry.utils.deepClone(entry.actorData);
      editData._id   = undefined;
      editData.name  = `[Edit] ${entry.name || editData.name || "Ordnance"}`;
      editData.flags = foundry.utils.mergeObject(editData.flags ?? {}, {
        [MODULE_ID]: { fromOrdnanceMaster: true, embeddedEdit: true },
      });
      const editActor = await Actor.create(editData);
      if (!editActor) return;
      const sheet = editActor.sheet;
      sheet.render(true);
      const shipActor = this.actor;
      const origClose = sheet.close.bind(sheet);
      let _closing = false;
      sheet.close = async (options) => {
        if (_closing) return origClose(options);
        _closing = true;
        const updatedData = editActor.toObject();
        if (updatedData.name?.startsWith("[Edit] ")) updatedData.name = updatedData.name.slice(7);
        delete updatedData._id;
        const currentEntries = shipActor.system.ordnanceActors?.[slotType] ?? [];
        const newEntries = currentEntries.map(e =>
          e.id === entryId ? { ...e, actorData: updatedData, name: updatedData.name, img: updatedData.img } : e
        );
        await shipActor.update({ [`system.ordnanceActors.${slotType}`]: newEntries });
        if (game.actors.has(editActor.id)) await editActor.delete();
        return origClose(options);
      };
    }

    static async _onRemoveOrdnanceActor(event, target) {
      if (!this.actor?.isOwner) return;
      const row      = target.closest("[data-ordnance-id]");
      const slotType = row?.dataset?.ordnanceSlot;
      const actorId  = row?.dataset?.ordnanceId;
      if (!slotType || !actorId) return;
      const existing = this.actor.system.ordnanceActors?.[slotType] ?? [];
      return this.actor.update({ [`system.ordnanceActors.${slotType}`]: existing.filter(e => e?.id !== actorId) });
    }

    static async _onClearOrdnanceSlot(event, target) {
      if (!this.actor?.isOwner) return;
      const index = parseInt(target.dataset.slotIndex, 10);
      if (isNaN(index)) return;
      const existing = [...(this.actor.system.activeOrdnance ?? [])];
      existing[index] = null;
      let end = existing.length;
      while (end > 0 && !existing[end - 1]) end--;
      return this.actor.update({ "system.activeOrdnance": existing.slice(0, end) });
    }

    static async _onAddToInventory(event, target) {
      if (!this.actor?.isOwner) return;
      await this.actor.createEmbeddedDocuments("Item", [{
        type: `${MODULE_ID}.component`,
        name: game.i18n.localize("SHIPCOMBAT.Component.New"),
        system: { slot: "weapon", equipped: false },
      }]);
    }

    static async _onUnassignWeapon(event, target) {
      const row = target.closest("[data-id]");
      const id  = row?.dataset?.id;
      if (!id) return;
      emitToGM("unassignComponent", { itemId: id });
    }

    static async _onUnassignEquipment(event, target) {
      const row = target.closest("[data-id]");
      const id  = row?.dataset?.id;
      if (!id) return;
      emitToGM("unassignComponent", { itemId: id });
    }

    // ── Post-render wiring ─────────────────────────────────────────────────

    _prepareSubmitData(event, form, formData) {
      const obj = formData.object;
      for (const key of [
        "system.hull.value", "system.hull.max",
        "system.movement.speed", "system.movement.maneuverability",
      ]) {
        if (key in obj) obj[key] = Math.round(Number(obj[key]) || 0);
      }
      return super._prepareSubmitData(event, form, formData);
    }

    _onRender(context, options) {
      super._onRender?.(context, options);

      this.element.querySelectorAll("[data-sector-field]").forEach(input => {
        input.addEventListener("change", ev => {
          const val = Math.max(0, Number(ev.target.value) || 0);
          this.actor.update({ [`system.${ev.target.dataset.sectorField}`]: val });
        });
      });

      this.element.querySelectorAll("[data-slot-count]").forEach(input => {
        input.addEventListener("change", ev => {
          const path = ev.target.dataset.slotCount;
          if (path === "system.crewSize") return;
          this.actor.update({ [path]: Math.max(0, Number(ev.target.value) || 0) });
        });
      });

      this.element.querySelectorAll("[data-slot-count='system.crewSize']").forEach(sel => {
        sel.addEventListener("change", async ev => {
          const value = Math.max(3, Math.min(6, Number(ev.target.value) || 6));
          await this.actor.update({ "system.crewSize": value });
          await this.close();
          this.actor.sheet.render(true);
        });
      });

      this.element.querySelectorAll("[data-ship-config='system.useStrikeCraft']").forEach(sel => {
        sel.addEventListener("change", ev => {
          this.actor.update({ "system.useStrikeCraft": ev.target.value === "yes" });
        });
      });

      this.element.querySelectorAll("[data-ship-config='system.crewScale']").forEach(sel => {
        sel.addEventListener("change", ev => {
          this.actor.update({ "system.crewScale": ev.target.value });
        });
      });

      this.element.querySelectorAll("[data-role-skill-override]").forEach(sel => {
        sel.addEventListener("change", async ev => {
          const roleId = ev.target.dataset.roleSkillOverride;
          await this.actor.update({ [`system.roleSkillOverrides.${roleId}`]: ev.target.value });
        });
      });

      this.element.querySelectorAll("[data-role-title]").forEach(input => {
        input.addEventListener("blur", async ev => {
          const roleId = ev.target.dataset.roleTitle;
          const value  = ev.target.value.trim();
          const defaultLabel = game.i18n.localize(ROLES[roleId]?.label ?? "");
          await this.actor.update({ [`system.roleTitles.${roleId}`]: value === defaultLabel ? "" : value });
        });
        input.addEventListener("keydown", ev => {
          if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
        });
      });

      this.element.querySelectorAll("[data-equip-slot]").forEach(sel => {
        sel.addEventListener("change", ev => {
          emitToGM("assignEquipment", { slotId: sel.dataset.equipSlot, newItemId: sel.value });
        });
      });

      this.element.querySelectorAll("[data-weapon-assign]").forEach(sel => {
        sel.addEventListener("change", ev => {
          const pos    = sel.dataset.weaponAssign;
          const itemId = sel.value;
          if (!itemId) return;
          const isFlank = pos === "port" || pos === "starboard";
          emitToGM("assignWeapon", {
            itemId,
            weaponPosition: isFlank ? "flank" : pos,
            weaponBay:      isFlank ? pos : "port",
          });
          if (sel.isConnected) sel.value = "";
        });
      });

      this.element.querySelectorAll("[data-ordnance-slot-index]").forEach(sel => {
        sel.addEventListener("change", async ev => {
          const index = parseInt(sel.dataset.ordnanceSlotIndex, 10);
          const val   = sel.value;
          if (!val) return;
          const colonIdx = val.indexOf(":");
          const type    = val.slice(0, colonIdx);
          const actorId = val.slice(colonIdx + 1);
          const existing = [...(this.actor.system.activeOrdnance ?? [])];
          while (existing.length <= index) existing.push(null);
          existing[index] = { type, actorId };
          await this.actor.update({ "system.activeOrdnance": existing });
        });
      });

      this.element.querySelectorAll(".shipcombat-arc-val[data-sector]").forEach(el => {
        el.addEventListener("click",        ev => { ev.preventDefault(); adjustShieldSectorDelta(this, el.dataset.sector,  1); });
        el.addEventListener("contextmenu",  ev => { ev.preventDefault(); adjustShieldSectorDelta(this, el.dataset.sector, -1); });
        el.addEventListener("wheel", ev => { ev.preventDefault(); adjustShieldSectorDelta(this, el.dataset.sector, ev.deltaY < 0 ? 1 : -1); }, { passive: false });
      });

      helmOnRender(this);

      this.element.querySelectorAll("[data-launch-side][data-launch-dir]").forEach(cb => {
        cb.addEventListener("change", async ev => {
          const side = ev.currentTarget.dataset.launchSide;
          const dir  = ev.currentTarget.dataset.launchDir;
          await this.actor.update({ [`system.ordnanceLaunchSides.${side}.${dir}`]: ev.currentTarget.checked });
        });
      });

      this.element.querySelectorAll(".shipcombat-commitment-pill--new[data-index]").forEach(pill => {
        pill.addEventListener("contextmenu", ev => {
          ev.preventDefault();
          ORDNANCE_ACTIONS.cancelCommitment.call(this, ev, pill);
        });
      });

      {
        let _dragCardId = null;
        this.element.querySelectorAll(".shipcombat-captain-card[data-card-id]").forEach(card => {
          card.addEventListener("dragstart", ev => {
            _dragCardId = card.dataset.cardId;
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/plain", _dragCardId);
            requestAnimationFrame(() => card.classList.add("shipcombat-captain-card--dragging"));
          });
          card.addEventListener("dragend", () => {
            card.classList.remove("shipcombat-captain-card--dragging");
            this.element.querySelectorAll(".shipcombat-captain-card--drag-over").forEach(el => el.classList.remove("shipcombat-captain-card--drag-over"));
            _dragCardId = null;
          });
          card.addEventListener("dragover", ev => {
            if (!_dragCardId || card.dataset.cardId === _dragCardId) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move";
            this.element.querySelectorAll(".shipcombat-captain-card--drag-over").forEach(el => el.classList.remove("shipcombat-captain-card--drag-over"));
            card.classList.add("shipcombat-captain-card--drag-over");
          });
          card.addEventListener("dragleave", () => card.classList.remove("shipcombat-captain-card--drag-over"));
          card.addEventListener("drop", ev => {
            ev.preventDefault();
            if (!_dragCardId || card.dataset.cardId === _dragCardId) return;
            const hand = [...(this.actor.system.resources?.captain?.hand ?? [])];
            const fromIdx = hand.indexOf(_dragCardId);
            const toIdx   = hand.indexOf(card.dataset.cardId);
            if (fromIdx === -1 || toIdx === -1) return;
            hand.splice(fromIdx, 1);
            hand.splice(toIdx, 0, _dragCardId);
            _dragCardId = null;
            card.classList.remove("shipcombat-captain-card--drag-over");
            emitToGM("updateResource", { roleId: "captain", key: "hand", value: hand });
          });
        });
      }

      SensorRadar.attach(this, context.sensorsCtx);

      this.element.querySelectorAll(".shipcombat-radar-zoom").forEach(slider => {
        slider.addEventListener("input", ev => {
          const val = Math.max(5, Number(ev.target.value) || 5);
          SensorRadar.radarScale = val;
          const label = ev.target.parentElement?.querySelector(".shipcombat-radar-zoom-label");
          if (label) label.textContent = String(val);
        });
      });

      this.element.querySelectorAll("canvas[data-sensor-radar]").forEach(cvs => {
        cvs.addEventListener("wheel", ev => {
          ev.preventDefault();
          const maxR = context.sensorsCtx?.maxScanRange || 30;
          const step = ev.deltaY < 0 ? -1 : 1;
          const cur  = SensorRadar.radarScale || maxR;
          SensorRadar.radarScale = Math.max(5, Math.min(cur + step, maxR));
          const slider = this.element.querySelector(".shipcombat-radar-zoom");
          if (slider) slider.value = SensorRadar.radarScale;
          const label = this.element.querySelector(".shipcombat-radar-zoom-label");
          if (label) label.textContent = String(SensorRadar.radarScale);
        }, { passive: false });
      });

      const sections = [...this.element.querySelectorAll(".shipcombat-role-section")];
      sections.forEach(section => {
        const btn = section.querySelector(".shipcombat-section-overlay-btn");
        if (!btn) return;
        btn.addEventListener("mouseenter", () => {
          sections.forEach(s => {
            if (s === section) s.classList.add("shipcombat-overlay-hover-confirm");
            else if (s.querySelector(".shipcombat-section-overlay")) s.classList.add("shipcombat-overlay-hover-deny");
          });
        });
        btn.addEventListener("mouseleave", () => {
          sections.forEach(s => s.classList.remove("shipcombat-overlay-hover-confirm", "shipcombat-overlay-hover-deny"));
        });
      });

      this.element.querySelectorAll(".shipcombat-macro-tier-picker").forEach(picker => {
        const card      = picker.closest(".shipcombat-battery-card");
        const fireBtn   = card?.querySelector(".shipcombat-fire--macro");
        const ammoVal   = card?.querySelector("[data-macro-stat-display='ammo'] .shipcombat-battery-stat-value");
        const hitVal    = card?.querySelector("[data-macro-stat-display='hit'] .shipcombat-battery-stat-value");
        const salvoVal  = card?.querySelector("[data-macro-stat-display='salvo'] .shipcombat-battery-stat-value");
        const fireLabel = fireBtn?.querySelector(".shipcombat-macro-fire-label");
        const pips      = [...picker.querySelectorAll(".shipcombat-macro-tier-pip")];

        function selectTier(pip) {
          pips.forEach(p => p.classList.remove("shipcombat-macro-pip-selected"));
          pip.classList.add("shipcombat-macro-pip-selected");
          const hit    = parseInt(pip.dataset.tierHit) || 0;
          const hitStr = hit > 0 ? `+${hit}` : hit < 0 ? String(hit) : " - ";
          if (ammoVal)  ammoVal.textContent  = pip.dataset.tierAmmo;
          if (hitVal)   hitVal.textContent   = hitStr;
          if (salvoVal) salvoVal.textContent = pip.dataset.tierSalvo;
          if (fireBtn) {
            fireBtn.dataset.fireMode = pip.dataset.tierId;
            fireBtn.disabled = pip.dataset.canAfford !== "true";
            if (fireLabel) fireLabel.textContent = pip.querySelector(".shipcombat-macro-pip-label")?.textContent?.trim() ?? "";
          }
        }

        pips.forEach(pip => pip.addEventListener("click", () => {
          if (pip.dataset.canAfford !== "true") return;
          selectTier(pip);
        }));
        const firstAffordable = pips.find(p => p.dataset.canAfford === "true");
        if (firstAffordable) selectTier(firstAffordable);
      });

      this.element.querySelectorAll("[data-weapon-arc]").forEach(row => {
        row.addEventListener("mouseenter", () => WeaponArcOverlay.showHover(row.dataset.weaponArc));
        row.addEventListener("mouseleave", () => WeaponArcOverlay.hideHover());
      });

      this.element.querySelectorAll("[data-pin-weapon]").forEach(btn => {
        btn.addEventListener("click", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          const pinned = WeaponArcOverlay.togglePin(btn.dataset.pinWeapon);
          btn.classList.toggle("shipcombat-pin-active", pinned);
        });
        if (WeaponArcOverlay.isPinned(btn.dataset.pinWeapon)) btn.classList.add("shipcombat-pin-active");
      });

      this.element.querySelectorAll("[data-action-id='recallCraft']").forEach(btn => {
        btn.addEventListener("mouseenter", () => {
          const shipToken = this.actor.getActiveTokens()?.[0];
          if (!shipToken || !canvas.stage) return;
          const gs = canvas.grid.size;
          const cx = shipToken.center?.x ?? (shipToken.x + gs / 2);
          const cy = shipToken.center?.y ?? (shipToken.y + gs / 2);
          if (this._recallRangeGfx) this._recallRangeGfx.destroy();
          const g = new PIXI.Graphics();
          g.beginFill(0x00ff88, 0.04);
          g.lineStyle(2, 0x00ff88, 0.5);
          g.drawCircle(cx, cy, 3 * gs);
          g.endFill();
          canvas.stage.addChild(g);
          this._recallRangeGfx = g;
        });
        btn.addEventListener("mouseleave", () => {
          if (this._recallRangeGfx) { this._recallRangeGfx.destroy(); this._recallRangeGfx = null; }
        });
      });

      this.element.querySelectorAll(".shipcombat-pile-widget").forEach(widget => {
        const trigger = widget.querySelector(".shipcombat-pile-trigger");
        const popup   = widget.querySelector(".shipcombat-pile-popup");
        if (!trigger || !popup) return;
        const isRight = widget.classList.contains("shipcombat-pile-widget--right");
        const show = () => {
          const r = trigger.getBoundingClientRect();
          popup.style.display = "block";
          popup.style.bottom = `${window.innerHeight - r.top + 6}px`;
          popup.style.top = "";
          if (isRight) { popup.style.left = ""; popup.style.right = `${window.innerWidth - r.right}px`; }
          else         { popup.style.right = ""; popup.style.left  = `${r.left}px`; }
        };
        const hide = ev => { if (ev.relatedTarget && popup.contains(ev.relatedTarget)) return; popup.style.display = "none"; };
        trigger.addEventListener("mouseenter", show);
        trigger.addEventListener("mouseleave", hide);
        popup.addEventListener("mouseleave", () => { popup.style.display = "none"; });
      });

      const arcBroadcast = !!(this.actor.system.resources?.gunner?.arcOverlayActive);
      if (this.tabGroups?.primary === "gunner" || arcBroadcast) WeaponArcOverlay.activate(this.actor);
      else WeaponArcOverlay.deactivate();
    }

    _updateHelmPreview() {
      if (this.tabGroups?.primary !== "pilot") { HelmPreview.hide(); return; }
      const myRole = this._resolveRoleForUser(game.user);
      if (myRole !== "pilot" && !game.user.isGM) return;
      helmUpdatePreview(this);
    }

    changeTab(tab, group, options = {}) {
      super.changeTab(tab, group, options);
      if (group === "primary") {
        const isHelmTab = tab === "pilot" || tab === "engineer3man";
        if (!isHelmTab) HelmPreview.hide();
        else this._updateHelmPreview();
        const arcBroadcast = !!(this.actor.system.resources?.gunner?.arcOverlayActive);
        if (tab === "gunner" || arcBroadcast) WeaponArcOverlay.activate(this.actor);
        else WeaponArcOverlay.deactivate();
      }
    }

    // ── Drop handling ──────────────────────────────────────────────────────

    async _onDropActor(data, event) {
      const ordnanceDrop = event.target.closest?.("[data-ordnance-drop]");
      if (ordnanceDrop) {
        const slotType = ordnanceDrop.dataset.ordnanceDrop;
        const actor = await Actor.fromDropData(data);
        if (!actor) return;
        const isValidDrop = actor.type === `${MODULE_ID}.${slotType === "strikeCraft" ? "strikeCraft" : "torpedo"}`
          || (slotType === "strikeCraft" && isStrikeCraft(actor))
          || (slotType !== "strikeCraft" && isTorpedo(actor))
          || (actor.type === `${MODULE_ID}.shipOrdnance` && actor.system?.subtype === slotType);
        if (!isValidDrop) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.WrongOrdnanceType"));
        const existing  = this.actor.system.ordnanceActors?.[slotType] ?? [];
        const actorData = actor.toObject();
        delete actorData._id;
        return this.actor.update({ [`system.ordnanceActors.${slotType}`]: [...existing, {
          id: foundry.utils.randomID(), uuid: actor.uuid ?? null,
          name: actor.name, img: actor.img, actorData,
        }] });
      }

      const roleDrop = event.target.closest?.("[data-role-drop]");
      if (!roleDrop) return super._onDropActor?.(data, event);
      const roleId = roleDrop.dataset.roleDrop;
      if (!roleId) return;
      const actor = await Actor.fromDropData(data);
      if (!actor) return;
      const userByCharacter = game.users.find(u => !u.isGM && u.character?.id === actor.id);
      const ownerIds = Object.entries(actor.ownership ?? {})
        .filter(([uid, level]) => uid !== "default" && Number(level) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
        .map(([uid]) => uid);
      const userByOwner = game.users.find(u => !u.isGM && ownerIds.includes(u.id));
      const targetUser = userByCharacter ?? userByOwner;
      if (!targetUser) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoAssignableUser"));
      emitToGM("assignRole", {
        userId: targetUser.id, roleId,
        actorRef: { id: actor.id, uuid: actor.uuid, name: actor.name, img: actor.img },
      });
    }

    async _onDropItem(data, event) {
      const dropZone = event.target.closest?.("[data-component-slot]");
      const item     = await Item.fromDropData(data);
      if (!item) return;
      if (item.type !== `${MODULE_ID}.component`) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.OnlyComponents"));

      const targetSlot     = dropZone?.dataset.componentSlot;
      const targetPosition = dropZone?.dataset.componentPosition;

      const sameItem = this.actor.items.get(item.id);
      if (sameItem) {
        if (targetSlot) {
          const update = { "system.slot": targetSlot };
          if (targetSlot === "weapon" && targetPosition) {
            if (targetPosition === "port" || targetPosition === "starboard") {
              update["system.weaponPosition"] = "flank";
              update["system.weaponBay"]      = targetPosition;
            } else {
              update["system.weaponPosition"] = targetPosition;
            }
          }
          await sameItem.update(update);
        }
        return;
      }

      const createData = item.toObject();
      delete createData._id;
      if (targetSlot) {
        createData.system.slot = targetSlot;
        if (targetSlot === "weapon" && targetPosition) {
          if (targetPosition === "port" || targetPosition === "starboard") {
            createData.system.weaponPosition = "flank";
            createData.system.weaponBay      = targetPosition;
          } else {
            createData.system.weaponPosition = targetPosition;
          }
        }
      }
      await this.actor.createEmbeddedDocuments("Item", [createData]);
    }
  }

  return ShipSheetBase;
};
