import {
  CORE_MODULE_ID,
  LOCK_DECAY_ROUNDS,
  MODULE_ID,
  PAYLOADS_BY_ROLE,
  ROLES,
} from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getStationOperatorRole } from "../roles/crew-operators.js";

const ROLE_ORDER = ["captain", "engineer", "pilot", "sensors", "gunner", "ordnance"];
const STANCE_IDS = ["none", "aggressive", "defensive", "redAlert", "devastation"];
const ENGINEER_ACTIONS = ["cores", "heat", "fire", "repair"];
const RESOURCE_KEYS_BY_ROLE = {
  captain: new Set([
    "leadershipSL", "leadershipRolled", "allocationLocked",
    "allocInspire", "allocResolve", "allocInitiative", "rolledInitiative",
    "triageCount", "currentHandCap", "handCapBonus", "mulligansSpent",
    "holdTheLineActive", "hardenedShields", "acceleratedLoadingActive",
  ]),
  engineer: new Set([
    "heat", "powerCores", "auxiliaryPower", "extraActions",
    "stagedShieldCores", "stagedAuxCores", "committedAuxCores",
    "heatCoresStaged", "fireCoresStaged", "repairAuxPowerStaged",
  ]),
  pilot: new Set([
    "pilotingSL", "allocSpeed", "allocMano", "allocEvasion",
    "fuelBurned", "driftBurned", "bearing", "prevTurnMove",
    "bearingUsed", "momentumUsed", "overdrive", "apThrustBonus",
    "hardOverActive", "prowGunLocked", "ramAllocLocked",
  ]),
  sensors: new Set(["actionUsed", "sensorPriorityActive"]),
  gunner: new Set([
    "ammo", "ordnanceSL", "ordnanceRolled", "slLocked",
    "allocAccuracy", "allocPenetration", "allocFirepower",
    "sensorBandExpanded", "chooseCritLocation", "captainHitBonus",
  ]),
  ordnance: new Set([
    "manpower", "manpowerMax", "armedTorpedoes", "armedCraft",
    "craftDestroyed", "craftRecovering", "craftPartialRecovery",
    "bosunSL", "bosunRolled", "allocEfficiency", "allocExpedience",
    "actionUsed", "availablePayloads", "autoArmTimer", "autoLoadTimer",
  ]),
};
const STRIKE_CRAFT_RESOURCE_PATHS = new Set([
  "resources.ordnance.armedCraft",
  "resources.ordnance.craftDestroyed",
  "resources.ordnance.craftRecovering",
  "resources.ordnance.craftPartialRecovery",
]);
const PAYLOAD_RESOURCE_PATHS = new Set([
  "resources.ordnance.availablePayloads",
  "resources.ordnance.autoLoadTimer",
]);
const TORPEDO_RESOURCE_PATHS = new Set([
  "resources.ordnance.armedTorpedoes",
  "resources.ordnance.autoArmTimer",
]);
const THREE_CREW_PILOT_CORE_PATHS = new Set([
  "resources.pilot.overdrive",
  "resources.pilot.apThrustBonus",
  "resources.pilot.hardOverActive",
]);
const RESOURCE_LABELS = {
  allocInspire: "Inspire Allocation",
  allocResolve: "Resolve Allocation",
  allocInitiative: "Initiative Allocation",
  allocAccuracy: "Accuracy Allocation",
  allocPenetration: "Penetration Allocation",
  allocFirepower: "Firepower Allocation",
  allocSpeed: "Speed Allocation",
  allocMano: "Maneuverability Allocation",
  allocEvasion: "Evasion Allocation",
  allocEfficiency: "Efficiency Allocation",
  allocExpedience: "Expedience Allocation",
  autoArmTimer: "Auto-arm Torpedo Timer",
  autoLoadTimer: "Auto-load Payload Timer",
  repairAuxPowerStaged: "Hull Repair Auxiliary Power",
};
const RESOURCE_ORDER = {
  captain: [
    "resources.captain.leadershipSL",
    "resources.captain.leadershipRolled",
    "resources.captain.allocationLocked",
    "resources.captain.allocInspire",
    "resources.captain.allocResolve",
    "resources.captain.allocInitiative",
    "resources.ordnance.allocEfficiency",
    "resources.ordnance.allocExpedience",
  ],
  gunner: [
    "resources.gunner.ordnanceSL",
    "resources.gunner.ordnanceRolled",
    "resources.gunner.slLocked",
    "resources.gunner.allocAccuracy",
    "resources.gunner.allocPenetration",
    "resources.gunner.allocFirepower",
    "resources.ordnance.allocEfficiency",
    "resources.ordnance.allocExpedience",
  ],
  pilot: [
    "resources.pilot.pilotingSL",
    "resources.pilot.allocSpeed",
    "resources.pilot.allocMano",
    "resources.pilot.allocEvasion",
  ],
  ordnance: [
    "resources.ordnance.bosunSL",
    "resources.ordnance.bosunRolled",
    "resources.ordnance.allocEfficiency",
    "resources.ordnance.allocExpedience",
  ],
};

