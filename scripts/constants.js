import { THEME, hex } from "./theme.js";

// The core module's own ID — used for template paths, CSS, and other static
// assets that always live in this module regardless of which companion activated it.
export const CORE_MODULE_ID = "causodes-shipcombat-core";

// MODULE_ID is set at runtime by the system companion module via ShipCombat.configure().
// All code should read this binding after configure() has been called (before "init").
export let MODULE_ID = "";
export function setModuleId(id) { MODULE_ID = id; }

export const WEAPON_FIRED_HOOK = "shipCombatWeaponFired";

// ─── Bridge Roles ────────────────────────────────────────────────────────────

export const ROLES = {
  captain: {
    id: "captain",
    label: "SHIPCOMBAT.Role.Captain",
    icon: "fa-solid fa-chess-queen",
    color: hex(THEME.roles.captain),
  },
  engineer: {
    id: "engineer",
    label: "SHIPCOMBAT.Role.Engineer",
    icon: "fa-solid fa-gears",
    color: hex(THEME.roles.engineer),
  },
  pilot: {
    id: "pilot",
    label: "SHIPCOMBAT.Role.Pilot",
    icon: "fa-solid fa-compass",
    color: hex(THEME.roles.pilot),
  },
  sensors: {
    id: "sensors",
    label: "SHIPCOMBAT.Role.Sensors",
    icon: "fa-solid fa-satellite-dish",
    color: hex(THEME.roles.sensors),
  },
  gunner: {
    id: "gunner",
    label: "SHIPCOMBAT.Role.Gunner",
    icon: "fa-solid fa-crosshairs",
    color: hex(THEME.roles.gunner),
  },
  ordnance: {
    id: "ordnance",
    label: "SHIPCOMBAT.Role.Ordnance",
    icon: "fa-solid fa-rocket",
    color: hex(THEME.roles.ordnance),
  },
};

// ─── Actions (Standard & Overcharged per role) ───────────────────────────────

export const ROLE_ACTIONS = {
  captain: {
    standard:    { label: "SHIPCOMBAT.Action.CaptainStandard",       desc: "SHIPCOMBAT.Action.CaptainStandardDesc" },
    overcharged: { label: "SHIPCOMBAT.Action.CaptainOvercharged",    desc: "SHIPCOMBAT.Action.CaptainOverchargedDesc" },
  },
  engineer: {
    standard:    { label: "SHIPCOMBAT.Action.EngineerStandard",     desc: "SHIPCOMBAT.Action.EngineerStandardDesc" },
    overcharged: { label: "SHIPCOMBAT.Action.EngineerOvercharged",  desc: "SHIPCOMBAT.Action.EngineerOverchargedDesc" },
  },
  pilot: {
    standard:    { label: "SHIPCOMBAT.Action.PilotStandard",         desc: "SHIPCOMBAT.Action.PilotStandardDesc" },
    overcharged: { label: "SHIPCOMBAT.Action.PilotOvercharged",      desc: "SHIPCOMBAT.Action.PilotOverchargedDesc" },
  },
  sensors: {
    standard:    { label: "SHIPCOMBAT.Action.SensorsStandard",       desc: "SHIPCOMBAT.Action.SensorsStandardDesc" },
    overcharged: { label: "SHIPCOMBAT.Action.SensorsOvercharged",    desc: "SHIPCOMBAT.Action.SensorsOverchargedDesc" },
  },
  gunner: {
    standard:    { label: "SHIPCOMBAT.Action.GunnerStandard",        desc: "SHIPCOMBAT.Action.GunnerStandardDesc" },
    overcharged: { label: "SHIPCOMBAT.Action.GunnerOvercharged",     desc: "SHIPCOMBAT.Action.GunnerOverchargedDesc" },
  },
  ordnance: {
    standard:    { label: "SHIPCOMBAT.Action.OrdnanceStandard",      desc: "SHIPCOMBAT.Action.OrdnanceStandardDesc" },
    overcharged: { label: "SHIPCOMBAT.Action.OrdnanceOvercharged",   desc: "SHIPCOMBAT.Action.OrdnanceOverchargedDesc" },
  },
};

// ─── Macro Cannon Fire Tiers ──────────────────────────────────────────────────
// salvoMult × weapon.salvoSize = base shots for this tier.
// Firepower bonus (from SL allocation) adds +1 shot per FP.

