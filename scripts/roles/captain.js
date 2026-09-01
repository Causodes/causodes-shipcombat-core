/**
 * Captain role  -  ship commander.
 *
 * Responsibilities:
 *   - Ship condition visibility + triage (step-down per location)
 *   - Card hand management (play and Resolve-funded slot mulligans)
 *   - Stance tracking (set via Gambit cards)
 */

import { CAPTAIN_CARDS, CAPTAIN_CORE_ACTIONS, CRIT_CONDITIONS, ROLES } from "../constants.js";
import { emitToGM }                               from "../socket.js";
import { SystemAdapter }                          from "../systems/SystemAdapter.js";
import { BattleClarityPopup }                     from "../apps/BattleClarityPopup.js";
import { DeadReckoningPopup }                     from "../apps/DeadReckoningPopup.js";
import { EmergencySalvagePopup }                  from "../apps/EmergencySalvagePopup.js";
import { getPowerCoreCount, resolveStationOperatorActor } from "./crew-operators.js";
import { normalizeCaptainZone, projectCaptainHandCount } from "../captain/card-instances.js";

// Card definition lookup map (built once)
const CARD_DEFS = Object.fromEntries(CAPTAIN_CARDS.map(c => [c.id, c]));

const CRIT_LOCATIONS_ORDERED = ["hull", "engines", "manoeuvring", "coreSystems", "weaponsSensors"];
const TIER_ORDER = ["low", "medium", "high"];

const BASE_HAND_CAP = 3;
const BASE_MULLIGANS_PER_ROUND = 1;

function _buildShieldSectors(sys, opts) {
  const ztMap = opts.shieldStats?.zoneThresholds ?? { bow: 0, stern: 0, port: 0, starboard: 0 };
  const _sector = (id) => {
    const val = sys.shields?.[id] ?? 0;
    const zt  = ztMap[id] || 1;
    return { val, pct: +(Math.min(1, val / zt).toFixed(3)), over: val > zt };
  };
  return {
    bow:       _sector("bow"),
    starboard: _sector("starboard"),
    stern:     _sector("stern"),
    port:      _sector("port"),
  };
}