function humanize(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, char => char.toUpperCase());
}

function resourceLabel(roleId, key, value) {
  const allocationPools = {
    leadershipSL: "captain",
    ordnanceSL: "gunner",
    pilotingSL: "pilot",
    bosunSL: "ordnance",
  };
  const poolRole = allocationPools[key];
  if (poolRole) {
    const roleLabel = poolRole === "ordnance"
      ? game.i18n.localize("SHIPCOMBAT.Override.OrdnanceMaster")
      : game.i18n.localize(ROLES[poolRole].label);
    return `${roleLabel} ${SystemAdapter.current.formatAllocationUnit(value, { capitalize: true })}`;
  }
  const rolledRoles = {
    leadershipRolled: "captain",
    ordnanceRolled: "gunner",
    bosunRolled: "ordnance",
  };
  if (rolledRoles[key]) {
    const rolledRole = rolledRoles[key];
    const roleLabel = rolledRole === "ordnance"
      ? game.i18n.localize("SHIPCOMBAT.Override.OrdnanceMaster")
      : game.i18n.localize(ROLES[rolledRole].label);
    return `${roleLabel} ${SystemAdapter.current.formatAllocationUnit(2, { capitalize: true })} ${game.i18n.localize("SHIPCOMBAT.Override.Rolled")}`;
  }
  if (key === "slLocked") {
    return `${SystemAdapter.current.formatAllocationUnit(2, { capitalize: true })} ${game.i18n.localize("SHIPCOMBAT.Override.Locked")}`;
  }
  if (key.endsWith("SL")) {
    const prefix = humanize(key.slice(0, -2)).trim();
    return `${prefix} ${SystemAdapter.current.formatAllocationUnit(value, { capitalize: true })}`;
  }
  if (RESOURCE_LABELS[key]) return RESOURCE_LABELS[key];
  return humanize(key);
}

function sortResourceFields(fields, operatorRole) {
  const order = RESOURCE_ORDER[operatorRole] ?? [];
  const rank = new Map(order.map((path, index) => [path, index]));
  return fields.sort((left, right) => {
    const leftRank = rank.get(left.path) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.path) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.label.localeCompare(right.label);
  });
}

function scalarFields(value, roleId, prefix = `resources.${roleId}`, fields = []) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!RESOURCE_KEYS_BY_ROLE[roleId]?.has(key)) continue;
    const path = `${prefix}.${key}`;
    if (typeof entry === "number" || typeof entry === "boolean") {
      fields.push({
        path,
        label: resourceLabel(roleId, key, entry),
        value: entry,
        isBoolean: typeof entry === "boolean",
        isNumber: typeof entry === "number",
      });
    }
  }
  return fields;
}

function activeOperatorRoles(sys) {
  const crewSize = sys.crewSize ?? 6;
  return ROLE_ORDER.filter(roleId => {
    if (roleId === "ordnance") return crewSize >= 6;
    if (roleId === "sensors") return crewSize >= 5;
    if (roleId === "pilot") return crewSize >= 4;
    return true;
  });
}

function hasLoadedOrdnance(sys, type) {
  const inventoryIds = new Set((sys.ordnanceActors?.[type] ?? []).map(entry => entry?.id));
  return (sys.activeOrdnance ?? []).some(entry => entry?.type === type && inventoryIds.has(entry.actorId));
}