export const MACRO_FIRE_TIERS = [
  { id: "rangingFire",           label: "SHIPCOMBAT.Gunner.RangingFire",           desc: "SHIPCOMBAT.Gunner.RangingFireDesc",  ammo: 1,  hitMod: -10, salvoMult: 0.5, exclusive: true  },
  { id: "volley",                label: "SHIPCOMBAT.Gunner.Volley",                ammo: 3,  hitMod:   0, salvoMult: 1,   exclusive: false },
  { id: "broadside",             label: "SHIPCOMBAT.Gunner.Broadside",             ammo: 6,  hitMod:   0, salvoMult: 1.5, exclusive: false },
  { id: "fullBroadside",         label: "SHIPCOMBAT.Gunner.FullBroadside",         ammo: 10, hitMod: +10, salvoMult: 2,   exclusive: false },
  { id: "devastatingBroadside",  label: "SHIPCOMBAT.Gunner.DevastatingBroadside",  ammo: 16, hitMod: +20, salvoMult: 3,   exclusive: false },
];

// ─── Lance Damage Tiers ──────────────────────────────────────────────────────
// Lance Battery charge range: 0–20. Does NOT charge passively; only via
// power core (+5) or Augur divert (1:1 Data→Charge).

export const LANCE_CHARGE_TIERS = [
  { min: 1,  max: 5,  label: "SHIPCOMBAT.Gunner.LanceGlancing",       multiplier: 0.5 },
  { min: 6,  max: 10, label: "SHIPCOMBAT.Gunner.LanceStandard",       multiplier: 1   },
  { min: 11, max: 15, label: "SHIPCOMBAT.Gunner.LanceFocused",        multiplier: 1.5 },
  { min: 16, max: 20, label: "SHIPCOMBAT.Gunner.LanceFullDischarge",  multiplier: 2   },
];

// Default charge tier template (labels + multipliers only).
// Boundaries are computed dynamically based on weapon chargeStep.
const CHARGE_TIER_TEMPLATE = [
  { label: "SHIPCOMBAT.Gunner.LanceGlancing",      multiplier: 0.5 },
  { label: "SHIPCOMBAT.Gunner.LanceStandard",       multiplier: 1   },
  { label: "SHIPCOMBAT.Gunner.LanceFocused",        multiplier: 1.5 },
  { label: "SHIPCOMBAT.Gunner.LanceFullDischarge",  multiplier: 2   },
];

/**
 * Build dynamic charge tiers for a given chargeStep.
 * @param {number} step  -  the weapon's chargeStep (default 5)
 * @returns {{ min: number, max: number, label: string, multiplier: number }[]}
 */
export function buildChargeTiers(step = 5) {
  return CHARGE_TIER_TEMPLATE.map((t, i) => ({
    ...t,
    min: i * step + 1,
    max: (i + 1) * step,
  }));
}

// ─── Lock Tier Decay Rounds ───────────────────────────────────────────────────
// When a lock tier's decay counter reaches 0, the tier drops by 1 and the
// counter resets to the new tier's value.  Tier 0 means the lock is removed.