function _resolvePileCards(pile, zoneKey) {
  return normalizeCaptainZone(pile, zoneKey)
    .map(card => {
      const def = CARD_DEFS[card.cardId];
      if (!def) return null;
      return {
        ...card,
        id:       card.cardId,
        label:    game.i18n.localize(`SHIPCOMBAT.Captain.Card.${card.cardId}`),
        desc:     game.i18n.localize(`SHIPCOMBAT.Captain.Card.Desc.${card.cardId}`),
        catLabel: game.i18n.localize(`SHIPCOMBAT.Captain.Category.${def.category}`),
        category: def.category,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Context builder ──────────────────────────────────────────────────────────

export function buildCaptainContext(sys, opts = {}) {
  const captain = sys.resources?.captain ?? {};
  const stance  = captain.stance       ?? "none";
  const pending = captain.pendingStance ?? "";

  // ── Conditions panel ──────────────────────────────────────────────────────
  const triageCount = captain.triageCount ?? 2;
  const triageUsed  = captain.triageConditionsUsed ?? [];

  const conditionsList = CRIT_LOCATIONS_ORDERED.map(locId => {
    const cond    = sys.conditions?.[locId] ?? {};
    const tier    = cond.tier ?? null;
    const condDef = CRIT_CONDITIONS[locId];
    const tierIdx = tier ? TIER_ORDER.indexOf(tier) : -1;

    return {
      locId,
      tier,
      tierIdx,
      hasCondition:     !!tier,
      locLabel:         game.i18n.localize(`SHIPCOMBAT.Crit.Location.${locId}`),
      conditionName:    tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Condition.${locId}.${tier}`) : "",
      conditionEffect:  tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Effect.${locId}.${tier}`) : "",
      tierLabel:        tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Tier.${tier.charAt(0).toUpperCase() + tier.slice(1)}`) : "",
      triageName:       game.i18n.localize(`SHIPCOMBAT.Crit.Triage.${locId}`),
      // Icons per tier for badge CSS
      tierClass:        tier ? `shipcombat-crit-tier--${tier}` : "",
      // Whether the captain can triage this location this round
      canTriage:        !!tier && triageCount > 0,
    };
  });

  const activeConditions = conditionsList.filter(c => c.hasCondition);

  // ── Card hand ─────────────────────────────────────────────────────────────
  const hand = normalizeCaptainZone(captain.hand, "hand").map(card => {
    const cardId = card.cardId;
    const def = CARD_DEFS[cardId] ?? { id: cardId, category: "unknown" };
    return {
      cardId,
      instanceId:      card.instanceId,
      salvaged:        card.salvaged,
      label:           game.i18n.localize(`SHIPCOMBAT.Captain.Card.${cardId}`),
      desc:            game.i18n.localize(`SHIPCOMBAT.Captain.Card.Desc.${cardId}`),
      category:        def.category,
      catLabel:        game.i18n.localize(`SHIPCOMBAT.Captain.Category.${def.category}`),
      targetRole:      def.targetRole ?? null,
      targetRoleLabel: def.targetRole ? (sys.roleTitles?.[def.targetRole] || game.i18n.localize(ROLES[def.targetRole]?.label ?? "")) : null,
      targetRoleIcon:  def.targetRole ? (ROLES[def.targetRole]?.icon ?? null) : null,
      setsStance:      def.setsStance ?? null,
      icon:            _cardIcon(def.category),
    };
  });

  const drawPileCount    = (captain.drawPile    ?? []).length;
  const discardPileCount = (captain.discardPile ?? []).length;
  const handCount        = hand.length;
  const effectiveHandCap = (captain.currentHandCap ?? BASE_HAND_CAP) + (captain.handCapBonus ?? 0);
  const nextHandCap      = BASE_HAND_CAP + (captain.allocInspire ?? 0);
  const nextHandCount    = projectCaptainHandCount({
    hand: captain.hand,
    drawPile: captain.drawPile,
    discardPile: captain.discardPile,
    nextHandCap,
  });
  const mulligansRemaining = Math.max(0, BASE_MULLIGANS_PER_ROUND + (captain.allocResolve ?? 0) - (captain.mulligansSpent ?? 0));
  const allocationLocked = !!captain.allocationLocked;
  const drawPileCards    = _resolvePileCards(captain.drawPile, "draw");
  const discardPileCards = _resolvePileCards(captain.discardPile, "discard");
  const coreActionUsed    = captain.coreActionUsed ?? false;
  const hasCoreAssigned   = getPowerCoreCount(sys, "captain") > 0;
  const selectedCoreActionLabel = (coreActionUsed && captain.selectedCoreAction)
    ? game.i18n.localize(CAPTAIN_CORE_ACTIONS.find(a => a.id === captain.selectedCoreAction)?.label ?? "")
    : "";

  // ── Core actions ────────────────────────────────────────────────────────
  const discardPile = captain.discardPile ?? [];
  const coreActions = CAPTAIN_CORE_ACTIONS.map(a => {
    let criteriaMet = true;
    if (a.id === "emergencyProtocols") {
      // Requires at least one Low-tier condition to exist
      criteriaMet = activeConditions.some(c => c.tier === "low");
    }
    if (a.id === "ironCommand") {
      // Only usable if at least one High or Medium condition exists
      criteriaMet = activeConditions.some(c => c.tier === "high" || c.tier === "medium");
    }
    if (a.id === "battleClarity") {
      criteriaMet = true; // always available if core present
    }
    if (a.id === "emergencySalvage") {
      criteriaMet = discardPile.length > 0;
    }
    if (a.id === "commandOverride") {
      criteriaMet = !!pending;  // must have a pending stance queued
    }
    if (a.id === "deadReckoning") {
      criteriaMet = (captain.drawPile ?? []).length > 0;
    }
    return {
      ...a,
      labelLocalized: game.i18n.localize(a.label),
      descLocalized:  game.i18n.localize(a.desc),
      canAfford: hasCoreAssigned && criteriaMet,
    };
  });

  // ── Stance display ────────────────────────────────────────────────────────
  const stanceLabel   = game.i18n.localize(`SHIPCOMBAT.Captain.Stance.${stance}`);
  const pendingLabel  = pending ? game.i18n.localize(`SHIPCOMBAT.Captain.Stance.${pending}`) : "";
  const stanceDesc = (stance !== "none") ? game.i18n.localize(`SHIPCOMBAT.Captain.Stance.StanceDesc.${stance}`) : "";

  // Retained in sheet context for companion/custom templates even though the
  // core Captain tab no longer renders the redundant Active Orders panel.
  const playedCards = (captain.playedCards ?? []).map(cardId => {
    const def = CARD_DEFS[cardId] ?? { id: cardId, category: "unknown" };
    return {
      id: cardId,
      label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${cardId}`),
      category: def.category,
      catClass: `shipcombat-chip--${def.category}`,
    };
  });

  return {
    // Conditions
    conditionsList,
    activeConditions,
    hasAnyCondition:   activeConditions.length > 0,
    triageCount,
    triageUsed,
    triageMax:         2,
    // Cards
    hand,
    handCount,
    drawPileCount,
    discardPileCount,
    drawPileCards,
    discardPileCards,
    mulligansRemaining,
    effectiveHandCap,
    nextHandCap,
    nextHandCount,
    allocationLocked,
    handCapBonus:      captain.handCapBonus ?? 0,
    coreActionUsed,
    hasCoreAssigned,
    coreActions,
    selectedCoreActionLabel,
    // Stance
    stance,
    stanceLabel,
    stanceDesc,
    pendingStance:     pending,
    pendingLabel,
    hasPendingStance:  !!pending,
    // Leadership roll / alloc
    leadershipRolled:       captain.leadershipRolled  ?? false,
    hasRolledInitiative:    opts.hasRolledInitiative ?? false,
    leadershipSL:           captain.leadershipSL      ?? 0,
    allocInspire:           captain.allocInspire      ?? 0,
    allocResolve:           captain.allocResolve      ?? 0,
    allocInitiative:        captain.allocInitiative   ?? 0,
    remainingLeadershipSL:  (captain.leadershipSL ?? 0) - (captain.allocInspire ?? 0) - (captain.allocResolve ?? 0) - (captain.allocInitiative ?? 0)
      - ((sys.crewSize ?? 6) <= 5 ? ((sys.resources?.ordnance?.allocEfficiency ?? 0) + (sys.resources?.ordnance?.allocExpedience ?? 0)) : 0),
    allocLocked:            allocationLocked,
    playedCards,
    hasPlayedCards:         playedCards.length > 0,
    holdTheLineActive:      captain.holdTheLineActive ?? false,
    // Shield allocation (moved from Engineer)
    shields:        _buildShieldSectors(sys, opts),
    shieldPool:     sys.shieldPool ?? { current: 0, committed: 0 },
    // Auxiliary Power (read-only display)
    auxiliaryPower:    sys.resources?.engineer?.auxiliaryPower ?? 0,
    auxPowerCapacity:  opts.reactorStats?.auxPowerCapacity ?? 0,
    auxPowerPct:       (opts.reactorStats?.auxPowerCapacity ?? 0) > 0
      ? Math.round(((sys.resources?.engineer?.auxiliaryPower ?? 0) / (opts.reactorStats?.auxPowerCapacity ?? 0)) * 100)
      : 0,
  };
}

// Category icon helper
function _cardIcon(category) {
  switch (category) {
    case "boost":    return "fa-solid fa-arrow-up";
    case "shipwide": return "fa-solid fa-ship";
    case "reaction": return "fa-solid fa-shield";
    case "gambit":   return "fa-solid fa-chess-knight";
    default:         return "fa-solid fa-cards";
  }
}

// ── Action handlers (client-side  -  emit to GM via socket) ────────────────────

async function _onTriage(event, target) {
  const locId = target.dataset.locId;
  if (!locId) return;
  emitToGM("triageCondition", { locId, shipActorId: this.actor.id });
}

async function _onPlayCard(event, target) {
  const card = target.closest("[data-card-id]");
  const cardId = card?.dataset?.cardId;
  const cardInstanceId = card?.dataset?.cardInstanceId;
  if (!cardId) return;

  // Armour Repair: show sector selection dialog before emitting
  if (cardId === "repairArmour") {
    const sectors = ["bow", "stern", "port", "starboard"];
    const buttons = sectors.map(s => ({
      action: s,
      label:  game.i18n.localize(`SHIPCOMBAT.Sector.${s.charAt(0).toUpperCase() + s.slice(1)}`),
      icon:   "fa-solid fa-shield-halved",
    }));
    buttons.push({ action: "cancel", label: game.i18n.localize("Cancel"), icon: "fa-solid fa-xmark" });
    const sector = await new Promise(resolve => {
      const d = new foundry.applications.api.DialogV2({
        window:  { title: game.i18n.localize("SHIPCOMBAT.Captain.Core.RATitle") },
        content: `<p>${game.i18n.localize("SHIPCOMBAT.Captain.Core.RAPrompt")}</p>`,
        buttons,
        close:  () => resolve(null),
        submit: r  => resolve(r),
      });
      d.render(true);
    });
    if (!sector || sector === "cancel") return;
    emitToGM("playCard", { cardId, cardInstanceId, sector, shipActorId: this.actor.id });
    return;
  }

  emitToGM("playCard", { cardId, cardInstanceId, shipActorId: this.actor.id });
}

async function _onDiscardCard(event, target) {
  const card = target.closest("[data-card-id]");
  const cardId = card?.dataset?.cardId;
  const cardInstanceId = card?.dataset?.cardInstanceId;
  if (!cardId) return;
  emitToGM("discardCard", { cardId, cardInstanceId, shipActorId: this.actor.id });
}

async function _onMulligan(event, target) {
  const card = target.closest("[data-card-id]");
  const cardId = card?.dataset?.cardId;
  const cardInstanceId = card?.dataset?.cardInstanceId;
  if (!cardId) return;
  await emitToGM("mulligan", { cardId, cardInstanceId, shipActorId: this.actor.id });
}

/**
 * Roll Rapport (Leadership) once per turn → set leadership SL pool for Inspire/Resolve allocation.
 */
/** Roll the ship's initiative via the system adapter. */
async function _onRollInitiative() {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const crewActor = await resolveStationOperatorActor(this.actor, "captain");
  if (!crewActor) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoCaptainAssigned"));
    return;
  }

  const { total } = await SystemAdapter.current.rollShipInitiative(
    crewActor,
    sys.roleSkillOverrides?.captain ?? "leadership",
    {
    flavor:  game.i18n.localize("SHIPCOMBAT.Captain.RollInitiativeBtn"),
    speaker: ChatMessage.getSpeaker({ actor: crewActor }),
    },
  );

  await emitToGM("updateResource", { roleId: "captain", key: "initiativeTotal", value: total, shipActorId: this.actor.id });
}

/** Roll Presence (Leadership) to generate the SL pool for inspire/resolve/initiative allocation. */
async function _onRollLeadershipSL() {
  const sys = SystemAdapter.current.getShipData(this.actor);
  if (sys.resources?.captain?.leadershipRolled) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.CaptainLeadershipAlreadyRolled"));
    return;
  }

  const crewActor = await resolveStationOperatorActor(this.actor, "captain");
  if (!crewActor) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoCaptainAssigned"));
    return;
  }

  const result = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.captain ?? "leadership");
  if (!result) return;

  const sl = Math.max(0, result.SL);
  const updates = [
    { roleId: "captain", key: "leadershipSL", value: sl },
    { roleId: "captain", key: "leadershipRolled", value: true },
    { roleId: "captain", key: "allocInspire", value: 0 },
    { roleId: "captain", key: "allocResolve", value: 0 },
    { roleId: "captain", key: "allocInitiative", value: 0 },
  ];
  // In 5-man mode the Presence roll also seeds the ordnance SL pool (no separate Might roll).
  if ((sys.crewSize ?? 6) <= 5) {
    updates.push(
      { roleId: "ordnance", key: "bosunSL", value: sl },
      { roleId: "ordnance", key: "bosunRolled", value: true },
      { roleId: "ordnance", key: "allocEfficiency", value: 0 },
      { roleId: "ordnance", key: "allocExpedience", value: 0 },
    );
  }
  await emitToGM("updateResources", { shipActorId: this.actor.id, updates });
}