function resourceGroups(sys) {
  const crewSize = sys.crewSize ?? 6;
  const hasTorpedoes = hasLoadedOrdnance(sys, "torpedo");
  const hasStrikeCraft = sys.useStrikeCraft !== false && hasLoadedOrdnance(sys, "strikeCraft");
  return activeOperatorRoles(sys).map(operatorRole => {
    const sourceRoles = ROLE_ORDER.filter(roleId =>
      roleId === "engineer"
        ? operatorRole === "engineer"
        : getStationOperatorRole(sys, roleId) === operatorRole
    );
    let fields = sourceRoles.flatMap(roleId => scalarFields(sys.resources?.[roleId], roleId));
    if (!hasStrikeCraft) {
      fields = fields.filter(field => !STRIKE_CRAFT_RESOURCE_PATHS.has(field.path));
    }
    if (!hasTorpedoes) {
      fields = fields.filter(field => !TORPEDO_RESOURCE_PATHS.has(field.path));
    }
    if (crewSize <= 5) {
      fields = fields.filter(field => !PAYLOAD_RESOURCE_PATHS.has(field.path));
      fields = fields.filter(field => ![
        "resources.ordnance.bosunSL",
        "resources.ordnance.bosunRolled",
      ].includes(field.path));
    }
    if (crewSize === 5) {
      fields = fields.filter(field => ![
        "resources.captain.allocInspire",
        "resources.captain.allocInitiative",
      ].includes(field.path));
    }
    if (crewSize <= 4) {
      fields = fields.filter(field => ![
        "resources.ordnance.allocEfficiency",
        "resources.ordnance.allocExpedience",
      ].includes(field.path));
    }
    if (crewSize <= 3) {
      fields = fields.filter(field => !THREE_CREW_PILOT_CORE_PATHS.has(field.path));
    }
    fields = sortResourceFields(fields, operatorRole);
    const selects = [];
    if (sourceRoles.includes("captain")) {
      for (const key of ["stance", "pendingStance"]) {
        const current = sys.resources?.captain?.[key] ?? (key === "stance" ? "none" : "");
        selects.push({
          path: `resources.captain.${key}`,
          label: game.i18n.localize(key === "stance" ? "SHIPCOMBAT.Override.Stance" : "SHIPCOMBAT.Override.PendingStance"),
          options: [
            ...(key === "pendingStance" ? [{ value: "", label: game.i18n.localize("SHIPCOMBAT.Override.None") }] : []),
            ...STANCE_IDS.map(value => ({
              value,
              label: game.i18n.localize(`SHIPCOMBAT.Captain.Stance.${value}`),
              selected: current === value,
            })),
          ],
        });
      }
    }
    if (crewSize >= 6) {
      for (const roleId of sourceRoles) {
        const payloads = PAYLOADS_BY_ROLE[roleId] ?? [];
        if (!payloads.length) continue;
        const current = sys.resources?.[roleId]?.payload ?? "";
        selects.push({
          path: `resources.${roleId}.payload`,
          label: game.i18n.localize("SHIPCOMBAT.Override.Payload"),
          options: [
            { value: "", label: game.i18n.localize("SHIPCOMBAT.Override.None"), selected: !current },
            ...payloads.map(payload => ({
              value: payload.id,
              label: game.i18n.localize(payload.label),
              selected: current === payload.id,
            })),
          ],
        });
      }
    }
    return {
      roleId: operatorRole,
      label: sys.roleTitles?.[operatorRole] || game.i18n.localize(ROLES[operatorRole].label),
      fields,
      selects,
      hasFields: fields.length > 0 || selects.length > 0,
    };
  }).filter(group => group.hasFields);
}

