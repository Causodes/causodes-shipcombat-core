/**
 * Ordnance Master role  -  crew management and ordnance logistics.
 *
 * Resource: Manpower (0–manpowerMax, default 12). Crew are committed to tasks
 * for a set number of turns, then return to the pool.
 *
 * Ordnance Master SL: Leadership test rolled once per turn. SL acts as a shared discount
 * pool  -  spend SL points to reduce crew cost of individual actions (min 1 crew
 * per action). Strategic choice: which actions get the discount?
 *
 * Actions commit N crew for D turns. While committed, those crew are unavailable.
 * At round transition, commitments tick down; crew return when timer hits 0.
 *
 * Core Actions: permanent sacrifice. manpowerMax is reduced by the permanent cost.
 * Those crew never return.
 *
 * Payloads: still loaded via loadPayload action (commits 3 crew for 1 turn).
 */

import { emitToGM } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { MODULE_ID, PAYLOAD_TYPES, PAYLOADS_BY_ROLE, ORDNANCE_MASTER_ACTIONS, ORDNANCE_MASTER_CORE_ACTIONS, ORDNANCE_4MAN_COSTS } from "../constants.js";
import { RecoverCraftPopup } from "../apps/StrikeCraftPopups.js";
import { isOrdnance, isTorpedo, isStrikeCraft, ordnanceSubtype } from "../actors/ordnance/ordnance-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the torpedo and strike-craft templates that are currently loaded in
 * the ordnance bays, as selected on the Overview tab.  If nothing is selected
 * the arrays are empty and ordnance actions are unavailable.
 */
function _getActiveTemplates(sys) {
  const active = sys.activeOrdnance ?? [];
  const torpInv = sys.ordnanceActors?.torpedo     ?? [];
  const scInv   = sys.ordnanceActors?.strikeCraft ?? [];
  return {
    torpedoTemplates: active
      .filter(a => a?.type === "torpedo")
      .map(a => torpInv.find(t => t?.id === a.actorId))
      .filter(Boolean),
    craftTemplates: active
      .filter(a => a?.type === "strikeCraft")
      .map(a => scInv.find(t => t?.id === a.actorId))
      .filter(Boolean),
  };
}

async function _resolveOrdnanceActor(sheet) {
  const sys = SystemAdapter.current.getShipData(sheet.actor);
  const ref = sys.crewActors?.ordnance;
  if (ref?.uuid) {
    try { return await fromUuid(ref.uuid); } catch { /* ignore */ }
  }
  const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "ordnance");
  if (entry) {
    const user = game.users.get(entry[0]);
    return user?.character ?? null;
  }
  return null;
}

/**
 * Calculate available manpower (total minus committed).
 */
function _availableManpower(sys) {
  const mp = sys.resources?.ordnance?.manpower ?? 0;
  return mp;
}

/**
 * Apply Ordnance Master allocation discounts to action costs.
 * Crew cost minimum is 2, duration minimum is 1 turn.
 */
function _effectiveCrewCost(baseCrew, allocEfficiency) {
  return Math.max(2, baseCrew - Math.max(0, allocEfficiency));
}

function _effectiveDuration(baseDuration, allocExpedience) {
  return Math.max(1, baseDuration - Math.max(0, allocExpedience));
}

/**
 * Gather all deployed torpedoes & strike craft for the current ship.
 */
function _getDeployedOrdnance(shipActor) {
  if (!canvas.scene) return [];
  const shipTokens = shipActor.getActiveTokens().map(t => t.id);
  return canvas.scene.tokens
    .filter(td => {
      if (!isOrdnance(td.actor)) return false;
      const parentId = td.actor?.system?.parentShipTokenId ?? td.getFlag(MODULE_ID, "parentShipTokenId");
      return parentId && shipTokens.includes(parentId);
    })
    .map(td => ({
      tokenId: td.id,
      name: td.name,
      img: td.texture?.src ?? td.actor?.img ?? "",
      type: isTorpedo(td.actor) ? "torpedo" : "strikeCraft",
      turnComplete: td.actor?.system?.turnComplete ?? false,
      // Launch-turn torpedoes spawned this round: turnComplete=true but no movement yet.
      // Disable the "mark done" toggle so the Gunner can't accidentally unlock it.
      isLaunchTurn: isTorpedo(td.actor)
        && (td.actor?.system?.turnComplete ?? false)
        && (td.actor?.system?.helm?.thrustPct ?? 0) === 0
        && (td.actor?.system?.helm?.prevTurnMove ?? 0) === 0,
      rtb: td.actor?.system?.rtb ?? false,
      hull: td.actor?.system?.hull ?? { value: 0, max: 0 },
      fuel: td.actor?.system?.fuel ?? { value: 0, max: 0 },
    }));
}

// ── Context Builder ─────────────────────────────────────────────────────────