/**
 * Allocate leadership SL between Inspire (extra draws) and Resolve (extra triages).
 */
async function _onAllocLeadershipSL(event, target) {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const captain = sys.resources?.captain ?? {};
  if (captain.allocationLocked) return;
  if (!captain.leadershipRolled) return;

  const stat  = target.dataset.stat;   // "inspire" | "resolve" | "initiative"
  const delta = Number(target.dataset.delta);
  const allocInspire    = captain.allocInspire    ?? 0;
  const allocResolve    = captain.allocResolve    ?? 0;
  const allocInitiative = captain.allocInitiative ?? 0;
  const leadershipSL    = captain.leadershipSL    ?? 0;

  let newInspire    = allocInspire;
  let newResolve    = allocResolve;
  let newInitiative = allocInitiative;

  if (stat === "inspire") {
    newInspire = Math.max(0, allocInspire + delta);
  } else if (stat === "resolve") {
    newResolve = Math.max(0, allocResolve + delta);
  } else if (stat === "initiative") {
    newInitiative = Math.max(0, allocInitiative + delta);
  }

  if (newInspire + newResolve + newInitiative > leadershipSL) return;

  if (stat === "inspire")    await emitToGM("updateResource", { roleId: "captain", key: "allocInspire",    value: newInspire,    shipActorId: this.actor.id });
  if (stat === "resolve")    await emitToGM("updateResource", { roleId: "captain", key: "allocResolve",    value: newResolve,    shipActorId: this.actor.id });
  if (stat === "initiative") await emitToGM("updateResource", { roleId: "captain", key: "allocInitiative", value: newInitiative, shipActorId: this.actor.id });
}