function configurableWeapons(actor, sys) {
  const firedWeaponIds = new Set(sys.resources?.gunner?.firedWeaponIds ?? []);
  return [...(actor.items ?? [])]
    .filter(item => item.type === `${MODULE_ID}.component`
      && item.system?.slot === "weapon"
      && item.system?.equipped !== false)
    .map(item => ({
      id: item.id,
      name: item.name,
      img: item.img,
      fired: firedWeaponIds.has(item.id),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readValue(source, path) {
  return foundry.utils.getProperty(source, path);
}

function coerceValue(field, value) {
  if (field.isBoolean) return value === true || value === "true" || value === "on";
  if (field.isNumber) return Number.isFinite(Number(value)) ? Number(value) : field.value;
  return String(value ?? "");
}

function currentSceneContacts(actor, sys) {
  const locks = sys.resources?.sensors?.locks ?? [];
  const contacts = sys.resources?.sensors?.contacts ?? {};
  const ownTokenIds = new Set((actor.getActiveTokens?.() ?? []).map(token => token.id));
  const tokenIds = new Set([...Object.keys(contacts), ...locks.map(lock => lock.targetTokenId)]);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor && token.actor.type !== `${MODULE_ID}.ship` && !ownTokenIds.has(token.id)) tokenIds.add(token.id);
  }
  return [...tokenIds].map(tokenId => {
    const token = canvas?.tokens?.get(tokenId);
    if (token?.actor?.type === `${MODULE_ID}.ship`) return null;
    const lock = locks.find(entry => entry.targetTokenId === tokenId);
    return {
      tokenId,
      name: token?.document?.name ?? contacts[tokenId]?.identifiedName ?? tokenId,
      tier: Number(lock?.tier ?? 0),
      missing: !token,
    };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function reviewLabel(path, sys) {
  if (path === "resources.sensors.locks") return game.i18n.localize("SHIPCOMBAT.Override.SensorLocks");
  if (path === "resources.gunner.firedWeaponIds") return game.i18n.localize("SHIPCOMBAT.Override.FiredWeapons");
  if (path === "resources.engineer.actionChoices") return game.i18n.localize("SHIPCOMBAT.Override.EngineerActionState");
  const conditionMatch = path.match(/^conditions\.([^.]+)\.tier$/);
  if (conditionMatch) return game.i18n.localize(`SHIPCOMBAT.Crit.Location.${conditionMatch[1]}`);
  const resourceMatch = path.match(/^resources\.([^.]+)\.([^.]+)$/);
  if (resourceMatch) {
    const [, roleId, key] = resourceMatch;
    if (key === "coreCount") {
      const roleLabel = sys.roleTitles?.[roleId] || game.i18n.localize(ROLES[roleId].label);
      return `${roleLabel} ${game.i18n.localize("SHIPCOMBAT.Override.CoreState")}`;
    }
    return resourceLabel(roleId, key, readValue(sys, path));
  }
  return humanize(path.split(".").at(-1));
}

function reviewValue(path, value, actor) {
  if (value === null || value === undefined || value === "") return game.i18n.localize("SHIPCOMBAT.Override.None");
  if (typeof value === "boolean") return game.i18n.localize(value ? "SHIPCOMBAT.Config.Yes" : "SHIPCOMBAT.Config.No");
  if (path === "resources.gunner.firedWeaponIds") {
    const names = value.map(id => actor.items?.get?.(id)?.name ?? id);
    return names.length ? names.join(", ") : game.i18n.localize("SHIPCOMBAT.Override.None");
  }
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : game.i18n.localize("SHIPCOMBAT.Override.None");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function confirmOverride(content) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    new foundry.appv1.api.Dialog({
      title: game.i18n.localize("SHIPCOMBAT.Override.ConfirmTitle"),
      content,
      buttons: {
        cancel: {
          icon: "<i class='fa-solid fa-xmark'></i>",
          label: game.i18n.localize("Cancel"),
          callback: () => finish(false),
        },
        apply: {
          icon: "<i class='fa-solid fa-check'></i>",
          label: game.i18n.localize("SHIPCOMBAT.Override.Apply"),
          callback: () => finish(true),
        },
      },
      default: "cancel",
      close: () => finish(false),
    }, {
      classes: ["shipcombat-targeting-popup", "shipcombat-manual-override", "shipcombat-manual-override-review"],
      width: 520,
      height: "auto",
    }).render(true);
  });
}

export class ManualOverride extends foundry.appv1.api.FormApplication {
  constructor(actor, options = {}) {
    super(actor, options);
    this.actor = actor;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${CORE_MODULE_ID}-manual-override`,
      classes: ["shipcombat-targeting-popup", "shipcombat-manual-override"],
      title: game.i18n.localize("SHIPCOMBAT.Override.Title"),
      template: `modules/${CORE_MODULE_ID}/templates/apps/manual-override.hbs`,
      width: 620,
      height: 760,
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
      scrollY: [".shipcombat-override-body"],
    });
  }

  async getData() {
    const sys = SystemAdapter.current.getShipData(this.actor);
    const hpMode = SystemAdapter.current.hullDisplayMode === "hpRemaining";
    const conditionTiers = [
      { value: "", label: game.i18n.localize("SHIPCOMBAT.Override.None") },
      ...["low", "medium", "high"].map(value => ({ value, label: humanize(value) })),
    ];
    const conditions = Object.entries(sys.conditions ?? {}).map(([key, condition]) => ({
      key,
      label: game.i18n.localize(`SHIPCOMBAT.Crit.Location.${key}`),
      options: conditionTiers.map(option => ({ ...option, selected: option.value === (condition?.tier ?? "") })),
    }));
    const coreState = activeOperatorRoles(sys).filter(roleId => roleId !== "engineer").map(roleId => ({
      roleId,
      label: sys.roleTitles?.[roleId] || game.i18n.localize(ROLES[roleId].label),
      value: Math.max(0, Number(sys.resources?.[roleId]?.coreCount) || 0),
    }));
    const actionChoices = sys.resources?.engineer?.actionChoices ?? [];
    const engineerActions = [
      { value: "", label: game.i18n.localize("SHIPCOMBAT.Override.ActionAvailable"), selected: actionChoices.length === 0 },
      ...ENGINEER_ACTIONS.map(value => ({
        value,
        label: game.i18n.localize(`SHIPCOMBAT.Override.EngineerAction.${value}`),
        selected: actionChoices.length === 1 && actionChoices[0] === value,
      })),
    ];
    if (actionChoices.length > 1) {
      engineerActions.push({
        value: "__preserve",
        label: game.i18n.format("SHIPCOMBAT.Override.MultipleActions", { count: actionChoices.length }),
        selected: true,
      });
    }
    return {
      actorName: this.actor.name,
      vitals: [
        { path: "hull.value", label: game.i18n.localize(hpMode ? "SHIPCOMBAT.Override.HitPoints" : "SHIPCOMBAT.Override.HullDamage"), value: sys.hull?.value ?? 0 },
        { path: "hull.max", label: game.i18n.localize(hpMode ? "SHIPCOMBAT.Override.HitPointsMaximum" : "SHIPCOMBAT.Override.HullMaximum"), value: sys.hull?.max ?? 0 },
        ...["bow", "stern", "port", "starboard"].flatMap(sector => [
          { path: `shields.${sector}`, label: `${humanize(sector)} ${game.i18n.localize("SHIPCOMBAT.Term.VoidShield")}`, value: sys.shields?.[sector] ?? 0 },
          { path: `armourRend.${sector}`, label: `${humanize(sector)} ${game.i18n.localize("SHIPCOMBAT.Override.ArmourDamage")}`, value: sys.armourRend?.[sector] ?? 0 },
        ]),
        { path: "shieldPool.current", label: game.i18n.localize("SHIPCOMBAT.Override.ShieldFlux"), value: sys.shieldPool?.current ?? 0 },
        { path: "internalFire", label: game.i18n.localize("SHIPCOMBAT.Term.InternalFire"), value: sys.internalFire ?? 0 },
      ],
      coreState,
      engineerActions,
      resourceGroups: resourceGroups(sys),
      weapons: configurableWeapons(this.actor, sys),
      shipFields: [
        { path: "ventLocked", label: game.i18n.localize("SHIPCOMBAT.Engineer.VentLocked"), value: !!sys.ventLocked, isBoolean: true },
        { path: "ventPending", label: game.i18n.localize("SHIPCOMBAT.Override.VentPending"), value: !!sys.ventPending, isBoolean: true },
      ],
      conditions,
      contacts: currentSceneContacts(this.actor, sys),
    };
  }

  async _updateObject(_event, formData) {
    if (!game.user.isGM) return ui.notifications.error("SHIPCOMBAT.Override.GMOnly", { localize: true });
    const sys = SystemAdapter.current.getShipData(this.actor);
    const data = Object.fromEntries(Object.entries(formData));
    const updates = {};
    const trackedPaths = [];
    const editableFields = [
      ...["hull.value", "hull.max", "shieldPool.current", "internalFire", ...["bow", "stern", "port", "starboard"].flatMap(sector => [`shields.${sector}`, `armourRend.${sector}`])]
        .map(path => ({ path, value: readValue(sys, path), isNumber: true })),
      { path: "ventLocked", value: !!sys.ventLocked, isBoolean: true },
      { path: "ventPending", value: !!sys.ventPending, isBoolean: true },
      ...resourceGroups(sys).flatMap(group => group.fields),
    ];
    for (const field of editableFields) {
      const formKey = `field.${field.path}`;
      const next = coerceValue(field, data[formKey]);
      if (next === readValue(sys, field.path)) continue;
      updates[SystemAdapter.current.systemPath(field.path)] = next;
      trackedPaths.push(field.path);
    }
    for (const condition of Object.keys(sys.conditions ?? {})) {
      const path = `conditions.${condition}.tier`;
      const next = data[`condition.${condition}`] || null;
      if (next === (readValue(sys, path) ?? null)) continue;
      updates[SystemAdapter.current.systemPath(path)] = next;
      trackedPaths.push(path);
    }
    for (const group of resourceGroups(sys)) {
      for (const select of group.selects) {
        const next = String(data[`field.${select.path}`] ?? "");
        if (next === (readValue(sys, select.path) ?? "")) continue;
        updates[SystemAdapter.current.systemPath(select.path)] = next;
        trackedPaths.push(select.path);
      }
    }
    for (const core of activeOperatorRoles(sys).filter(roleId => roleId !== "engineer")) {
      const path = `resources.${core}.coreCount`;
      const next = Math.max(0, Number(data[`core.${core}`]) || 0);
      if (next === (Number(readValue(sys, path)) || 0)) continue;
      updates[SystemAdapter.current.systemPath(path)] = next;
      trackedPaths.push(path);
    }
    const engineerAction = String(data.engineerAction ?? "");
    if (engineerAction !== "__preserve") {
      const path = "resources.engineer.actionChoices";
      const next = engineerAction ? [engineerAction] : [];
      if (JSON.stringify(next) !== JSON.stringify(readValue(sys, path) ?? [])) {
        updates[SystemAdapter.current.systemPath(path)] = next;
        trackedPaths.push(path);
      }
    }
    const previousLocks = foundry.utils.deepClone(sys.resources?.sensors?.locks ?? []);
    const contactIds = currentSceneContacts(this.actor, sys).map(contact => contact.tokenId);
    const nextLocks = previousLocks.filter(lock => !contactIds.includes(lock.targetTokenId));
    for (const tokenId of contactIds) {
      const tier = Math.max(0, Math.min(4, Number(data[`lock.${tokenId}`]) || 0));
      if (!tier) continue;
      const existing = previousLocks.find(lock => lock.targetTokenId === tokenId) ?? {};
      nextLocks.push({ ...existing, targetTokenId: tokenId, tier, decayRounds: LOCK_DECAY_ROUNDS[tier] });
    }
    if (JSON.stringify(nextLocks) !== JSON.stringify(previousLocks)) {
      updates[SystemAdapter.current.systemPath("resources.sensors.locks")] = nextLocks;
      trackedPaths.push("resources.sensors.locks");
    }
    const weapons = configurableWeapons(this.actor, sys);
    const visibleWeaponIds = new Set(weapons.map(weapon => weapon.id));
    const previousFiredWeaponIds = sys.resources?.gunner?.firedWeaponIds ?? [];
    const nextFiredWeaponIds = [
      ...previousFiredWeaponIds.filter(weaponId => !visibleWeaponIds.has(weaponId)),
      ...weapons.filter(weapon => {
        const submitted = data[`weaponFired.${weapon.id}`];
        return submitted === true || submitted === "true" || submitted === "on";
      }).map(weapon => weapon.id),
    ];
    if (JSON.stringify(nextFiredWeaponIds) !== JSON.stringify(previousFiredWeaponIds)) {
      const path = "resources.gunner.firedWeaponIds";
      updates[SystemAdapter.current.systemPath(path)] = nextFiredWeaponIds;
      trackedPaths.push(path);
    }
    if (trackedPaths.length === 0) {
      ui.notifications.info("SHIPCOMBAT.Override.NoChanges", { localize: true });
      return this.close();
    }

    const changes = trackedPaths.map(path => {
      const updatePath = SystemAdapter.current.systemPath(path);
      return {
        label: reviewLabel(path, sys),
        before: reviewValue(path, readValue(sys, path), this.actor),
        after: reviewValue(path, updates[updatePath], this.actor),
      };
    });
    const rows = changes.map(change => `<li>
      <strong>${foundry.utils.escapeHTML(change.label)}</strong>
      <span>${foundry.utils.escapeHTML(change.before)}</span>
      <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
      <span>${foundry.utils.escapeHTML(change.after)}</span>
    </li>`).join("");
    const confirmed = await confirmOverride(`
      <div class="shipcombat-override-review-content">
        <p>${game.i18n.format("SHIPCOMBAT.Override.ConfirmBody", { count: trackedPaths.length, ship: foundry.utils.escapeHTML(this.actor.name) })}</p>
        <ol class="shipcombat-override-review-list">${rows}</ol>
      </div>`);
    if (!confirmed) return;

    await this.actor.update(updates);
    ui.notifications.warn(game.i18n.format("SHIPCOMBAT.Override.Applied", { count: trackedPaths.length, ship: this.actor.name }));
    await this.close();
  }

}

export function openManualOverride(actor) {
  if (!game.user.isGM) return ui.notifications.error("SHIPCOMBAT.Override.GMOnly", { localize: true });
  return new ManualOverride(actor).render(true);
}