export function buildOrdnanceContext(sys, opts = {}) {
  const manpower     = sys.resources?.ordnance?.manpower    ?? 0;
  const componentManpower = opts.ordnanceBayStats?.manpower ?? 0;
  const storedMax    = sys.resources?.ordnance?.manpowerMax ?? 0;
  const manpowerMax  = storedMax > 0 ? storedMax : componentManpower;
  const mpLabel      = opts.crewScale === "smallcraft"
    ? (game?.i18n?.localize("SHIPCOMBAT.Ordnance.OPSmallCraft") ?? "Hands")
    : (game?.i18n?.localize("SHIPCOMBAT.Ordnance.OP") ?? "Manpower");
  const bosunSL      = sys.resources?.ordnance?.bosunSL     ?? 0;
  const bosunRolled  = sys.resources?.ordnance?.bosunRolled  ?? false;
  const actionUsed   = sys.resources?.ordnance?.actionUsed   ?? false;
  const coreUsed     = sys.resources?.ordnance?.coreActionUsed ?? false;
  // Single coreCount integer replaces the old captainFreeCores + assignedCores dual-variable system
  // In reduced-crew modes the ordnance role is absorbed by another station:
  //   crewSize = 5  → captain handles ordnance (fall back to captain.coreCount)
  //   crewSize <= 4 → gunner handles ordnance  (fall back to gunner.coreCount)
  const _ordCoreDirect = sys.resources?.ordnance?.coreCount ?? 0;
  const _crewSz = sys.crewSize ?? 6;
  const coreCount = _ordCoreDirect
    || (_crewSz === 5  ? (sys.resources?.captain?.coreCount ?? 0) : 0)
    || (_crewSz <= 4   ? (sys.resources?.gunner?.coreCount  ?? 0) : 0);
  const hasCoreAssigned     = coreCount > 0;
  const coreActionsPlayed   = sys.resources?.ordnance?.coreActionsPlayed ?? [];
  const coreActionsPlayedLabels = coreActionsPlayed.map(id => {
    const entry = ORDNANCE_MASTER_CORE_ACTIONS.find(a => a.id === id);
    return entry ? game.i18n.localize(entry.label) : id;
  });
  const commitments  = sys.resources?.ordnance?.commitments  ?? [];
  const currentRound = sys.round ?? 0;
  const staged       = sys.resources?.ordnance?.stagedPayloads ?? {};

  // ── Captain card boosts for Ordnance Master tab display ──────────────────────────────
  const ORDNANCE_BOOST_CARDS = ["armamentOrder", "acceleratedLoading"];
  const _captainCards = sys.resources?.captain?.playedCards ?? [];
  const captainBoosts = _captainCards
    .filter(id => ORDNANCE_BOOST_CARDS.includes(id))
    .map(id => ({
      id,
      label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${id}`),
    }));

  // Auxiliary Power (shared with Engineer, displayed on Ordnance Master bar)
  const auxPower    = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const auxPowerMax = opts.reactorStats?.auxPowerCapacity ?? 0;
  const auxPowerPct = auxPowerMax > 0 ? Math.min(100, Math.round((auxPower / auxPowerMax) * 100)) : 0;

  // Both percentages are relative to the ORIGINAL component max so they tile without overlap
  const baseMax = componentManpower > 0 ? componentManpower : manpowerMax;
  const mpPct = baseMax > 0 ? Math.min(100, Math.round((manpower / baseMax) * 100)) : 0;
  const mpLostPct = componentManpower > 0 ? Math.min(100, Math.round(((componentManpower - manpowerMax) / componentManpower) * 100)) : 0;

  // Auto-arm timer
  const autoArmTimer    = sys.resources?.ordnance?.autoArmTimer  ?? 3;
  const autoLoadTimer   = sys.resources?.ordnance?.autoLoadTimer ?? 2;

  // Readiness counts  -  armed torpedoes & strike craft templates available on ship
  const { torpedoTemplates, craftTemplates } = _getActiveTemplates(sys);
  const armedTorpedoes       = sys.resources?.ordnance?.armedTorpedoes       ?? 0;
  const armedCraft           = sys.resources?.ordnance?.armedCraft             ?? 0;
  const craftDestroyed       = sys.resources?.ordnance?.craftDestroyed         ?? 0;
  const craftRecovering      = sys.resources?.ordnance?.craftRecovering        ?? 0;
  const craftPartialRecovery = sys.resources?.ordnance?.craftPartialRecovery   ?? 0;
  const readyTorpedoes      = armedTorpedoes;
  const readyCraft           = armedCraft;

  // SL Allocation Tracks
  const allocEfficiency = sys.resources?.ordnance?.allocEfficiency ?? 0;
  const allocExpedience = sys.resources?.ordnance?.allocExpedience ?? 0;

  // Deployed ordnance (must come before action list for criteria checks)
  const ship = opts.shipActor;
  const deployed = ship ? _getDeployedOrdnance(ship) : [];
  const deployedTorpedoes = deployed.filter(d => d.type === "torpedo");
  const deployedCraft     = deployed.filter(d => d.type === "strikeCraft");
  const deployedCraftCount = deployedCraft.length;

  // Bay stats for capacity checks
  const maxFlightsVal       = opts.ordnanceBayStats?.maxFlights ?? 2;
  const strikeCraftCapacity = opts.ordnanceBayStats?.strikeCraftCapacity ?? 6;
  const torpedoCapacity     = opts.ordnanceBayStats?.torpedoCapacity ?? 4;

  // Ship state for action criteria
  const internalFire    = sys.internalFire ?? 0;
  const hullValue       = opts.shipActor?.system?.hull?.value ?? 0;
  const hullMax         = opts.shipActor?.system?.hull?.max ?? Infinity;
  const hullDamaged     = hullValue > 0 && hullValue < hullMax;
  const prowGunLocked   = sys.resources?.pilot?.prowGunLocked ?? false;

  // In 4-man mode the Gunner handles ordnance with no Bosun SL for allocation,
  // so base costs are pre-reduced via ORDNANCE_4MAN_COSTS.
  const crewSize = sys.crewSize ?? 6;
  const is4man = crewSize <= 4;

  const useStrikeCraft = opts.useStrikeCraft !== false;

  // Build action list with affordability using allocated tracks.
  const actions = Object.values(ORDNANCE_MASTER_ACTIONS)
    .filter(a => {
      if (a.requiresStrikeCraft && !useStrikeCraft) return false;
      if (a.hideWithStrikeCraft && useStrikeCraft)  return false;
      return true;
    })
    .map(a => {
    const override = is4man ? ORDNANCE_4MAN_COSTS[a.id] : null;
    const baseCrew     = override?.crew     ?? a.crew;
    const baseDuration = override?.duration ?? a.duration;
    const effectiveCrew = _effectiveCrewCost(baseCrew, allocEfficiency);
    const effectiveDuration = _effectiveDuration(baseDuration, allocExpedience);
    const canAfford = manpower >= effectiveCrew;

    // Per-action criteria checks
    let criteriaMet = true;
    let disabledReason = null;
    if (a.id === "damageControl"   && internalFire <= 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoInternalFire"); }
    if (a.id === "hullRepairParty" && !hullDamaged)      { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.HullUndamaged"); }
    if (a.id === "armTorpedo"      && torpedoTemplates.length === 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoOrdnanceInSlot"); }
    if (a.id === "armCraft"        && craftTemplates.length === 0)   { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoOrdnanceInSlot"); }
    if (a.id === "launchTorpedo"   && torpedoTemplates.length === 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoOrdnanceInSlot"); }
    if (a.id === "launchTorpedo"   && criteriaMet && armedTorpedoes <= 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoArmedTorpedoes"); }
    if (a.id === "torpedoSalvo"    && torpedoTemplates.length === 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoOrdnanceInSlot"); }
    if (a.id === "torpedoSalvo"    && criteriaMet && armedTorpedoes <= 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoArmedTorpedoes"); }
    if (a.id === "emergencyLaunch" && torpedoTemplates.length === 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoOrdnanceInSlot"); }
    if (a.id === "launchCraft"     && craftTemplates.length === 0)   { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoOrdnanceInSlot"); }
    if (a.id === "launchCraft"     && criteriaMet && armedCraft <= 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoArmedCraft"); }
    if (a.id === "launchCraft"     && criteriaMet && (deployedCraftCount >= maxFlightsVal || deployedCraftCount + craftDestroyed >= strikeCraftCapacity)) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.FlightCapacityReached"); }
    if (a.id === "recallCraft"     && deployedCraft.length === 0) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.NoCraftDeployed"); }
    // Bow ordnance locked after ramming
    if (prowGunLocked && ["armTorpedo", "launchTorpedo", "torpedoSalvo", "emergencyLaunch", "armCraft", "launchCraft"].includes(a.id)) { criteriaMet = false; disabledReason = game.i18n.localize("SHIPCOMBAT.Ordnance.BowLaunchLocked"); }

    const descLocalized = game.i18n.localize(a.desc);
    return {
      ...a,
      labelLocalized: game.i18n.localize(a.label),
      descLocalized,
      tooltip: (canAfford && criteriaMet) ? descLocalized : (disabledReason ?? game.i18n.localize("SHIPCOMBAT.Ordnance.InsufficientCrew")),
      baseCrew,
      baseDuration,
      effectiveCrew,
      effectiveDuration,
      canAfford: canAfford && criteriaMet,
    };
  });

  // Core actions (each consumes the assigned Power Core; no manpower cost)
  const coreActions = ORDNANCE_MASTER_CORE_ACTIONS
    .filter(a => {
      if (a.requiresStrikeCraft && !useStrikeCraft) return false;
      if (a.hideWithStrikeCraft && useStrikeCraft)  return false;
      return true;
    })
    .map(a => {
    let criteriaMet = true;
    if (a.id === "combatRecoveryDoctrine") {
      criteriaMet = craftDestroyed > 0 || craftPartialRecovery > 0;
    }
    if (a.id === "shockLoadingRotation") {
      criteriaMet = commitments.length > 0;
    }
    if (a.id === "magazineCrossfeed") {
      const gunnerAmmo = sys.resources?.gunner?.ammo ?? 0;
      criteriaMet = gunnerAmmo >= 4;
    }
    if (a.id === "rapidRearm") {
      criteriaMet = torpedoTemplates.length > 0;
    }

    // rapidRearm: use a crew-size-specific description
    let descLocalized = game.i18n.localize(a.desc);
    if (a.id === "rapidRearm" && crewSize < 6) {
      descLocalized = game.i18n.localize("SHIPCOMBAT.Ordnance.RapidRearmDescSmallCrew");
    }
    // generatePower: append the live AP-per-core value from the reactor component
    if (a.id === "generatePower") {
      const apValue = opts.reactorStats?.reserveMultiplier ?? 0;
      descLocalized = descLocalized.replace(/\.$/, "") + ` (${apValue}).`;
    }

    return {
      ...a,
      icon: a.icon ?? "fa-solid fa-bolt",
      labelLocalized: game.i18n.localize(a.label),
      descLocalized,
      canAfford: coreCount > 0 && criteriaMet,
    };
  });

  // Commitment display
  const commitmentDisplay = commitments.map((c, i) => {
    const actionDef = ORDNANCE_MASTER_ACTIONS[c.action];
    const noCancel  = !!(actionDef?.noCancel);
    const completionBenefit = !!(actionDef?.completionBenefit);
    return {
      coreActionLabel: c.action?.startsWith("core:") ? game.i18n.localize(ORDNANCE_MASTER_CORE_ACTIONS.find(a => a.id === c.action.slice(5))?.label ?? c.action.slice(5)) : null,
      coreActionIcon: c.action?.startsWith("core:") ? "fa-solid fa-bolt" : null,
      index: i,
      actionLabel: c.action?.startsWith("core:")
        ? game.i18n.format("SHIPCOMBAT.Ordnance.CoreFatigueLabel", { action: game.i18n.localize(ORDNANCE_MASTER_CORE_ACTIONS.find(a => a.id === c.action.slice(5))?.label ?? c.action.slice(5)) })
        : game.i18n.localize(ORDNANCE_MASTER_ACTIONS[c.action]?.label ?? c.action),
      crewCount: c.crewCount,
      turnsRemaining: c.turnsRemaining,
      icon: c.action?.startsWith("core:") ? "fa-solid fa-bolt" : (ORDNANCE_MASTER_ACTIONS[c.action]?.icon ?? "fa-solid fa-users"),
      isNew: c.addedRound === currentRound,
      noCancel,
      completionBenefit,
    };
  });

  // Payload options per role
  const availablePayloads = sys.resources?.ordnance?.availablePayloads ?? 0;
  const payloadOptions = {};
  for (const [roleId, payloads] of Object.entries(PAYLOADS_BY_ROLE)) {
    const hasActive = !!(sys.resources?.[roleId]?.payload);
    const roleKey   = roleId.charAt(0).toUpperCase() + roleId.slice(1);
    payloadOptions[roleId] = {
      hasActive,
      roleLabel: sys.roleTitles?.[roleId] || game.i18n.localize(`SHIPCOMBAT.Role.${roleKey}`),
      items: payloads.map(p => ({
        ...p,
        labelLocalized: game.i18n.localize(p.label),
        descLocalized:  game.i18n.localize(p.desc),
        canSend: availablePayloads > 0 && !hasActive,
      })),
    };
  }

  // Active payloads on receiving roles
  const activePayloads = {};
  for (const roleId of ["gunner", "pilot", "sensors", "engineer"]) {
    const pId = sys.resources?.[roleId]?.payload ?? "";
    if (pId) {
      const pDef = PAYLOAD_TYPES[pId];
      activePayloads[roleId] = {
        id: pId,
        label: pDef ? game.i18n.localize(pDef.label) : pId,
        icon: pDef?.icon ?? "fa-solid fa-box",
      };
    }
  }

  // Loading payloads count = commitments with action "loadPayload"
  const loadingCount = commitments.filter(c => c.action === "loadPayload").length;

  // Loading torpedoes count = active armTorpedo commitments
  const loadingTorpedoes = commitments.filter(c => c.action === "armTorpedo").length;

  // Loading strike craft count = active armCraft commitments
  const loadingCraft = commitments.filter(c => c.action === "armCraft").length;

  // ── Ordnance inventory: resolve template actor stats for display ──────────
  const _resolveActorSync = (ref) => {
    try { return (typeof fromUuidSync !== "undefined" && fromUuidSync) ? fromUuidSync(ref.uuid) : null; } catch { return null; }
  };

  const torpedoActorData = torpedoTemplates.map(ref => {
    const actor = _resolveActorSync(ref) ?? game.actors.get(ref.id) ?? null;
    const s = actor?.system ?? {};
    return {
      name:         actor?.name  ?? ref.name  ?? "Unknown",
      img:          actor?.img   ?? ref.img   ?? "icons/svg/mystery-man.svg",
      uuid:         ref.uuid,
      id:           ref.id,
      speed:        s.movement?.speed          ?? 0,
      maneuverability: s.movement?.maneuverability ?? 0,
      fuel:         s.fuel?.max                ?? 0,
      damage:       s.payloadDamage            ?? 0,
      radius:       s.payloadRadius            ?? 0,
      rend:         s.traits?.rend             ?? 0,
      ap:           s.traits?.armourPenetration ?? 0,
      shieldBurn:   s.traits?.shieldBurn       ?? 0,
      shieldBypass: s.traits?.shieldBypass     ?? false,
    };
  });

  const craftActorData = craftTemplates.map(ref => {
    const actor = _resolveActorSync(ref) ?? game.actors.get(ref.id) ?? null;
    const s = actor?.system ?? {};
    return {
      name:            actor?.name ?? ref.name ?? "Unknown",
      img:             actor?.img  ?? ref.img  ?? "icons/svg/mystery-man.svg",
      uuid:            ref.uuid,
      id:              ref.id,
      craftType:       s.craftType       ?? "fighter",
      speed:           s.movement?.speed ?? 0,
      maneuverability: s.movement?.maneuverability ?? 0,
      hull:            s.hull?.max       ?? 0,
      ammo:            s.ammo?.max       ?? 0,
      damage:          s.payloadDamage   ?? 0,
      rend:            s.traits?.rend             ?? 0,
      ap:              s.traits?.armourPenetration ?? 0,
      shieldBurn:      s.traits?.shieldBurn       ?? 0,
      shieldBypass:    s.traits?.shieldBypass     ?? false,
    };
  });

  // ── Build strike craft pip array ───────────────────────────────────────

  // Strike Craft pips: left→right active states, destroyed fills from right edge.
  const craftPips = Array.from({ length: strikeCraftCapacity }, () => ({ state: "empty" }));
  let left = 0;

  const fillFromLeft = (count, state) => {
    const max = Math.max(0, Math.min(count, strikeCraftCapacity));
    for (let i = 0; i < max && left < strikeCraftCapacity; i++) {
      craftPips[left++] = { state };
    }
  };

  fillFromLeft(deployedCraftCount, "deployed");
  fillFromLeft(craftRecovering, "recovering");
  fillFromLeft(craftPartialRecovery, "partial");
  fillFromLeft(loadingCraft, "loading");
  fillFromLeft(readyCraft, "ready");

  const destroyedCount = Math.max(0, Math.min(craftDestroyed, strikeCraftCapacity));
  for (let i = 0; i < destroyedCount; i++) {
    const idx = strikeCraftCapacity - 1 - i;
    craftPips[idx] = { state: "destroyed" };
  }

  return {
    manpower,
    manpowerMax,
    mpPct,
    mpLostPct,
    mpLabel,
    auxPower,
    auxPowerMax,
    auxPowerPct,
    bosunSL,
    bosunRolled,
    actionUsed,
    coreUsed,
    coreCount,
    hasCoreAssigned,
    hasCaptainFreeCore: false,
    coreActionsPlayedLabels,
    captainBoosts,
    canRollOrdnanceMaster: !bosunRolled,
    actions,
    coreActions,
    commitments: commitmentDisplay,
    commitmentCount: commitments.length,
    payloadOptions,
    availablePayloads,
    activePayloads,
    deployedTorpedoes,
    deployedCraft,
    deployedCount: deployed.length,
    readyTorpedoes,
    readyCraft,
    loadingTorpedoes,
    craftDestroyed,
    craftRecovering,
    craftPartialRecovery,
    deployedTorpedoCount: deployedTorpedoes.length,
    deployedCraftCount,
    maxFlights: maxFlightsVal,
    strikeCraftCapacity,
    torpedoCapacity,
    loadingPayloadCount: loadingCount,
    activePayloadCount: Object.keys(activePayloads).length,
    bosunSL,
    allocEfficiency,
    allocExpedience,
    slRemaining: Math.max(0, bosunSL - allocEfficiency - allocExpedience),
    craftPips,
    autoArmTimer,
    autoLoadTimer,
    hasTorpedoConfig: torpedoTemplates.length > 0,
    hasCraftConfig:   craftTemplates.length > 0,
    torpedoActorData,
    craftActorData,
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────────

/**
 * Find all friendly strike craft tokens within `rangeVU` of the parent ship.
 * Returns objects with tokenId, name, img, distance (VU), targetX, targetY.
 */
function _findNearbyCraft(shipActor, rangeVU = 3) {
  if (!canvas.scene) return [];
  const gridSize = canvas.grid.size;
  const shipTokens = shipActor.getActiveTokens();
  if (!shipTokens.length) return [];
  const shipToken = shipTokens[0];
  const shipCx = shipToken.center?.x ?? (shipToken.x + gridSize / 2);
  const shipCy = shipToken.center?.y ?? (shipToken.y + gridSize / 2);
  const maxDist = rangeVU * gridSize;

  const result = [];
  for (const td of canvas.scene.tokens) {
    if (!isStrikeCraft(td.actor)) continue;
    const parentId = td.actor?.system?.parentShipTokenId;
    if (!parentId || parentId !== shipToken.id) continue;
    const cx = (td.x ?? 0) + (td.width  ?? 1) * gridSize / 2;
    const cy = (td.y ?? 0) + (td.height ?? 1) * gridSize / 2;
    const dist = Math.sqrt((shipCx - cx) ** 2 + (shipCy - cy) ** 2);
    if (dist > maxDist) continue;
    result.push({
      tokenId:  td.id,
      name:     td.name,
      img:      td.texture?.src ?? td.actor?.img ?? "",
      distance: Math.round((dist / gridSize) * 10) / 10,
      targetX:  cx,
      targetY:  cy,
    });
  }
  return result;
}

/**
 * Prompt the Ordnance Master to select which nearby craft to recover.
 */
async function _promptCraftSelection(nearbyCraft) {
  if (!nearbyCraft.length) return null;
  const buttons = nearbyCraft.map(c => ({
    action: c.tokenId,
    label: c.name || "Strike Craft",
    icon: "fa-solid fa-plane-arrival",
  }));
  return new Promise(resolve => {
    const d = new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize("SHIPCOMBAT.Ordnance.SelectCraftTitle") },
      content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.SelectCraftPrompt")}</p>`,
      buttons,
      close: () => resolve(null),
      submit: result => resolve(result),
    });
    d.render(true);
  });
}