// ── Core Action Handlers ─────────────────────────────────────────────────────

async function _onCaptainCoreAction(event, target) {
  const sys      = SystemAdapter.current.getShipData(this.actor);
  const actionId = target.dataset.coreAction;
  const captain  = sys.resources?.captain ?? {};

  const hasCoreAssigned = getPowerCoreCount(sys, "captain") > 0;
  if (!hasCoreAssigned) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Captain.Core.NoCoreAssigned"));
    return;
  }

  // ── Emergency Protocols: clear all Low-tier conditions; discard hand ──
  if (actionId === "emergencyProtocols") {
    const conditions  = sys.conditions ?? {};
    const hasLow = Object.values(conditions).some(c => c.tier === "low");
    if (!hasLow) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Captain.Core.EPNoConditions"));
      return;
    }
    emitToGM("captainCoreAction", { actionId, shipActorId: this.actor.id });
    return;
  }

  // ── Iron Command: step every Medium/High condition down 1 tier; discard hand ──
  if (actionId === "ironCommand") {
    const conditions = sys.conditions ?? {};
    const hasMediumOrHigh = Object.values(conditions).some(c => c.tier === "medium" || c.tier === "high");
    if (!hasMediumOrHigh) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Captain.Core.ICNoConditions"));
      return;
    }
    emitToGM("captainCoreAction", { actionId, shipActorId: this.actor.id });
    return;
  }

  // ── Priority Target: open target-picker popup (Lock 1+ only) ──
  if (actionId === "battleClarity") {
    const BattleClarityPopupClass = ShipCombat._popupClass("battleClarity", BattleClarityPopup);
    const popup = new BattleClarityPopupClass({ shipActor: this.actor });
    popup.render(true);
    return;
  }

  // ── Emergency Salvage: pick a card from the discard pile ──
  if (actionId === "emergencySalvage") {
    const discard = captain.discardPile ?? [];
    if (!discard.length) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Captain.Core.ESEmptyDiscard"));
      return;
    }
    new EmergencySalvagePopup({ cards: _resolvePileCards(discard, "discard"), shipActorId: this.actor.id }).render(true);
    return;
  }

  // ── Command Override: promote pendingStance immediately ──
  if (actionId === "commandOverride") {
    if (!captain.pendingStance) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Captain.Core.CONoPending"));
      return;
    }
    emitToGM("captainCoreAction", { actionId, shipActorId: this.actor.id });
    return;
  }

  // ── Dead Reckoning: reorder top 12 draw pile cards via a drag-and-drop popup ──
  if (actionId === "deadReckoning") {
    if (!(captain.drawPile ?? []).length) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Captain.Core.DREmptyPile"));
      return;
    }
    const reservation = await emitToGM("beginDeadReckoning", { shipActorId: this.actor.id });
    if (!reservation?.ok) {
      const warningKey = reservation?.reason === "emptyPile"
        ? "SHIPCOMBAT.Captain.Core.DREmptyPile"
        : "SHIPCOMBAT.Captain.Core.NoCoreAssigned";
      ui.notifications.warn(game.i18n.localize(warningKey));
      return;
    }
    const popup = new DeadReckoningPopup({
      cards: _resolvePileCards(reservation.cards, "dead-reckoning"),
      reservationId: reservation.reservationId,
      tailCount: reservation.tailCount,
      shipActorId: this.actor.id,
    });
    popup.render(true);
    return;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