export const LOCK_DECAY_ROUNDS = {
  4: 1,   // Targeting Solution  -  decays after 1 round
  3: 2,   // Deep Scan          -  decays after 2 rounds
  2: 3,   // Breach Analysis    -  decays after 3 rounds
  1: 5,   // Active Ping        -  decays after 5 rounds
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const SHIP_CLASSIFICATIONS = [
  { value: "",              label: "" },
  { value: "fighter",       label: "Fighter" },
  { value: "picket",        label: "Picket Ship" },
  { value: "cutter",        label: "Cutter" },
  { value: "sloop",         label: "Sloop" },
  { value: "destroyer",     label: "Destroyer" },
  { value: "frigate",       label: "Frigate" },
  { value: "lightCruiser",  label: "Light Cruiser" },
  { value: "cruiser",       label: "Cruiser" },
  { value: "battlecruiser", label: "Battlecruiser" },
  { value: "grandCruiser",  label: "Grand Cruiser" },
  { value: "battleship",    label: "Battleship" },
  { value: "capitalShip",   label: "Capital Ship" },
  { value: "planetKiller",  label: "Planet Killer" },
  { value: "other",         label: "Other" },
];

export const DEFAULT_COMBAT_STATE = {
  active: false,
  round: 0,
  assignedCores: {},
  reactions: {},
  roles: {},
  resources: {
    engineer: { heat: 0, powerCores: 0, auxiliaryPower: 0, actionChoices: [], extraActions: 0, stagedCores: {}, stagedShieldCores: 0, stagedAuxCores: 0, committedAuxCores: 0, heatCoresStaged: 1, fireCoresStaged: 1, payload: "" },
    pilot:     { fuelBurned: 0, bearing: 0, payload: "", coreCount: 0, coreActionsPlayed: [] },
    sensors:   { actionUsed: false, coreActionUsed: false, bdaAvailable: false, bdaCorrectionPending: false, bdaResultSL: 0, bdaTargetTokenId: null, bdaMessageId: null, locks: [], effects: [], fireCorrection: null, payload: "", coreCount: 0, coreActionsPlayed: [] },
    gunner:    { ammo: 0, power: 0, ordnanceSL: 0, allocAccuracy: 0, allocPenetration: 0, allocFirepower: 0, slLocked: false, ordnanceRolled: false, arcOverlayActive: false, payload: "", coreCount: 0, coreActionsPlayed: [] },
    ordnance:  { manpower: 0, manpowerMax: 0, armedTorpedoes: 0, armedCraft: 0, craftDestroyed: 0, craftRecovering: 0, craftPartialRecovery: 0, bosunSL: 0, bosunRolled: false, allocEfficiency: 0, allocExpedience: 0, actionUsed: false, coreActionUsed: false, commitments: [], stagedPayloads: {}, availablePayloads: 0, coreCount: 0, coreActionsPlayed: [] },
    captain:   { stance: "none", pendingStance: "", hand: [], drawPile: [], discardPile: [], triageCount: 2, triageConditionsUsed: [], handCapBonus: 0, playedCards: [], holdTheLineActive: false, payload: "", coreCount: 0, allocInitiative: 0, rolledInitiative: 0 },
  },
  turnDone: {},
  overchargeUsed: {},
};

// ─── Augur Lock Costs (AP-based) ─────────────────────────────────────────────

export const AUGUR_LOCK_COSTS = {
  activePing:        2,   // Lock Tier 1
  breachAnalysis:    4,   // Lock Tier 2
  deepScan:          7,   // Lock Tier 3
  targetingSolution: 10,  // Lock Tier 4
};

// ─── Augur Core Actions (require Power Core + AP) ────────────────────────────

export const AUGUR_CORE_ACTIONS = [
  { id: "signalInversion",  label: "SHIPCOMBAT.Sensors.SignalInversion",  desc: "SHIPCOMBAT.Sensors.SignalInversionDesc",  ap: 25, icon: "fa-solid fa-shuffle", targeted: true, duration: 1 },
  { id: "combatTelemetry",  label: "SHIPCOMBAT.Sensors.CombatTelemetry",  desc: "SHIPCOMBAT.Sensors.CombatTelemetryDesc",  ap: 30, icon: "fa-solid fa-bullseye" },
];

// ─── BDA Fire Corrections ────────────────────────────────────────────────────

export const BDA_CORRECTIONS = [
  { id: "adjustBearing",    label: "SHIPCOMBAT.BDA.AdjustBearing",    desc: "SHIPCOMBAT.BDA.AdjustBearingDesc",    icon: "fa-solid fa-crosshairs" },
  { id: "targetWeakPoint",  label: "SHIPCOMBAT.BDA.TargetWeakPoint",  desc: "SHIPCOMBAT.BDA.TargetWeakPointDesc",  icon: "fa-solid fa-shield-halved" },
  { id: "fireForEffect",    label: "SHIPCOMBAT.BDA.FireForEffect",    desc: "SHIPCOMBAT.BDA.FireForEffectDesc",    icon: "fa-solid fa-fire" },
  { id: "ceaseFireSwitch",  label: "SHIPCOMBAT.BDA.CeaseFireSwitch",  desc: "SHIPCOMBAT.BDA.CeaseFireSwitchDesc",  icon: "fa-solid fa-rotate" },
];

// ─── Ordnance Master / Manpower Actions ──────────────────────────────────────
// crew = base number of crew committed (can be reduced to min 2 via Efficiency SL)
// duration = base turns until crew return (can be reduced to min 1 via Expedience SL)

export const ORDNANCE_MASTER_ACTIONS = {
  // Row 1: Torpedo operations
  armTorpedo:     { id: "armTorpedo",     label: "SHIPCOMBAT.Ordnance.ArmTorpedo",     desc: "SHIPCOMBAT.Ordnance.ArmTorpedoDesc",     crew: 8, duration: 3, icon: "fa-solid fa-bomb",              completionBenefit: true },
  launchTorpedo:  { id: "launchTorpedo",  label: "SHIPCOMBAT.Ordnance.LaunchTorpedo",  desc: "SHIPCOMBAT.Ordnance.LaunchTorpedoDesc",  crew: 4, duration: 2, icon: "fa-solid fa-rocket",            noCancel: true },
  // Row 2a: Strike Craft operations (prep → launch → recovery) — shown only when useStrikeCraft
  armCraft:       { id: "armCraft",       label: "SHIPCOMBAT.Ordnance.ArmCraft",       desc: "SHIPCOMBAT.Ordnance.ArmCraftDesc",       crew: 9, duration: 3, icon: "fa-solid fa-jet-fighter-up",    completionBenefit: true, requiresStrikeCraft: true },
  launchCraft:    { id: "launchCraft",    label: "SHIPCOMBAT.Ordnance.LaunchCraft",    desc: "SHIPCOMBAT.Ordnance.LaunchCraftDesc",    crew: 9, duration: 3, icon: "fa-solid fa-jet-fighter",        noCancel: true,          requiresStrikeCraft: true },
  recallCraft:    { id: "recallCraft",    label: "SHIPCOMBAT.Ordnance.RecallCraft",    desc: "SHIPCOMBAT.Ordnance.RecallCraftDesc",    crew: 6, duration: 3, icon: "fa-solid fa-plane-arrival",      noCancel: true,          requiresStrikeCraft: true },
  // Row 2b: Torpedo-only replacements — shown only when !useStrikeCraft
  torpedoSalvo:   { id: "torpedoSalvo",   label: "SHIPCOMBAT.Ordnance.TorpedoSalvo",   desc: "SHIPCOMBAT.Ordnance.TorpedoSalvoDesc",   crew: 9, duration: 4, icon: "fa-solid fa-rocket-launch",     noCancel: true,          hideWithStrikeCraft: true },
  bayOptimization:{ id: "bayOptimization",label: "SHIPCOMBAT.Ordnance.BayOptimization",desc: "SHIPCOMBAT.Ordnance.BayOptimizationDesc", crew: 8, duration: 1, icon: "fa-solid fa-gears",              completionBenefit: true, hideWithStrikeCraft: true },
  emergencyLaunch:{ id: "emergencyLaunch",label: "SHIPCOMBAT.Ordnance.EmergencyLaunch",desc: "SHIPCOMBAT.Ordnance.EmergencyLaunchDesc", crew: 5, duration: 1, icon: "fa-solid fa-fire-flame-curved",  noCancel: true,          hideWithStrikeCraft: true },
  // Row 3: Support operations
  loadAmmo:       { id: "loadAmmo",       label: "SHIPCOMBAT.Ordnance.LoadAmmo",       desc: "SHIPCOMBAT.Ordnance.LoadAmmoDesc",       crew: 6, duration: 2, icon: "fa-solid fa-boxes-stacked",     completionBenefit: true },
  loadPayload:    { id: "loadPayload",    label: "SHIPCOMBAT.Ordnance.LoadPayload",    desc: "SHIPCOMBAT.Ordnance.LoadPayloadDesc",    crew: 6, duration: 2, icon: "fa-solid fa-box",               completionBenefit: true },
  generatePower:  { id: "generatePower",  label: "SHIPCOMBAT.Ordnance.GeneratePower",  desc: "SHIPCOMBAT.Ordnance.GeneratePowerDesc",  crew: 6, duration: 2, icon: "fa-solid fa-bolt",              completionBenefit: true },
  damageControl:  { id: "damageControl",  label: "SHIPCOMBAT.Ordnance.DamageControl",  desc: "SHIPCOMBAT.Ordnance.DamageControlDesc",  crew: 5, duration: 3, icon: "fa-solid fa-fire-extinguisher", completionBenefit: true },
  hullRepairParty:{ id: "hullRepairParty",label: "SHIPCOMBAT.Ordnance.HullRepairParty",desc: "SHIPCOMBAT.Ordnance.HullRepairPartyDesc",crew: 7, duration: 4, icon: "fa-solid fa-wrench",            completionBenefit: true },
};

// ─── Ordnance costs for ≤ 4-player mode ───────────────────────────────────────
// In 4-man the Gunner handles ordnance with no Bosun SL to allocate for
// Efficiency / Expedience. These override the base crew / duration so the
// actions are viable without that allocation layer.
export const ORDNANCE_4MAN_COSTS = {
  armTorpedo:      { crew: 6, duration: 2 },
  launchTorpedo:   { crew: 3, duration: 1 },
  armCraft:        { crew: 7, duration: 2 },
  launchCraft:     { crew: 7, duration: 2 },
  recallCraft:     { crew: 4, duration: 2 },
  torpedoSalvo:    { crew: 7, duration: 2 },
  bayOptimization: { crew: 6, duration: 1 },
  emergencyLaunch: { crew: 4, duration: 1 },
  loadAmmo:        { crew: 4, duration: 1 },
  loadPayload:     { crew: 4, duration: 1 },
  generatePower:   { crew: 4, duration: 1 },
  damageControl:   { crew: 3, duration: 2 },
  hullRepairParty: { crew: 5, duration: 3 },
};

// ─── Ordnance Master Logistics Doctrines (Core Actions) ────────────────────────────
// High-impact doctrines that reshape turn economy. One per round.

export const ORDNANCE_MASTER_CORE_ACTIONS = [
  {
    id: "combatRecoveryDoctrine",
    label: "SHIPCOMBAT.Ordnance.CombatRecoveryDoctrine",
    desc: "SHIPCOMBAT.Ordnance.CombatRecoveryDoctrineDesc",
    icon: "fa-solid fa-helicopter",
    effect: "Convert half destroyed craft to recovering, OR 1 recovering to armed",
    tradeoff: "Cannot launch strike craft this round",
    requiresStrikeCraft: true,
  },
  {
    id: "rapidRearm",
    label: "SHIPCOMBAT.Ordnance.RapidRearm",
    desc: "SHIPCOMBAT.Ordnance.RapidRearmDesc",
    icon: "fa-solid fa-circle-bolt",
    hideWithStrikeCraft: true,
  },
  {
    id: "shockLoadingRotation",
    label: "SHIPCOMBAT.Ordnance.ShockLoadingRotation",
    desc: "SHIPCOMBAT.Ordnance.ShockLoadingRotationDesc",
    icon: "fa-solid fa-forward",
    effect: "Instantly complete one active commitment (armTorpedo/armCraft/loadPayload)",
    tradeoff: "Commit 3 manpower for 2 rounds as fatigued crew",
  },
  {
    id: "magazineCrossfeed",
    label: "SHIPCOMBAT.Ordnance.MagazineCrossfeed",
    desc: "SHIPCOMBAT.Ordnance.MagazineCrossfeedDesc",
    icon: "fa-solid fa-arrows-split-up-and-left",
    effect: "Convert gunner ammo to ordnance: spend 6 ammo for +1 torpedo or 4 ammo for +1 payload",
    tradeoff: "Gunner cannot receive ammo reloads until next round",
  },
  {
    id: "deckConsciption",
    label: "SHIPCOMBAT.Ordnance.DeckConsciption",
    desc: "SHIPCOMBAT.Ordnance.DeckConscriptionDesc",
    icon: "fa-solid fa-people-group",
    effect: "Gain +25% of max temporary manpower this round, OR restore 10% of permanently lost crew",
    tradeoff: "Next round manpower regeneration reduced by 4",
  },
];

// ─── Ordnance Master: Payload Types ──────────────────────────────────────────
// Two payloads per receiving role. Cost is in OP. Effects keyed by role.

export const PAYLOAD_TYPES = {
  // ── Captain payloads ──
  cogitatorDataSlate: {
    id: "cogitatorDataSlate",
    label: "SHIPCOMBAT.Payload.CogitatorDataSlate",
    desc:  "SHIPCOMBAT.Payload.CogitatorDataSlateDesc",
    targetRole: "captain",
    cost: 4,
    icon: "fa-solid fa-tablet-screen-button",
  },
  fireSuppression: {
    id: "fireSuppression",
    label: "SHIPCOMBAT.Payload.FireSuppression",
    desc:  "SHIPCOMBAT.Payload.FireSuppressionDesc",
    targetRole: "captain",
    cost: 3,
    icon: "fa-solid fa-fire-extinguisher",
  },
  // ── Engineer payloads ──
  emergencyCoolant: {
    id: "emergencyCoolant",
    label: "SHIPCOMBAT.Payload.EmergencyCoolant",
    desc:  "SHIPCOMBAT.Payload.EmergencyCoolantDesc",
    targetRole: "engineer",
    cost: 5,
    icon: "fa-solid fa-snowflake",
  },
  auxCapacitors: {
    id: "auxCapacitors",
    label: "SHIPCOMBAT.Payload.AuxCapacitors",
    desc:  "SHIPCOMBAT.Payload.AuxCapacitorsDesc",
    targetRole: "engineer",
    cost: 4,
    icon: "fa-solid fa-car-battery",
  },
  // ── Helmsman payloads ──
  fuelCatalyst: {
    id: "fuelCatalyst",
    label: "SHIPCOMBAT.Payload.FuelCatalyst",
    desc:  "SHIPCOMBAT.Payload.FuelCatalystDesc",
    targetRole: "pilot",
    cost: 4,
    icon: "fa-solid fa-gas-pump",
  },
  chaffPods: {
    id: "chaffPods",
    label: "SHIPCOMBAT.Payload.ChaffPods",
    desc:  "SHIPCOMBAT.Payload.ChaffPodsDesc",
    targetRole: "pilot",
    cost: 5,
    icon: "fa-solid fa-arrows-up-down-left-right",
  },
  // ── Augur payloads ──
  sensorBuoy: {
    id: "sensorBuoy",
    label: "SHIPCOMBAT.Payload.SensorBuoy",
    desc:  "SHIPCOMBAT.Payload.SensorBuoyDesc",
    targetRole: "sensors",
    cost: 4,
    icon: "fa-solid fa-tower-broadcast",
  },
  lockStabilizer: {
    id: "lockStabilizer",
    label: "SHIPCOMBAT.Payload.LockStabilizer",
    desc:  "SHIPCOMBAT.Payload.LockStabilizerDesc",
    targetRole: "sensors",
    cost: 5,
    icon: "fa-solid fa-sliders",
  },
  // ── Gunner payloads ──
  apShells: {
    id: "apShells",
    label: "SHIPCOMBAT.Payload.APShells",
    desc:  "SHIPCOMBAT.Payload.APShellsDesc",
    targetRole: "gunner",
    cost: 5,
    icon: "fa-solid fa-circle-radiation",
  },
  scatterShot: {
    id: "scatterShot",
    label: "SHIPCOMBAT.Payload.ScatterShot",
    desc:  "SHIPCOMBAT.Payload.ScatterShotDesc",
    targetRole: "gunner",
    cost: 4,
    icon: "fa-solid fa-burst",
  },
};

// Group payloads by receiving role for dropdown menus
export const PAYLOADS_BY_ROLE = Object.values(PAYLOAD_TYPES).reduce((acc, p) => {
  (acc[p.targetRole] ??= []).push(p);
  return acc;
}, {});

// ─── Crit System ─────────────────────────────────────────────────────────────
// Location: roll d6. Severity: roll d10 (1–5 Low, 6–8 Medium, 9–10 High).

export const CRIT_LOCATIONS = [
  { id: "hull",           rolls: [1, 2], label: "SHIPCOMBAT.Crit.Location.hull",           triageAction: "SHIPCOMBAT.Crit.Triage.hull" },
  { id: "engines",        rolls: [3],    label: "SHIPCOMBAT.Crit.Location.engines",        triageAction: "SHIPCOMBAT.Crit.Triage.engines" },
  { id: "manoeuvring",    rolls: [4],    label: "SHIPCOMBAT.Crit.Location.manoeuvring",    triageAction: "SHIPCOMBAT.Crit.Triage.manoeuvring" },
  { id: "coreSystems",    rolls: [5],    label: "SHIPCOMBAT.Crit.Location.coreSystems",    triageAction: "SHIPCOMBAT.Crit.Triage.coreSystems" },
  { id: "weaponsSensors", rolls: [6],    label: "SHIPCOMBAT.Crit.Location.weaponsSensors", triageAction: "SHIPCOMBAT.Crit.Triage.weaponsSensors" },
];

export const CRIT_SEVERITY_TIERS = [
  { tier: "low",    min: 1,  max: 5  },
  { tier: "medium", min: 6,  max: 8  },
  { tier: "high",   min: 9,  max: 10 },
];

export const CRIT_CONDITIONS = {
  hull: {
    low:    { id: "minorLeak",          label: "SHIPCOMBAT.Crit.Condition.hull.low",             cumulative: false },
    medium: { id: "structuralDamage",   label: "SHIPCOMBAT.Crit.Condition.hull.medium",          cumulative: false },
    high:   { id: "blazingInferno",     label: "SHIPCOMBAT.Crit.Condition.hull.high",            cumulative: false },
  },
  engines: {
    low:    { id: "engineStrain",       label: "SHIPCOMBAT.Crit.Condition.engines.low",          cumulative: false },
    medium: { id: "thrustDamage",       label: "SHIPCOMBAT.Crit.Condition.engines.medium",       cumulative: false },
    high:   { id: "engineFailure",      label: "SHIPCOMBAT.Crit.Condition.engines.high",         cumulative: false },
  },
  manoeuvring: {
    low:    { id: "helmSluggish",       label: "SHIPCOMBAT.Crit.Condition.manoeuvring.low",      cumulative: false },
    medium: { id: "manoFailure",        label: "SHIPCOMBAT.Crit.Condition.manoeuvring.medium",   cumulative: false },
    high:   { id: "helmUnresponsive",   label: "SHIPCOMBAT.Crit.Condition.manoeuvring.high",     cumulative: false },
  },
  coreSystems: {
    low:    { id: "powerFluctuation",   label: "SHIPCOMBAT.Crit.Condition.coreSystems.low",      cumulative: true },
    medium: { id: "heatSurge",          label: "SHIPCOMBAT.Crit.Condition.coreSystems.medium",   cumulative: true },
    high:   { id: "apShutdown",         label: "SHIPCOMBAT.Crit.Condition.coreSystems.high",     cumulative: true },
  },
  weaponsSensors: {
    low:    { id: "weaponJam",          label: "SHIPCOMBAT.Crit.Condition.weaponsSensors.low",    cumulative: true },
    medium: { id: "sensorBlind",        label: "SHIPCOMBAT.Crit.Condition.weaponsSensors.medium", cumulative: true },
    high:   { id: "fireControlFailure", label: "SHIPCOMBAT.Crit.Condition.weaponsSensors.high",   cumulative: true },
  },
};

/** Map a d6 roll to a CRIT_LOCATIONS entry. */
export function critLocationFromRoll(d6) {
  return CRIT_LOCATIONS.find(l => l.rolls.includes(d6)) ?? CRIT_LOCATIONS[0];
}

/** Map a d10 roll to a severity tier string. */
export function critSeverityFromRoll(d10) {
  return CRIT_SEVERITY_TIERS.find(t => d10 >= t.min && d10 <= t.max)?.tier ?? "low";
}

// ─── Gunner: Core Actions ─────────────────────────────────────────────────────

export const GUNNER_CORE_ACTIONS = [
  {
    id:   "extendRange",
    label: "SHIPCOMBAT.Gunner.Core.ExtendRange.label",
    desc:  "SHIPCOMBAT.Gunner.Core.ExtendRange.desc",
    icon:  "fa-solid fa-satellite-dish",
  },
  {
    id:   "chooseCritLoc",
    label: "SHIPCOMBAT.Gunner.Core.ChooseCritLoc.label",
    desc:  "SHIPCOMBAT.Gunner.Core.ChooseCritLoc.desc",
    icon:  "fa-solid fa-bullseye",
  },
  {
    id:   "emergencyResupply",
    label: "SHIPCOMBAT.Gunner.Core.EmergencyResupply.label",
    desc:  "SHIPCOMBAT.Gunner.Core.EmergencyResupply.desc",
    icon:  "fa-solid fa-boxes-stacked",
  },
];

// ─── Captain: Stances ─────────────────────────────────────────────────────────
// ─── Captain: Core Actions ───────────────────────────────────────────────────
// Consumes the assigned Power Core. One per engagement. No manpower cost.

export const CAPTAIN_CORE_ACTIONS = [
  {
    id:   "emergencyProtocols",
    label: "SHIPCOMBAT.Captain.Core.EmergencyProtocols.label",
    desc:  "SHIPCOMBAT.Captain.Core.EmergencyProtocols.desc",
    icon:  "fa-solid fa-broom",
  },
  {
    id:   "ironCommand",
    label: "SHIPCOMBAT.Captain.Core.IronCommand.label",
    desc:  "SHIPCOMBAT.Captain.Core.IronCommand.desc",
    icon:  "fa-solid fa-shield-halved",
  },
  {
    id:   "battleClarity",
    label: "SHIPCOMBAT.Captain.Core.BattleClarity.label",
    desc:  "SHIPCOMBAT.Captain.Core.BattleClarity.desc",
    icon:  "fa-solid fa-crosshairs",
  },
  {
    id:   "emergencySalvage",
    label: "SHIPCOMBAT.Captain.Core.EmergencySalvage.label",
    desc:  "SHIPCOMBAT.Captain.Core.EmergencySalvage.desc",
    icon:  "fa-solid fa-recycle",
  },
  {
    id:   "commandOverride",
    label: "SHIPCOMBAT.Captain.Core.CommandOverride.label",
    desc:  "SHIPCOMBAT.Captain.Core.CommandOverride.desc",
    icon:  "fa-solid fa-forward-fast",
  },
  {
    id:   "deadReckoning",
    label: "SHIPCOMBAT.Captain.Core.DeadReckoning.label",
    desc:  "SHIPCOMBAT.Captain.Core.DeadReckoning.desc",
    icon:  "fa-solid fa-compass-drafting",
  },
];

// ─── Captain: Card Deck ───────────────────────────────────────────────────────
// 23-card deck. copies defaults to 1. Gambits set stance via pendingStance.

export const CAPTAIN_CARDS = [
  // BOOST  -  10 unique cards targeting specific roles
  { id: "inspiredTargeting",  category: "boost",    copies: 1, targetRole: "gunner",    label: "SHIPCOMBAT.Captain.Card.InspiredTargeting" },
  { id: "gunsHot",            category: "boost",    copies: 1, targetRole: "gunner",    label: "SHIPCOMBAT.Captain.Card.GunsHot" },
  { id: "overdriveCommand",   category: "boost",    copies: 1, targetRole: "engineer", label: "SHIPCOMBAT.Captain.Card.OverdriveCommand" },
  { id: "doubleShift",        category: "boost",    copies: 1, targetRole: "engineer", label: "SHIPCOMBAT.Captain.Card.DoubleShift" },
  { id: "pressTheAttack",     category: "boost",    copies: 1, targetRole: "pilot",     label: "SHIPCOMBAT.Captain.Card.PressTheAttack" },
  { id: "hardOver",           category: "boost",    copies: 1, targetRole: "pilot",     label: "SHIPCOMBAT.Captain.Card.HardOver" },
  { id: "enhancedSensor",     category: "boost",    copies: 1, targetRole: "sensors",   label: "SHIPCOMBAT.Captain.Card.EnhancedSensor" },
  { id: "sensorPriority",     category: "boost",    copies: 1, targetRole: "sensors",   label: "SHIPCOMBAT.Captain.Card.SensorPriority" },
  { id: "armamentOrder",      category: "boost",    copies: 1, targetRole: "ordnance",  label: "SHIPCOMBAT.Captain.Card.ArmamentOrder" },
  { id: "acceleratedLoading", category: "boost",    copies: 1, targetRole: "ordnance",  label: "SHIPCOMBAT.Captain.Card.AcceleratedLoading" },
  // SHIPWIDE  -  4 cards
  { id: "emergencyReserves",  category: "shipwide", copies: 2, label: "SHIPCOMBAT.Captain.Card.EmergencyReserves" },
  { id: "holdTheLine",        category: "shipwide", copies: 1, label: "SHIPCOMBAT.Captain.Card.HoldTheLine" },
  { id: "ventingSequence",    category: "shipwide", copies: 1, label: "SHIPCOMBAT.Captain.Card.VentingSequence" },
  // REACTION  -  3 cards (played in response to enemy actions)
  { id: "hardenShields",      category: "reaction", copies: 2, label: "SHIPCOMBAT.Captain.Card.hardenShields" },
  { id: "repairArmour",      category: "reaction", copies: 1, label: "SHIPCOMBAT.Captain.Card.repairArmour" },
  // GAMBIT  -  5 cards (set pendingStance; promoted to active stance at round end)
  { id: "aggressiveDoctrine", category: "gambit",   copies: 1, setsStance: "aggressive", label: "SHIPCOMBAT.Captain.Card.AggressiveDoctrine" },
  { id: "defensiveFormation", category: "gambit",   copies: 1, setsStance: "defensive",  label: "SHIPCOMBAT.Captain.Card.DefensiveFormation" },
  { id: "redAlert",            category: "gambit",  copies: 1, setsStance: "redAlert",     label: "SHIPCOMBAT.Captain.Card.RedAlert" },
  { id: "devastationProtocol", category: "gambit",  copies: 1, setsStance: "devastation", label: "SHIPCOMBAT.Captain.Card.DevastationProtocol" },
  { id: "standDown",           category: "gambit",  copies: 2, setsStance: "none",        label: "SHIPCOMBAT.Captain.Card.StandDown" },
];

/**
 * Build the shuffled starting deck as an array of card ID strings.
 * Cards with copies > 1 appear that many times. Uses Fisher-Yates shuffle.
 * @returns {string[]}
 */
export function buildCaptainDeck(excludeRoles = [], excludeCards = []) {
  const deck = [];
  for (const card of CAPTAIN_CARDS) {
    if (excludeRoles.includes(card.targetRole ?? "")) continue;
    if (excludeCards.includes(card.id)) continue;
    for (let i = 0; i < (card.copies ?? 1); i++) deck.push(card.id);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