/**
 * Roll Ordnance Master SL  -  Athletics (Might) test, once per turn.
 * SL becomes a shared discount pool for crew costs this turn.
 */
async function _onRollOrdnanceMaster(event, target) {
  const sys = SystemAdapter.current.getShipData(this.actor);
  if (sys.resources?.ordnance?.bosunRolled) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.AlreadyRolled"));
    return;
  }

  const crewActor = await _resolveOrdnanceActor(this);
  if (!crewActor) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoCrewActor"));
    return;
  }

  const result = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.ordnance ?? "ordnance");
  if (!result) return;

  const sl = Math.max(0, result.SL ?? 0);
  emitToGM("updateResource", { roleId: "ordnance", key: "bosunSL", value: sl });
  emitToGM("updateResource", { roleId: "ordnance", key: "bosunRolled", value: true });
}

/**
 * Allocate Ordnance Master SL to Efficiency or Expedience track.
 * data-stat="efficiency" or "expedience"
 * data-delta="-1" or "+1"
 */
async function _onAllocOrdnanceSL(event, target) {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const stat = target.dataset.stat;
  const delta = Number(target.dataset.delta);

  if (Number.isNaN(delta) || !["efficiency", "expedience"].includes(stat)) return;

  const allocEfficiency = sys.resources?.ordnance?.allocEfficiency ?? 0;
  const allocExpedience = sys.resources?.ordnance?.allocExpedience ?? 0;
  let newEfficiency = allocEfficiency;
  let newExpedience = allocExpedience;
  if (stat === "efficiency") newEfficiency = Math.max(0, allocEfficiency + delta);
  else newExpedience = Math.max(0, allocExpedience + delta);

  if ((sys.crewSize ?? 6) <= 5) {
    // 5-man: Efficiency/Expedience draw from the shared Leadership pool
    const captain = sys.resources?.captain ?? {};
    if (!captain.leadershipRolled) return;
    const available = Math.max(0, (captain.leadershipSL ?? 0) - (captain.allocResolve ?? 0));
    if (newEfficiency + newExpedience > available) return;
  } else {
    // 6-man: dedicated bosun roll pool
    if (!sys.resources?.ordnance?.bosunRolled) return;
    const bosunSL = sys.resources?.ordnance?.bosunSL ?? 0;
    if (newEfficiency + newExpedience > bosunSL) return;
  }

  if (stat === "efficiency") {
    emitToGM("updateResource", { roleId: "ordnance", key: "allocEfficiency", value: newEfficiency });
  } else {
    emitToGM("updateResource", { roleId: "ordnance", key: "allocExpedience", value: newExpedience });
  }
}