async function _onFluxToCharge() {
  emitToGM("fluxToCharge", { shipActorId: this.actor.id });
}

async function _onCaptainReorderCard(event, target) {
  const card = target.closest("[data-card-instance-id]");
  if (!card) return;
  const cardInstanceId = card.dataset.cardInstanceId;
  const direction = target.dataset.direction;
  const captain   = SystemAdapter.current.getShipData(this.actor).resources?.captain ?? {};
  const hand      = normalizeCaptainZone(captain.hand, "hand");
  const idx       = hand.findIndex(entry => entry.instanceId === cardInstanceId);
  if (idx === -1) return;

  if (direction === "up" && idx > 0) {
    [hand[idx - 1], hand[idx]] = [hand[idx], hand[idx - 1]];
  } else if (direction === "down" && idx < hand.length - 1) {
    [hand[idx], hand[idx + 1]] = [hand[idx + 1], hand[idx]];
  } else {
    return; // already at edge
  }

  await emitToGM("updateResource", { roleId: "captain", key: "hand", value: hand, shipActorId: this.actor.id });
}

export const CAPTAIN_ACTIONS = {
  captainTriage:        _onTriage,
  captainPlayCard:      _onPlayCard,
  captainDiscardCard:   _onDiscardCard,
  captainMulligan:      _onMulligan,
  rollInitiative:       _onRollInitiative,
  rollLeadershipSL:     _onRollLeadershipSL,
  allocLeadershipSL:    _onAllocLeadershipSL,
  captainCoreAction:    _onCaptainCoreAction,
  fluxToCharge:         _onFluxToCharge,
  captainReorderCard:   _onCaptainReorderCard,
};