/**
 * Commit crew to an Ordnance Master action.
 * data-action-id identifies which ORDNANCE_MASTER_ACTIONS entry.
 */
async function _onOrdnanceMasterAction(event, target) {
  const sys      = SystemAdapter.current.getShipData(this.actor);
  const actionId = target.dataset.actionId;
  const entry    = ORDNANCE_MASTER_ACTIONS[actionId];
  if (!entry) return;

  const manpower = _availableManpower(sys);
  const allocEfficiency = sys.resources?.ordnance?.allocEfficiency ?? 0;
  const allocExpedience = sys.resources?.ordnance?.allocExpedience ?? 0;
  const crewCost = _effectiveCrewCost(entry.crew, allocEfficiency);
  const duration = _effectiveDuration(entry.duration, allocExpedience);

  if (manpower < crewCost) {
    ui.notifications.warn(game.i18n.format("SHIPCOMBAT.Ordnance.InsufficientCrew", { need: crewCost, have: manpower }));
    return;
  }

  emitToGM("updateResource", { roleId: "ordnance", key: "manpower",    value: manpower - crewCost });
  emitToGM("updateResource", { roleId: "ordnance", key: "actionUsed", value: true });

  const commitments = [...(sys.resources?.ordnance?.commitments ?? [])];
  commitments.push({ action: actionId, crewCount: crewCost, turnsRemaining: duration, addedRound: sys.round ?? 0 });
  emitToGM("updateResource", { roleId: "ordnance", key: "commitments", value: commitments });


  // ── Side effects: some actions directly trigger ordnance spawning ──

  if (actionId === "launchTorpedo") {
    // Decrement armed torpedo counter
    const armed = sys.resources?.ordnance?.armedTorpedoes ?? 0;
    if (armed <= 0) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoArmedTorpedoes"));
      return;
    }

    // Pick template if multiple loaded
    const torpTemplates = _getActiveTemplates(sys).torpedoTemplates;
    if (!torpTemplates.length) return;
    const templateId = torpTemplates.length > 1
      ? await _promptTemplate(torpTemplates, game.i18n.localize("SHIPCOMBAT.Label.TorpedoActors"))
      : torpTemplates[0]?.id ?? null;
    if (torpTemplates.length > 1 && !templateId) return; // cancelled

    emitToGM("updateResource", { roleId: "ordnance", key: "armedTorpedoes", value: armed - 1 });

    const side = await _promptSide(sys.ordnanceLaunchSides?.torpedo);
    if (!side) return;
    const shipToken = this.actor.getActiveTokens()?.[0];
    const spawn = side === "bow" ? _computeBowSpawn(shipToken)
      : side === "stern" ? _computeSternSpawn(shipToken)
      : _computePerpendicularSpawn(shipToken, side);
    emitToGM("spawnOrdnance", {
      type: "torpedo",
      templateId,
      parentShipTokenId: shipToken?.id ?? "",
      ...spawn,
    });
  }

  if (actionId === "torpedoSalvo") {
    // Consumes 1 armed torpedo, spawns 2 tokens each at full salvo-size hull
    const armed = sys.resources?.ordnance?.armedTorpedoes ?? 0;
    if (armed <= 0) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoArmedTorpedoes"));
      return;
    }
    const torpTemplates = _getActiveTemplates(sys).torpedoTemplates;
    if (!torpTemplates.length) return;
    const templateId = torpTemplates.length > 1
      ? await _promptTemplate(torpTemplates, game.i18n.localize("SHIPCOMBAT.Label.TorpedoActors"))
      : torpTemplates[0]?.id ?? null;
    if (torpTemplates.length > 1 && !templateId) return;

    emitToGM("updateResource", { roleId: "ordnance", key: "armedTorpedoes", value: armed - 1 });

    const side = await _promptSide(sys.ordnanceLaunchSides?.torpedo);
    if (!side) return;
    const shipToken = this.actor.getActiveTokens()?.[0];
    const spawn1 = side === "bow" ? _computeBowSpawn(shipToken)
      : side === "stern" ? _computeSternSpawn(shipToken)
      : _computePerpendicularSpawn(shipToken, side);
    // Offset the second token slightly so they don't overlap
    const spawn2 = { ...spawn1, x: (spawn1.x ?? 0) + (canvas.grid?.size ?? 100) };
    emitToGM("spawnOrdnance", { type: "torpedo", templateId, parentShipTokenId: shipToken?.id ?? "", ...spawn1 });
    emitToGM("spawnOrdnance", { type: "torpedo", templateId, parentShipTokenId: shipToken?.id ?? "", ...spawn2 });
  }

  if (actionId === "emergencyLaunch") {
    // Spawns 1 torpedo with hull=1 (single warhead), bypasses armed status
    const torpTemplates = _getActiveTemplates(sys).torpedoTemplates;
    if (!torpTemplates.length) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoTorpedoConfig"));
      return;
    }
    const templateId = torpTemplates.length > 1
      ? await _promptTemplate(torpTemplates, game.i18n.localize("SHIPCOMBAT.Label.TorpedoActors"))
      : torpTemplates[0]?.id ?? null;
    if (torpTemplates.length > 1 && !templateId) return;

    const side = await _promptSide(sys.ordnanceLaunchSides?.torpedo);
    if (!side) return;
    const shipToken = this.actor.getActiveTokens()?.[0];
    const spawn = side === "bow" ? _computeBowSpawn(shipToken)
      : side === "stern" ? _computeSternSpawn(shipToken)
      : _computePerpendicularSpawn(shipToken, side);
    emitToGM("spawnOrdnance", {
      type: "torpedo",
      templateId,
      parentShipTokenId: shipToken?.id ?? "",
      forcedHull: 1,
      ...spawn,
    });
  }

  if (actionId === "launchCraft") {
    // Pick template if multiple loaded
    const craftTemplates = _getActiveTemplates(sys).craftTemplates;
    if (!craftTemplates.length) return;
    const armedCraftNow = sys.resources?.ordnance?.armedCraft ?? 0;
    if (armedCraftNow <= 0) return ui.notifications.warn("No craft armed for launch.");
    const templateId = craftTemplates.length > 1
      ? await _promptTemplate(craftTemplates, game.i18n.localize("SHIPCOMBAT.Label.StrikeCraftActors"))
      : craftTemplates[0]?.id ?? null;
    if (craftTemplates.length > 1 && !templateId) return; // cancelled

    const shipToken = this.actor.getActiveTokens()?.[0];
    const side = await _promptSide(sys.ordnanceLaunchSides?.strikeCraft);
    if (!side) return;
    const spawn = side === "bow" ? _computeBowSpawn(shipToken)
      : side === "stern" ? _computeSternSpawn(shipToken)
      : _computePerpendicularSpawn(shipToken, side);
    emitToGM("spawnOrdnance", {
      type: "strikeCraft",
      templateId,
      parentShipTokenId: shipToken?.id ?? "",
      ...spawn,
    });
    emitToGM("updateResource", { roleId: "ordnance", key: "armedCraft", value: armedCraftNow - 1 });
  }

  if (actionId === "loadPayload") {
    // No popup  -  commitment completes after duration, incrementing availablePayloads
    }

  if (actionId === "recallCraft") {
    // Find nearby craft within 3VU, show selection popup, then recover selected craft
    const nearbyCraft = _findNearbyCraft(this.actor, 3);
    if (!nearbyCraft.length) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoCraftInRange"));
      return;
    }

    // Build ship position for the arrow overlay
    const shipToken = this.actor.getActiveTokens()?.[0];
    const gs = canvas.grid.size;
    const shipPos = shipToken ? {
      x: shipToken.center?.x ?? (shipToken.x + (shipToken.document.width  ?? 1) * gs / 2),
      y: shipToken.center?.y ?? (shipToken.y + (shipToken.document.height ?? 1) * gs / 2),
    } : null;

    const popup = new RecoverCraftPopup({ nearbyCraft, shipPos });
    const selectedTokenId = await popup.show();
    if (!selectedTokenId) return;

    // Set recovering flag so deleteToken hook doesn't count as destroyed
    const tokenDoc = canvas.scene.tokens.get(selectedTokenId);
    if (tokenDoc?.actor) {
      await tokenDoc.actor.setFlag(MODULE_ID, "recovering", true);
    }

    // Remove token from canvas
    await canvas.scene.deleteEmbeddedDocuments("Token", [selectedTokenId]);

    // Increment recovering counter
    const recovering = sys.resources?.ordnance?.craftRecovering ?? 0;
    emitToGM("updateResource", { roleId: "ordnance", key: "craftRecovering", value: recovering + 1 });

  }
}

/**
 * Core Action  -  consumes the assigned Power Core for a powerful one-off effect.
 * No manpower cost; requires a core to be assigned.
 */
async function _onOrdnanceMasterCoreAction(event, target) {
  const sys      = SystemAdapter.current.getShipData(this.actor);
  const actionId = target.dataset.coreAction;

  const ordCoreCount = sys.resources?.ordnance?.coreCount ?? 0;
  const crewSizeLocal = sys.crewSize ?? 6;
  // In reduced-crew modes the ordnance role is absorbed by another station:
  //   crewSize = 5  → captain's core is consumed
  //   crewSize <= 4 → gunner's core is consumed
  let coreCount, coreRoleId;
  if (ordCoreCount > 0) {
    coreCount  = ordCoreCount;
    coreRoleId = "ordnance";
  } else if (crewSizeLocal === 5 && (sys.resources?.captain?.coreCount ?? 0) > 0) {
    coreCount  = sys.resources.captain.coreCount;
    coreRoleId = "captain";
  } else if (crewSizeLocal <= 4 && (sys.resources?.gunner?.coreCount ?? 0) > 0) {
    coreCount  = sys.resources.gunner.coreCount;
    coreRoleId = "gunner";
  } else {
    coreCount  = 0;
    coreRoleId = "ordnance";
  }
  if (coreCount <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.CoreActionUsed"));
    return;
  }
  const entry = ORDNANCE_MASTER_CORE_ACTIONS.find(a => a.id === actionId);
  if (!entry) return;

  // ── Combat Recovery Doctrine ──────────────────────────────────────────────
  if (actionId === "combatRecoveryDoctrine") {
    const craftDestroyed       = sys.resources?.ordnance?.craftDestroyed       ?? 0;
    const craftPartialRecovery = sys.resources?.ordnance?.craftPartialRecovery ?? 0;
    const craftRecovering      = sys.resources?.ordnance?.craftRecovering      ?? 0;

    // Build the set of available operations
    const options = [];
    if (craftDestroyed        > 0) options.push("destroyed");
    if (craftPartialRecovery  > 0) options.push("partial");
    // "recovering" is now the domain of recallCraft commitments, not CRD

    if (options.length === 0) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.CRDNothingToRecover"));
      return;
    }

    let choice;
    if (options.length === 1) {
      choice = options[0];
    } else {
      const buttons = [];
      if (options.includes("destroyed"))
        buttons.push({ action: "destroyed",  label: game.i18n.localize("SHIPCOMBAT.Ordnance.CRDDestroyedOption"),  icon: "fa-solid fa-person-walking-arrow-loop-left" });
      if (options.includes("partial"))
        buttons.push({ action: "partial",    label: game.i18n.localize("SHIPCOMBAT.Ordnance.CRDPartialOption"),    icon: "fa-solid fa-wrench" });
      buttons.push(  { action: "cancel",     label: game.i18n.localize("Cancel"),                            icon: "fa-solid fa-xmark"  });

      choice = await new Promise(resolve => {
        const d = new foundry.applications.api.DialogV2({
          window:  { title: game.i18n.localize("SHIPCOMBAT.Ordnance.CRDChooseTitle") },
          content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.CRDChoosePrompt")}</p>`,
          buttons,
          close:  () => resolve(null),
          submit: r  => resolve(r),
        });
        d.render(true);
      });
      if (!choice || choice === "cancel") return;
    }

    if (choice === "destroyed") {
      // First use on a destroyed craft: moves 1 airframe to partial repair
      emitToGM("updateResource", { roleId: "ordnance", key: "craftDestroyed",       value: craftDestroyed - 1 });
      emitToGM("updateResource", { roleId: "ordnance", key: "craftPartialRecovery", value: craftPartialRecovery + 1 });
    } else if (choice === "partial") {
      // Second use completes the repair  -  craft returns to empty bay slot (available for arming)
      emitToGM("updateResource", { roleId: "ordnance", key: "craftPartialRecovery", value: craftPartialRecovery - 1 });
    }
  }

  // ── Shock Loading Rotation ────────────────────────────────────────────────
  if (actionId === "shockLoadingRotation") {
    const commitments = [...(sys.resources?.ordnance?.commitments ?? [])];
    if (commitments.length === 0) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.SLRNoCommitments"));
      return;
    }

    const buttons = commitments.map((c, i) => {
      const coreId = c.action.startsWith("core:") ? c.action.slice(5) : null;
      const label  = coreId
        ? game.i18n.format("SHIPCOMBAT.Ordnance.CoreFatigueLabel", { action: game.i18n.localize(ORDNANCE_MASTER_CORE_ACTIONS.find(a => a.id === coreId)?.label ?? coreId) })
        : game.i18n.localize(ORDNANCE_MASTER_ACTIONS[c.action]?.label ?? c.action);
      const icon   = coreId ? "fa-solid fa-bolt" : (ORDNANCE_MASTER_ACTIONS[c.action]?.icon ?? "fa-solid fa-users");
      return { action: String(i), label: `${label} (${c.turnsRemaining}t)`, icon };
    });
    buttons.push({ action: "cancel", label: game.i18n.localize("Cancel"), icon: "fa-solid fa-xmark" });

    const result = await new Promise(resolve => {
      const d = new foundry.applications.api.DialogV2({
        window:  { title: game.i18n.localize("SHIPCOMBAT.Ordnance.SLRTitle") },
        content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.SLRPrompt")}</p>`,
        buttons,
        close:  () => resolve(null),
        submit: r  => resolve(r),
      });
      d.render(true);
    });
    if (result === null || result === "cancel") return;

    const idx = Number(result);
    if (Number.isNaN(idx) || idx < 0 || idx >= commitments.length) return;

    const removed = commitments.splice(idx, 1)[0];
    const manpower = sys.resources?.ordnance?.manpower ?? 0;

    // Return crew and clear commitment
    emitToGM("updateResource", { roleId: "ordnance", key: "commitments", value: commitments });
    emitToGM("updateResource", { roleId: "ordnance", key: "manpower",    value: manpower + (removed.crewCount ?? 0) });

    // Apply completion side-effect immediately (mirrors advanceRound logic)
    switch (removed.action) {
      case "armTorpedo": {
        const armed = sys.resources?.ordnance?.armedTorpedoes ?? 0;
        emitToGM("updateResource", { roleId: "ordnance", key: "armedTorpedoes", value: armed + 1 });
        break;
      }
      case "armCraft": {
        const armed = sys.resources?.ordnance?.armedCraft ?? 0;
        emitToGM("updateResource", { roleId: "ordnance", key: "armedCraft", value: armed + 1 });
        break;
      }
      case "loadPayload": {
        const avail = sys.resources?.ordnance?.availablePayloads ?? 0;
        emitToGM("updateResource", { roleId: "ordnance", key: "availablePayloads", value: avail + 1 });
        break;
      }
      case "damageControl": {
        const fire = sys.internalFire ?? 0;
        if (fire > 0) emitToGM("updateResource", { roleId: "internalFire", key: "", value: Math.max(0, fire - 1) });
        break;
      }
      case "hullRepairParty": {
        const hullDmg = SystemAdapter.current.getShipData(this.actor)?.hull?.value ?? 0;
        if (hullDmg > 0) emitToGM("updateResource", { roleId: "hull", key: "value", value: Math.max(0, hullDmg - 2) });
        break;
      }
      case "loadAmmo": {
        const gunAmmo  = sys.resources?.gunner?.ammo ?? 0;
        const weapBay  = this.actor.items.find(i => i.system?.slot === "weaponsBay");
        const ammoCap  = weapBay?.system?.bayAmmoCapacity ?? 0;
        emitToGM("updateResource", { roleId: "gunner", key: "ammo", value: Math.min(ammoCap, gunAmmo + Math.ceil(ammoCap * 0.2)) });
        break;
      }
      // core-type fatigue and others: no extra side effect
    }
  }

  // ── Magazine Crossfeed ────────────────────────────────────────────────────
  if (actionId === "magazineCrossfeed") {
    const ammo = sys.resources?.gunner?.ammo ?? 0;
    if (ammo < 4) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.MCFInsufficientAmmo"));
      return;
    }

    const buttons = [];
    if (ammo >= 6) {
      buttons.push({ action: "torpedo", label: game.i18n.localize("SHIPCOMBAT.Ordnance.MCFTorpedoOption"), icon: "fa-solid fa-rocket" });
    }
    buttons.push({ action: "payload", label: game.i18n.localize("SHIPCOMBAT.Ordnance.MCFPayloadOption"), icon: "fa-solid fa-box" });
    buttons.push({ action: "cancel",  label: game.i18n.localize("Cancel"), icon: "fa-solid fa-xmark" });

    const choice = await new Promise(resolve => {
      const d = new foundry.applications.api.DialogV2({
        window:  { title: game.i18n.localize("SHIPCOMBAT.Ordnance.MCFTitle") },
        content: `<p>${game.i18n.format("SHIPCOMBAT.Ordnance.MCFPrompt", { ammo })}</p>`,
        buttons,
        close:  () => resolve(null),
        submit: r  => resolve(r),
      });
      d.render(true);
    });
    if (!choice || choice === "cancel") return;

    const armedTorpedoes    = sys.resources?.ordnance?.armedTorpedoes    ?? 0;
    const availablePayloads = sys.resources?.ordnance?.availablePayloads ?? 0;
    if (choice === "torpedo") {
      emitToGM("updateResource", { roleId: "gunner",   key: "ammo",              value: ammo - 6 });
      emitToGM("updateResource", { roleId: "ordnance", key: "armedTorpedoes",    value: armedTorpedoes + 1 });
    } else {
      emitToGM("updateResource", { roleId: "gunner",   key: "ammo",              value: ammo - 4 });
      emitToGM("updateResource", { roleId: "ordnance", key: "availablePayloads", value: availablePayloads + 1 });
    }
  }

  // ── Deck Conscription ─────────────────────────────────────────────────────
  if (actionId === "deckConsciption") {
    const manpower    = sys.resources?.ordnance?.manpower    ?? 0;
    const manpowerMax = sys.resources?.ordnance?.manpowerMax ?? 12;
    const bay = this.actor.items.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "weaponsBay");
    const componentManpower = bay?.system?.bayManpower ?? manpowerMax;
    const hasPermanentLoss  = manpowerMax < componentManpower;

    if (hasPermanentLoss) {
      const choice = await new Promise(resolve => {
        const d = new foundry.applications.api.DialogV2({
          window:  { title: game.i18n.localize("SHIPCOMBAT.Ordnance.DCTitle") },
          content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.DCPrompt")}</p>`,
          buttons: [
            { action: "temp",    label: game.i18n.localize("SHIPCOMBAT.Ordnance.DCTempOption"),    icon: "fa-solid fa-people-group" },
            { action: "recover", label: game.i18n.localize("SHIPCOMBAT.Ordnance.DCRecoverOption"), icon: "fa-solid fa-heart-pulse"  },
            { action: "cancel",  label: game.i18n.localize("Cancel"), icon: "fa-solid fa-xmark" },
          ],
          close:  () => resolve(null),
          submit: r  => resolve(r),
        });
        d.render(true);
      });
      if (!choice || choice === "cancel") return;

      if (choice === "recover") {
        // Restore 10% of permanently lost crew (min 1), capped at original component capacity
        const permanentLoss = componentManpower - manpowerMax;
        const restore = Math.max(1, Math.ceil(permanentLoss * 0.10));
        const newMax = Math.min(componentManpower, manpowerMax + restore);
        emitToGM("updateResource", { roleId: "ordnance", key: "manpowerMax", value: newMax });
        emitToGM("updateResource", { roleId: "ordnance", key: "manpower",    value: manpower + restore });
      } else {
        // Temp gain: 25% of current manpower cap
        const tempGain = Math.max(1, Math.ceil(manpowerMax * 0.25));
        emitToGM("updateResource", { roleId: "ordnance", key: "manpower", value: manpower + tempGain });
      }
    } else {
      // No permanent loss  -  temp bonus: 25% of manpower cap
      const tempGain = Math.max(1, Math.ceil(manpowerMax * 0.25));
      emitToGM("updateResource", { roleId: "ordnance", key: "manpower", value: manpower + tempGain });
    }
  }

  // ── Rapid Rearm ───────────────────────────────────────────────────────────
  if (actionId === "rapidRearm") {
    const torpedoTemplates = _getActiveTemplates(sys).torpedoTemplates;
    if (!torpedoTemplates.length) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoTorpedoConfig"));
      return;
    }
    const crewSize = sys.crewSize ?? 6;

    // Always: immediately arm 1 torpedo and reset the auto-arm cycle
    const armedTorpedoes = sys.resources?.ordnance?.armedTorpedoes ?? 0;
    emitToGM("updateResource", { roleId: "ordnance", key: "armedTorpedoes", value: armedTorpedoes + 1 });
    emitToGM("updateResource", { roleId: "ordnance", key: "autoArmTimer",   value: 3 });

    if (crewSize >= 6) {
      // Full crew: also trigger auto-load (1 free payload)
      const availablePayloads = sys.resources?.ordnance?.availablePayloads ?? 0;
      emitToGM("updateResource", { roleId: "ordnance", key: "availablePayloads", value: availablePayloads + 1 });
      emitToGM("updateResource", { roleId: "ordnance", key: "autoLoadTimer",     value: 2 });
    } else {
      // Smaller crew: grant AP equal to half the reactor's AP-per-core value
      const reactorComp = this.actor.items?.find(i => i.type === `${MODULE_ID}.component` && i.system?.slot === "reactor" && i.system?.equipped !== false);
      const reserveMultiplier = reactorComp?.system?.reserveMultiplier ?? 0;
      const apGain = Math.floor(reserveMultiplier / 2);
      if (apGain > 0) {
        const auxCap  = reactorComp?.system?.bankCapacity ?? 0;
        const currentAP = sys.resources?.engineer?.auxiliaryPower ?? 0;
        emitToGM("updateResource", { roleId: "engineer", key: "auxiliaryPower", value: Math.min(auxCap, currentAP + apGain) });
      }
    }
  }

  // ── Finalize  -  record played action and consume core ──────────────────────
  const coreActionsPlayed = [...(sys.resources?.ordnance?.coreActionsPlayed ?? []), actionId];
  emitToGM("updateResource", { roleId: "ordnance", key: "coreActionsPlayed", value: coreActionsPlayed });
  emitToGM("markOvercharge", { roleId: coreRoleId });
}

/**
 * Apply immediate resource changes for certain payload types.
 * Flag-based payloads (apShells, scatterShot, chaffPods, sensorBuoy,
 * lockStabilizer, reinforcedBulkheads) only need the flag set on the role
 * and are checked at usage time. Immediate-effect payloads modify resources.
 */
function _applyImmediatePayloadEffect(sys, payloadId, { heatCapacity = 0 } = {}) {
  switch (payloadId) {
    case "emergencyCoolant": {
      const heat = sys.resources?.engineer?.heat ?? 0;
      const reduction = Math.max(1, Math.ceil(heatCapacity * 0.2));
      emitToGM("updateResource", { roleId: "engineer", key: "heat", value: Math.max(0, heat - reduction) });
      break;
    }
    case "auxCapacitors": {
      const powerCores = sys.resources?.engineer?.powerCores ?? 0;
      emitToGM("updateResource", { roleId: "engineer", key: "powerCores", value: powerCores + 1 });
      break;
    }
    case "cogitatorDataSlate":
    case "fireSuppression": {
      emitToGM("captainPayloadActivate", { payloadId });
      break;
    }
    // fuelCatalyst: +2 speed bonus is passive (checked in buildHelmContext)
    // apShells, scatterShot, chaffPods, sensorBuoy, lockStabilizer, reinforcedBulkheads: flag-based
    default:
      break;
  }
}

/**
 * Send Payload  -  immediately deliver an available payload to a role.
 * Decrements availablePayloads counter.
 */
async function _onSendPayload(event, target) {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const payloadId = target.dataset.payloadId;
  const pDef = PAYLOAD_TYPES[payloadId];
  if (!pDef) return;

  const available = sys.resources?.ordnance?.availablePayloads ?? 0;
  if (available <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoPayloadsAvailable"));
    return;
  }

  // Check if role already has an active payload
  const rolePayload = sys.resources?.[pDef.targetRole]?.payload ?? "";
  if (rolePayload) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.RoleHasPayload"));
    return;
  }

  // Immediately deliver payload and decrement counter
  emitToGM("updateResource", { roleId: pDef.targetRole, key: "payload", value: pDef.id });
  emitToGM("updateResource", { roleId: "ordnance", key: "availablePayloads", value: available - 1 });

  // Apply immediate resource effects
  const reactorComp = this.actor.items?.find(i => i.type === `${MODULE_ID}.component` && i.system?.slot === "reactor" && i.system?.equipped !== false);
  const heatCapacity = reactorComp?.system?.heatCapacity ?? 0;
  _applyImmediatePayloadEffect(sys, pDef.id, { heatCapacity });

}

/**
 * Prompt the Ordnance Master to choose port or starboard for torpedo launch.
 * Returns "port" | "starboard" | null (if cancelled).
 */
async function _promptSide(allowedSides) {
  // Build allowed list: allowedSides is an object { bow, port, starboard, stern }
  // Default to all true if not provided.
  const ALL_SIDES = [
    { key: "port",      label: game.i18n.localize("SHIPCOMBAT.Sector.Port"),      icon: "fa-solid fa-arrow-left" },
    { key: "bow",       label: game.i18n.localize("SHIPCOMBAT.Sector.Bow"),        icon: "fa-solid fa-arrow-up" },
    { key: "starboard", label: game.i18n.localize("SHIPCOMBAT.Sector.Starboard"), icon: "fa-solid fa-arrow-right" },
    { key: "stern",     label: game.i18n.localize("SHIPCOMBAT.Sector.Stern"),      icon: "fa-solid fa-arrow-down" },
  ];

  let filtered;
  if (!allowedSides) {
    // Legacy fallback — show all original three
    filtered = ALL_SIDES.filter(s => s.key !== "stern");
  } else {
    filtered = ALL_SIDES.filter(s => allowedSides[s.key] === true);
  }

  if (filtered.length === 0) {
    ui.notifications.error(game.i18n.localize("SHIPCOMBAT.Ordnance.NoLaunchSides"));
    return null;
  }

  // If only one direction enabled, skip the dialog and return it directly
  if (filtered.length === 1) return filtered[0].key;

  return new Promise(resolve => {
    const d = new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize("SHIPCOMBAT.Ordnance.ChooseSide") },
      content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.ChooseSideDesc")}</p>`,
      buttons: filtered.map(s => ({ action: s.key, label: s.label, icon: s.icon })),
      close: () => resolve(null),
      submit: result => resolve(result),
    });
    d.render(true);
  });
}

/**
 * Prompt the user to select an ordnance template when multiple are loaded.
 * Returns the selected template's ID, or null if cancelled.
 */
async function _promptTemplate(templates, title) {
  if (!templates.length) return null;
  if (templates.length === 1) return templates[0].id;

  return new Promise(resolve => {
    const buttons = templates.map(t => ({
      action: t.id,
      label: t.name || "Unknown",
      icon: "fa-solid fa-crosshairs",
    }));

    const d = new foundry.applications.api.DialogV2({
      window: { title: title || game.i18n.localize("SHIPCOMBAT.Ordnance.SelectTemplate") },
      content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.SelectTemplateDesc")}</p>`,
      buttons,
      close: () => resolve(null),
      submit: result => resolve(result),
    });
    d.render(true);
  });
}

/**
 * Compute a spawn position on the port or starboard side, perpendicular to the ship.
 * Foundry rotation: 0° = facing up (north), degrees increase clockwise.
 * "Forward" direction = -rotation (converting to math angle where 0° = right, CCW positive).
 */
function _computePerpendicularSpawn(token, side) {
  if (!token) return { x: 0, y: 0, rotation: 0 };

  const grid = canvas.grid?.size ?? 100;
  const offset = grid * 1.5; // distance from ship center to spawn
  const shipRotDeg = token.document?.rotation ?? 0;

  // Foundry rotation: 0 = north (up-screen), CW positive.
  // Convert to math radians: north = -π/2 in math coords.
  const headingRad = (shipRotDeg - 90) * (Math.PI / 180);

  // Perpendicular: port = left of heading, starboard = right of heading
  const perpRad = side === "port"
    ? headingRad - Math.PI / 2
    : headingRad + Math.PI / 2;

  const cx = token.center?.x ?? (token.x + grid / 2);
  const cy = token.center?.y ?? (token.y + grid / 2);

  return {
    x: Math.round(cx + Math.cos(perpRad) * offset - grid / 2),
    y: Math.round(cy + Math.sin(perpRad) * offset - grid / 2),
    rotation: shipRotDeg + (side === "port" ? -90 : 90), // facing outward perpendicular
  };
}

/**
 * Compute a spawn position at the stern of the ship, facing backward.
 */
function _computeSternSpawn(token) {
  if (!token) return { x: 0, y: 0, rotation: 0 };

  const grid = canvas.grid?.size ?? 100;
  const offset = grid * 1.5;
  const shipRotDeg = token.document?.rotation ?? 0;

  // Stern = opposite of heading (180° behind)
  const headingRad = (shipRotDeg - 90) * (Math.PI / 180);
  const sternRad = headingRad + Math.PI;

  const cx = token.center?.x ?? (token.x + grid / 2);
  const cy = token.center?.y ?? (token.y + grid / 2);

  return {
    x: Math.round(cx + Math.cos(sternRad) * offset - grid / 2),
    y: Math.round(cy + Math.sin(sternRad) * offset - grid / 2),
    rotation: (shipRotDeg + 180) % 360, // facing backward
  };
}

/**
 * Compute a spawn position at the bow of the ship, facing forward.
 */
function _computeBowSpawn(token) {
  if (!token) return { x: 0, y: 0, rotation: 0 };

  const grid = canvas.grid?.size ?? 100;
  const offset = grid * 1.5;
  const shipRotDeg = token.document?.rotation ?? 0;

  // Bow = forward heading
  const headingRad = (shipRotDeg - 90) * (Math.PI / 180);

  const cx = token.center?.x ?? (token.x + grid / 2);
  const cy = token.center?.y ?? (token.y + grid / 2);

  return {
    x: Math.round(cx + Math.cos(headingRad) * offset - grid * 0.25),
    y: Math.round(cy + Math.sin(headingRad) * offset - grid * 0.25),
    rotation: shipRotDeg, // facing same direction as ship
  };
}

/**
 * Recall  -  order a deployed craft to RTB. Commits recallCraft crew via ordnanceMasterAction.
 */
async function _onRecall(event, target) {
  const tokenId = target.dataset.tokenId;
  if (!tokenId) return;

  emitToGM("setOrdnanceRtb", { tokenId, rtb: true });
}

/**
 * Discard an active payload from a receiving role's slot.
 */
async function _onDiscardPayload(event, target) {
  const roleId = target.dataset.roleId;
  if (!roleId) return;

  emitToGM("updateResource", { roleId, key: "payload", value: "" });
}

/**
 * Pan camera to a deployed ordnance token and open its sheet.
 */
async function _onPanToOrdnance(event, target) {
  const tokenId = target.dataset.tokenId;
  if (!tokenId || !canvas.scene) return;
  const token = canvas.tokens.get(tokenId);
  if (!token) return;

  canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
  token.actor?.sheet?.render(true);
}

/**
 * Mark a deployed ordnance token's turn as complete.
 */
async function _onMarkOrdnanceDone(event, target) {
  const tokenId = target.dataset.tokenId;
  if (!tokenId || !canvas.scene) return;
  const token = canvas.tokens.get(tokenId);
  if (!token?.actor) return;

  const done = !SystemAdapter.current.getShipData(token.actor).turnComplete;
  emitToGM("setOrdnanceTurnDone", { tokenId, done });

  // Optimistically update the DOM; the ship sheet does not auto-re-render
  // when a foreign (ordnance) actor is updated via socket.
  // AppV1 exposes this.element as a jQuery object; normalise to a raw DOM element.
  const _root = this.element instanceof jQuery ? this.element[0] : this.element;
  const row = _root?.querySelector(`.shipcombat-deployed-row[data-token-id="${tokenId}"]`);
  if (row) {
    row.classList.toggle("shipcombat-deployed--done", done);
    target.classList.toggle("active", done);
    const icon = target.querySelector("i");
    if (icon) {
      icon.className = done ? "fa-solid fa-circle-check" : "fa-regular fa-circle";
    }
  }
}

/**
 * Cancel a crew commitment and refund its manpower.
 * Only commitments added this round (isNew) can be cancelled.
 * data-index = commitment array index
 */
async function _onCancelCommitment(event, target) {
  const sys   = SystemAdapter.current.getShipData(this.actor);
  const index = Number(target.dataset.index);
  const commitments = [...(sys.resources?.ordnance?.commitments ?? [])];
  if (index < 0 || index >= commitments.length) return;
  const c = commitments[index];
  const currentRound = sys.round ?? 0;
  if (c.addedRound !== currentRound) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.CannotCancelOldCommitment"));
    return;
  }
  // Prevent canceling actions that gave their benefit immediately on assignment
  if (ORDNANCE_MASTER_ACTIONS[c.action]?.noCancel) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.CannotCancelImmediateAction"));
    return;
  }
  commitments.splice(index, 1);
  const manpower = sys.resources?.ordnance?.manpower ?? 0;
  emitToGM("updateResource", { roleId: "ordnance", key: "commitments", value: commitments });
  emitToGM("updateResource", { roleId: "ordnance", key: "manpower", value: manpower + (c.crewCount ?? 0) });
}

// ── Exports ──────────────────────────────────────────────────────────────────

function _openReadOnlySheet(actor) {
  const sheet = actor.sheet;
  if (!sheet) return;
  // Force read-only  -  this is a template preview, not a live deployable actor
  Object.defineProperty(sheet, "isEditable", { get: () => false, configurable: true });
  sheet.render(true);
}

async function _onViewOrdnanceActor(event, target) {
  const uuid    = target?.dataset?.uuid;
  const actorId = target?.dataset?.actorId;

  // Prefer inline actorData so we can apply the bay hull override for correct preview values.
  if (actorId && this.actor) {
    const allRefs = [
      ...(SystemAdapter.current.getShipData(this.actor).ordnanceActors?.torpedo     ?? []),
      ...(SystemAdapter.current.getShipData(this.actor).ordnanceActors?.strikeCraft ?? []),
    ];
    const ref = allRefs.find(r => r.id === actorId);
    if (ref?.actorData) {
      const actorData = foundry.utils.deepClone(ref.actorData);

      // Apply the same hull override that ordnance-state uses at spawn time:
      // torpedo hull = bayTorpedoSalvoSize, strike craft hull = bayStrikeCraftFlightSize
      const bay = this.actor.items?.find(
        i => i.type === `${MODULE_ID}.component` && i.system?.slot === "weaponsBay"
      );
      const actorSubtype = ordnanceSubtype({ type: actorData.type, system: actorData.system }) ?? actorData.type;
      const isHP = SystemAdapter.current.hullDisplayMode === "hpRemaining";
      if (actorSubtype === "torpedo") {
        const hullOverride = bay?.system?.bayTorpedoSalvoSize ?? 1;
        actorData.system.hull = { value: isHP ? hullOverride : 0, max: hullOverride };
      } else if (actorSubtype === "strikeCraft") {
        const hullOverride = bay?.system?.bayStrikeCraftFlightSize ?? 1;
        actorData.system.hull = { value: isHP ? hullOverride : 0, max: hullOverride };
      }

      const tempActor = new CONFIG.Actor.documentClass(actorData);
      // Unembedded temp actors lack a live effects collection  -  stub out
      // condition methods so the impmal sheet's formatConditions() doesn't throw.
      tempActor.hasCondition    = () => false;
      tempActor.addCondition    = async () => {};
      tempActor.removeCondition = async () => {};
      _openReadOnlySheet(tempActor);
      return;
    }
  }

  // Fallback: open world actor or compendium entry directly via UUID
  if (uuid) {
    try {
      const actor = await fromUuid(uuid);
      if (actor) { _openReadOnlySheet(actor); return; }
    } catch { /* fall through */ }
  }
}

export const ORDNANCE_ACTIONS = {
  rollOrdnanceMaster:        _onRollOrdnanceMaster,
  allocOrdnanceSL:           _onAllocOrdnanceSL,
  ordnanceMasterAction:      _onOrdnanceMasterAction,
  ordnanceMasterCoreAction:  _onOrdnanceMasterCoreAction,
  cancelCommitment:          _onCancelCommitment,
  sendPayload:         _onSendPayload,
  recallOrdnance:      _onRecall,
  discardPayload:      _onDiscardPayload,
  panToOrdnance:       _onPanToOrdnance,
  markOrdnanceDone:    _onMarkOrdnanceDone,
  viewOrdnanceActor:   _onViewOrdnanceActor,
};
