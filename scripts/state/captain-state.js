/**
 * captain-state.js – Captain role state methods.
 *
 * Exported functions are attached as static methods on ShipCombatState.
 * Inside each function `this` refers to ShipCombatState.
 *
 * Captain resource shape (in sys.resources.captain):
 *   stance           : string  – "none" | "aggressive" | "defensive" | "redAlert" | "devastation"
 *   pendingStance    : string  – next-round stance set by a Gambit card; promoted to stance at advanceRound
 *   hand/drawPile/discardPile : Captain card instance objects
 *   triageCount      : number  – triages remaining this round (max 2)
 *   triageConditionsUsed : string[] – location IDs already triaged this round (max 1 per location)
 *   cardPlaysUsed    : number  – (legacy, no longer checked)
 *   mulligansSpent   : number – Resolve-funded mulligans spent this round
 *   allocationLocked : boolean – Captain/shared SL allocation is committed
 */

import { MODULE_ID, CAPTAIN_CARDS, CAPTAIN_CORE_ACTIONS, buildCaptainDeck } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getPowerCoreCount, getPowerCorePoolRole } from "../roles/crew-operators.js";
import { ensureContactRecord, isTargetableContactToken } from "../targeting/contact-intelligence.js";
import { normalizeCaptainZone, shuffleCaptainCards } from "../captain/card-instances.js";

const HAND_CAP   = 3;
const DRAWS_PER_ROUND = 3;
const BASE_MULLIGANS_PER_ROUND = 1;
const TRIAGE_MAX = 2;
const CORE_GRANT_CARD_IDS = new Set([
  "gunsHot",
  "pressTheAttack",
  "enhancedSensor",
  "armamentOrder",
  "overdriveCommand",
]);
const DEAD_RECKONING_RESERVATIONS = new Map();
const DEAD_RECKONING_PREVIEW_LIMIT = 12;

function _distanceSquaresToTarget(target, ship) {
  const own = ship?.getActiveTokens?.()?.[0];
  const gs = canvas?.grid?.size;
  if (!target || !own || !gs) return Infinity;
  const tx = target.x + (target.document.width * gs) / 2;
  const ty = target.y + (target.document.height * gs) / 2;
  const sx = own.x + (own.document.width * gs) / 2;
  const sy = own.y + (own.document.height * gs) / 2;
  return Math.hypot(tx - sx, ty - sy) / gs;
}

function _grantCore(sys, updates, stationRole, count = 1) {
  const poolRole = getPowerCorePoolRole(sys, stationRole);
  const key = `resources.${poolRole}.coreCount`;
  updates[key] = (updates[key] ?? getPowerCoreCount(sys, stationRole)) + count;
}

// ── Card lookup helper ────────────────────────────────────────────────────────
function _findCardDef(cardId) {
  return CAPTAIN_CARDS.find(c => c.id === cardId) ?? null;
}

async function _announceCoreAction(actionId) {
  const actionDef = CAPTAIN_CORE_ACTIONS.find(action => action.id === actionId);
  try {
    await ChatMessage.create({
      flavor: game.i18n.localize(actionDef?.label ?? actionId),
      content: `<p>${game.i18n.localize(actionDef?.desc ?? "")}</p>`,
      speaker: { alias: SystemAdapter.current.getShipData(this.ship)?.roleTitles?.captain || game.i18n.localize("SHIPCOMBAT.Role.Captain") },
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to announce Captain core action`, error);
  }
}

// ── Shuffle helper (Fisher-Yates) ─────────────────────────────────────────────
// ── Draw cards from the pile, reshuffling discard if needed ──────────────────
function _drawFrom(drawPile, discardPile, count) {
  let pile = [...drawPile];
  let discard = [...discardPile];
  const drawn = [];

  for (let i = 0; i < count; i++) {
    if (pile.length === 0) {
      if (discard.length === 0) break;           // truly empty
      pile = shuffleCaptainCards(discard);
      discard = [];
    }
    drawn.push(pile.shift());
  }

  return { drawn, drawPile: pile, discardPile: discard };
}

// ─────────────────────────────────────────────────────────────────────────────
// triageCondition({ locId })
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Step down one condition location by one tier.
 * Rules: max triageCount triages/round, any location can be stepped multiple times.
 */
export async function triageCondition({ locId }) {
  const sys = this.getData();
  const captain = sys.resources?.captain ?? {};
  const triageCount = captain.triageCount ?? 0;

  if (triageCount <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoTriagesLeft"));
    return;
  }

  const apMax = this.getReactorStats().auxPowerCapacity;
  const TRIAGE_AP_COST = Math.max(1, Math.ceil(apMax * 0.1));
  const currentAP = sys.resources?.engineer?.auxiliaryPower ?? 0;
  if (currentAP < TRIAGE_AP_COST) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
    return;
  }

  const conditions = sys.conditions ?? {};
  const existing   = conditions[locId];
  if (!existing?.tier) return;  // nothing to triage

  const TIER_ORDER = ["low", "medium", "high"];
  const idx = TIER_ORDER.indexOf(existing.tier);
  const updates = {};

  if (idx <= 0) {
    // Clearing the condition entirely (stepping below Low)
    // Note: {} is a no-op in Foundry's mergeObject; must explicitly null the tier
    updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { tier: null };
  } else {
    updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { ...existing, tier: TIER_ORDER[idx - 1] };
  }

  // Consume triage and AP
  updates[SystemAdapter.current.systemPath("resources.captain.triageCount")] = triageCount - 1;
  updates[SystemAdapter.current.systemPath("resources.engineer.auxiliaryPower")] = currentAP - TRIAGE_AP_COST;

  await this.ship.update(updates);

  // Chat notification
  const locKey = `SHIPCOMBAT.Crit.Location.${locId}`;
  const locLabel = game.i18n.localize(locKey);
  const triageName = game.i18n.localize(`SHIPCOMBAT.Crit.Triage.${locId}`);
  const newTier = idx <= 0 ? game.i18n.localize("SHIPCOMBAT.Captain.Cleared") : game.i18n.localize(`SHIPCOMBAT.Crit.Tier.${TIER_ORDER[idx - 1].charAt(0).toUpperCase() + TIER_ORDER[idx - 1].slice(1)}`);

  await ChatMessage.create({
    flavor: `${triageName}  -  ${locLabel}`,
    content: `<p>${game.i18n.format("SHIPCOMBAT.Captain.TriageResult", { location: locLabel, tier: newTier })}</p>`,
    speaker: { alias: SystemAdapter.current.getShipData(this.ship)?.roleTitles?.captain || game.i18n.localize("SHIPCOMBAT.Role.Captain") },
    whisper: ChatMessage.getWhisperRecipients("GM"),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// drawCards({ count })   -  GM or captain player draws up to count cards
// ─────────────────────────────────────────────────────────────────────────────
export async function drawCards({ count = DRAWS_PER_ROUND } = {}) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = normalizeCaptainZone(captain.hand, "hand");
  const cap      = (captain.currentHandCap ?? HAND_CAP) + (captain.handCapBonus ?? 0);
  const headroom = cap - hand.length;
  if (headroom <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.CaptainHandFull"));
    return;
  }

  const toDraw = Math.min(count, headroom);
  const _excl = (sys.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (sys.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
  const _exclCards = (sys.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
  const { drawn, drawPile, discardPile } = _drawFrom(
    normalizeCaptainZone(captain.drawPile ?? buildCaptainDeck(_excl, _exclCards), "draw"),
    normalizeCaptainZone(captain.discardPile, "discard"),
    toDraw,
  );

  await this.update({
    "resources.captain.hand":        [...hand, ...drawn],
    "resources.captain.drawPile":    drawPile,
    "resources.captain.discardPile": discardPile,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// playCard({ cardId })
// ─────────────────────────────────────────────────────────────────────────────
export async function playCard(payload) {
  return this.withAllocationTransaction(() => {
    if (CORE_GRANT_CARD_IDS.has(payload?.cardId)) {
      return this.withPowerCoreTransaction(() => _playCard.call(this, payload));
    }
    return _playCard.call(this, payload);
  });
}

async function _playCard({ cardId, cardInstanceId, sector }) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = normalizeCaptainZone(captain.hand, "hand");
  const cardIdx = cardInstanceId
    ? hand.findIndex(card => card.instanceId === cardInstanceId)
    : hand.findIndex(card => card.cardId === cardId);
  if (cardIdx === -1) return;   // card not in hand

  const playedCard = hand[cardIdx];
  cardId = playedCard.cardId;

  const cardDef = _findCardDef(cardId);
  if (!cardDef) return;

  // (no stance pre-requisite for hardenShields)

  // Remove from hand, add to discard
  hand.splice(cardIdx, 1);
  const drawPile = normalizeCaptainZone(captain.drawPile, "draw");
  const discardPile = normalizeCaptainZone(captain.discardPile, "discard");
  if (playedCard.salvaged) {
    drawPile.push({ ...playedCard, salvaged: false });
  } else {
    discardPile.push(playedCard);
  }
  const updates = {
    "resources.captain.hand":        hand,
    "resources.captain.drawPile":    drawPile,
    "resources.captain.discardPile": discardPile,
    "resources.captain.playedCards": [...(captain.playedCards ?? []), cardId],
  };

  // Apply card effect
  if (cardDef.category === "gambit" && cardDef.setsStance) {
    updates["resources.captain.pendingStance"] = cardDef.setsStance;
  }

  // Per-card immediate effects
  switch (cardId) {
    // Core grants share the receiving operator's pool. They intentionally do
    // not touch assignedCores, which is exclusively the Engineer's ledger.
    case "gunsHot":         _grantCore(sys, updates, "gunner");   break;
    case "pressTheAttack":  _grantCore(sys, updates, "pilot");    break;
    case "enhancedSensor":  _grantCore(sys, updates, "sensors");  break;
    case "armamentOrder":   _grantCore(sys, updates, "ordnance"); break;
    // Gunner hit bonus
    case "inspiredTargeting":
      updates["resources.gunner.captainHitBonus"] = (sys.resources?.gunner?.captainHitBonus ?? 0) + SystemAdapter.current.getHitBonusStep();
      break;
    // Pilot maneuverability doubled
    case "hardOver":
      updates["resources.pilot.hardOverActive"] = true;
      break;
    // Sensors: halve L1/L2 lock costs after component modifiers
    case "sensorPriority":
      updates["resources.sensors.sensorPriorityActive"] = true;
      break;
    // Harden Shields: shield bypass weapons cannot bypass void shields this round
    case "hardenShields":
      updates["resources.captain.hardenedShields"] = true;
      break;
    // Armour Repair: reset rend damage on the chosen sector
    case "repairArmour":
      if (sector) updates[`armourRend.${sector}`] = 0;
      break;
    // Hold the Line: flag checked in advanceRound fire processing
    case "holdTheLine":
      updates["resources.captain.holdTheLineActive"] = true;
      break;
    // Emergency Reserves: replenish AP by 50%
    case "emergencyReserves": {
      if (sys.conditions?.coreSystems?.tier === "high") {
        ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.APShutdown"));
        break;
      }
      const ap    = sys.resources?.engineer?.auxiliaryPower ?? 0;
      const apMax = this.getReactorStats().auxPowerCapacity;
      updates["resources.engineer.auxiliaryPower"] = Math.min(apMax, ap + Math.ceil(apMax / 2));
      break;
    }
    // Venting Sequence: vent up to 5 heat immediately, creating internal fires equal to heat vented
    case "ventingSequence": {
      const currentHeat = sys.resources?.engineer?.heat ?? 0;
      const vented = Math.min(5, currentHeat);
      updates["resources.engineer.heat"] = Math.max(0, currentHeat - 5);
      if (vented > 0) {
        updates["internalFire"] = (sys.internalFire ?? 0) + vented;
      }
      break;
    }
    // Overdrive Command: grant a free core use to all combat roles + extra engineer action
    case "overdriveCommand": {
      for (const roleId of ["gunner", "pilot", "sensors", "ordnance", "captain"]) {
        _grantCore(sys, updates, roleId);
      }
      updates["resources.engineer.extraActions"] = (sys.resources?.engineer?.extraActions ?? 0) + 1;
      break;
    }
    // Double Shift: grant Engineer one additional action slot this round
    case "doubleShift": {
      updates["resources.engineer.extraActions"] = (sys.resources?.engineer?.extraActions ?? 0) + 1;
      break;
    }
    // Accelerated Loading: crew commitments tick by 2 at next advanceRound
    case "acceleratedLoading": {
      updates["resources.captain.acceleratedLoadingActive"] = true;
      break;
    }
    default:
      break;
  }

  await this.update(updates);

  // Chat  -  styled card matching the UI card appearance (reuses captain card CSS classes)
  const cardLabel   = game.i18n.localize(`SHIPCOMBAT.Captain.Card.${cardId}`);
  const catLabel    = game.i18n.localize(`SHIPCOMBAT.Captain.Category.${cardDef.category}`);
  const descText    = game.i18n.localize(`SHIPCOMBAT.Captain.Card.Desc.${cardId}`);
  // Category icon: matches _cardIcon() helper in captain.js
  const catIconMap  = { boost: "fa-solid fa-arrow-up", shipwide: "fa-solid fa-ship", reaction: "fa-solid fa-shield", gambit: "fa-solid fa-chess-knight" };
  const cardIcon    = catIconMap[cardDef.category] ?? "fa-solid fa-cards";
  // Target role icon (if card targets a specific role)
  const targetRoleIconMap = { gunner: "fa-solid fa-crosshairs", pilot: "fa-solid fa-compass", sensors: "fa-solid fa-satellite-dish", ordnance: "fa-solid fa-rocket", engineer: "fa-solid fa-gears" };
  const targetIcon  = cardDef.targetRole ? targetRoleIconMap[cardDef.targetRole] : null;
  const stanceLine  = cardDef.setsStance
    ? `<div class="shipcombat-captain-card-stance-footer"><i class="fa-solid fa-flag"></i> ${game.i18n.localize(`SHIPCOMBAT.Captain.Stance.${cardDef.setsStance}`)}</div>`
    : "";
  await ChatMessage.create({
    content: `<div class="shipcombat-captain-card shipcombat-captain-card--${cardDef.category} shipcombat-chat-captain-card">
  <div class="shipcombat-captain-card-header">
    <span class="shipcombat-captain-card-cat">${catLabel}</span>
    ${targetIcon ? `<span class="shipcombat-captain-card-target"><i class="${targetIcon}"></i></span>` : ""}
    ${cardDef.setsStance ? `<span class="shipcombat-captain-card-stance-dot"><i class="fa-solid fa-flag"></i></span>` : ""}
  </div>
  <div class="shipcombat-captain-card-name"><i class="${cardIcon}"></i> ${cardLabel}</div>
  <div class="shipcombat-captain-card-desc">${descText}</div>${stanceLine}
</div>`,
    speaker: { alias: SystemAdapter.current.getShipData(this.ship)?.roleTitles?.captain || game.i18n.localize("SHIPCOMBAT.Role.Captain") },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// mulligan({ cardId, cardInstanceId }) - replace one slot using a Resolve point
// ─────────────────────────────────────────────────────────────────────────────
export async function mulligan(payload) {
  return this.withAllocationTransaction(() => _mulligan.call(this, payload));
}

async function _mulligan({ cardId, cardInstanceId }) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = normalizeCaptainZone(captain.hand, "hand");
  const mulligansSpent = captain.mulligansSpent ?? 0;
  if (mulligansSpent >= BASE_MULLIGANS_PER_ROUND + (captain.allocResolve ?? 0)) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.CaptainMulliganUsed"));
    return;
  }
  const cardIdx = cardInstanceId
    ? hand.findIndex(card => card.instanceId === cardInstanceId)
    : hand.findIndex(card => card.cardId === cardId);
  if (cardIdx === -1) return;

  const replacedCard = hand[cardIdx];
  let drawPile = normalizeCaptainZone(captain.drawPile, "draw");
  let discardPile = normalizeCaptainZone(captain.discardPile, "discard");

  // Draw before discarding the replaced card so a depleted pile cannot return
  // the exact same physical card as its own replacement.
  const _excl = (sys.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (sys.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
  const _exclCards = (sys.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
  const result = _drawFrom(
    drawPile.length ? drawPile : normalizeCaptainZone(captain.drawPile ?? buildCaptainDeck(_excl, _exclCards), "draw"),
    discardPile,
    1,
  );
  drawPile = result.drawPile;
  discardPile = result.discardPile;
  if (!result.drawn.length) return;
  hand[cardIdx] = result.drawn[0];

  if (replacedCard.salvaged) drawPile.push({ ...replacedCard, salvaged: false });
  else discardPile.push(replacedCard);

  await this.update({
    "resources.captain.hand":         hand,
    "resources.captain.drawPile":     drawPile,
    "resources.captain.discardPile":  discardPile,
    "resources.captain.mulligansSpent": mulligansSpent + 1,
    "resources.captain.allocationLocked": true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// discardCard({ cardId })   -  Remove one card from hand to the discard pile.
// ─────────────────────────────────────────────────────────────────────────────
export async function discardCard({ cardId, cardInstanceId }) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = normalizeCaptainZone(captain.hand, "hand");
  const cardIdx = cardInstanceId
    ? hand.findIndex(card => card.instanceId === cardInstanceId)
    : hand.findIndex(card => card.cardId === cardId);
  if (cardIdx === -1) return;
  const [discardedCard] = hand.splice(cardIdx, 1);
  const drawPile = normalizeCaptainZone(captain.drawPile, "draw");
  const discardPile = normalizeCaptainZone(captain.discardPile, "discard");
  if (discardedCard.salvaged) drawPile.push({ ...discardedCard, salvaged: false });
  else discardPile.push(discardedCard);
  await this.update({
    "resources.captain.hand":        hand,
    "resources.captain.drawPile":    drawPile,
    "resources.captain.discardPile": discardPile,
  });
}

// captainPayloadActivate({ payloadId })  -  GM applies an immediate captain payload effect.
// ─────────────────────────────────────────────────────────────────────────────
export async function captainPayloadActivate({ payloadId } = {}) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};

  // ── Cogitator Data-Slate: +2 hand cap this round, draw 2 cards immediately ──
  if (payloadId === "cogitatorDataSlate") {
    const currentBonus = captain.handCapBonus ?? 0;
    await this.update({ "resources.captain.handCapBonus": currentBonus + 2 });
    // Re-read after the cap update so drawCards sees the new headroom
    await drawCards.call(this, { count: 2 });
    return;
  }

  // ── Fire Suppression Canisters: randomly step down one active condition ──
  if (payloadId === "fireSuppression") {
    const conditions = sys.conditions ?? {};
    const activeLocIds = Object.entries(conditions)
      .filter(([, c]) => !!c.tier)
      .map(([locId]) => locId);
    if (!activeLocIds.length) {
      ui.notifications.info(game.i18n.localize("SHIPCOMBAT.Payload.FireSuppressionNoConditions"));
      return;
    }
    const locId    = activeLocIds[Math.floor(Math.random() * activeLocIds.length)];
    const existing = conditions[locId];
    const TIER_ORDER = ["low", "medium", "high"];
    const idx = TIER_ORDER.indexOf(existing.tier);
    const updates = {};
    if (idx <= 0) {
      updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { tier: null };
    } else {
      updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { ...existing, tier: TIER_ORDER[idx - 1] };
    }
    await this.ship.update(updates);
    const locLabel = game.i18n.localize(`SHIPCOMBAT.Crit.Location.${locId}`);
    const newTier  = idx <= 0
      ? game.i18n.localize("SHIPCOMBAT.Captain.Cleared")
      : game.i18n.localize(`SHIPCOMBAT.Crit.Tier.${TIER_ORDER[idx - 1].charAt(0).toUpperCase() + TIER_ORDER[idx - 1].slice(1)}`);
    await ChatMessage.create({
      flavor:  `${game.i18n.localize("SHIPCOMBAT.Payload.FireSuppression")}  -  ${locLabel}`,
      content: `<p>${game.i18n.format("SHIPCOMBAT.Captain.TriageResult", { location: locLabel, tier: newTier })}</p>`,
      speaker: { alias: SystemAdapter.current.getShipData(this.ship)?.roleTitles?.captain || game.i18n.localize("SHIPCOMBAT.Role.Captain") },
    });
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// captainCoreAction({ actionId, ...payload })
// Runs on GM. Validates, applies the effect, marks core spent.
// ─────────────────────────────────────────────────────────────────────────────
export async function captainCoreAction({ actionId, tokenId, cardInstanceId } = {}) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};

  const hasCoreAvail = getPowerCoreCount(sys, "captain") > 0;
  if (!hasCoreAvail) return;

  const TIER_ORDER = ["low", "medium", "high"];
  const updates    = {};

  // ── Emergency Protocols: clear all Low conditions; discard hand ──
  if (actionId === "emergencyProtocols") {
    const conditions = sys.conditions ?? {};
    for (const [locId, cond] of Object.entries(conditions)) {
      if (cond.tier === "low") updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { tier: null };
    }
    const hand = normalizeCaptainZone(captain.hand, "hand");
    const drawPile = normalizeCaptainZone(captain.drawPile, "draw");
    const discard = normalizeCaptainZone(captain.discardPile, "discard");
    for (const card of hand) {
      if (card.salvaged) drawPile.push({ ...card, salvaged: false });
      else discard.push(card);
    }
    updates[SystemAdapter.current.systemPath("resources.captain.hand")]         = [];
    updates[SystemAdapter.current.systemPath("resources.captain.drawPile")]     = drawPile;
    updates[SystemAdapter.current.systemPath("resources.captain.discardPile")]  = discard;
  }

  // ── Iron Command: step High/Medium conditions down 1 tier; Low stays; discard hand ──
  else if (actionId === "ironCommand") {
    const conditions = sys.conditions ?? {};
    for (const [locId, cond] of Object.entries(conditions)) {
      if (!cond.tier || cond.tier === "low") continue; // Low stays unchanged
      const idx = TIER_ORDER.indexOf(cond.tier);
      // High (idx 2) → Medium (idx 1), Medium (idx 1) → Low (idx 0)
      updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { ...cond, tier: TIER_ORDER[idx - 1] };
    }
    const hand = normalizeCaptainZone(captain.hand, "hand");
    const drawPile = normalizeCaptainZone(captain.drawPile, "draw");
    const discard = normalizeCaptainZone(captain.discardPile, "discard");
    for (const card of hand) {
      if (card.salvaged) drawPile.push({ ...card, salvaged: false });
      else discard.push(card);
    }
    updates[SystemAdapter.current.systemPath("resources.captain.hand")]         = [];
    updates[SystemAdapter.current.systemPath("resources.captain.drawPile")]     = drawPile;
    updates[SystemAdapter.current.systemPath("resources.captain.discardPile")]  = discard;
  }

  // ── Priority Target: mark one target; +10 acc, pierce 2 shields ──
  else if (actionId === "battleClarity") {
    if (!tokenId) return;
    const target = canvas?.tokens?.get(tokenId);
    if (!isTargetableContactToken(target, this.ship)) return;
    const lockTier = this.getEffectiveLockTier(
      tokenId,
      _distanceSquaresToTarget(target, this.ship),
    );
    if (lockTier < 1) return;
    updates[SystemAdapter.current.systemPath("resources.captain.priorityTargetId")] = tokenId;
    const ensured = ensureContactRecord(sys, tokenId, {
      tier: lockTier,
      realName: target.document?.name ?? null,
    });
    updates[SystemAdapter.current.systemPath("resources.sensors.contacts")] = ensured.contacts;
    updates[SystemAdapter.current.systemPath("resources.sensors.nextContactOrdinal")] = ensured.nextContactOrdinal;
  }

  // ── Emergency Salvage: retrieve one card from discard to hand ──
  else if (actionId === "emergencySalvage") {
    if (!cardInstanceId) return;
    const hand    = normalizeCaptainZone(captain.hand, "hand");
    const discard = normalizeCaptainZone(captain.discardPile, "discard");
    const idx = discard.findIndex(card => card.instanceId === cardInstanceId);
    if (idx === -1) return;
    const [salvagedCard] = discard.splice(idx, 1);
    hand.push({ ...salvagedCard, salvaged: true });
    const drawPile = shuffleCaptainCards([
      ...normalizeCaptainZone(captain.drawPile, "draw"),
      ...discard,
    ]);
    updates[SystemAdapter.current.systemPath("resources.captain.hand")]        = hand;
    updates[SystemAdapter.current.systemPath("resources.captain.drawPile")]    = drawPile;
    updates[SystemAdapter.current.systemPath("resources.captain.discardPile")] = [];
  }

  // ── Command Override: promote pendingStance immediately ──
  else if (actionId === "commandOverride") {
    const pending = captain.pendingStance;
    if (!pending) return;
    updates[SystemAdapter.current.systemPath("resources.captain.stance")]        = pending;
    updates[SystemAdapter.current.systemPath("resources.captain.pendingStance")] = "";
  }

  else return; // unknown actionId

  // Reserve the shared pool before applying the prepared effect. Competing
  // Captain/Sensors/Ordnance actions can no longer authorize the same core.
  if (!(await this.consumePowerCore("captain"))) return;

  await this.ship.update(updates);

  // Chat notification
  await _announceCoreAction.call(this, actionId);
}

/** Spend Dead Reckoning's core before disclosing its authoritative preview. */
export async function beginDeadReckoning() {
  return this.withPowerCoreTransaction(async () => {
    const sys = this.getData();
    const captain = sys.resources?.captain ?? {};
    const drawPile = normalizeCaptainZone(captain.drawPile, "draw");
    if (!drawPile.length) return { ok: false, reason: "emptyPile" };

    const poolRole = getPowerCorePoolRole(sys, "captain");
    const coreCount = getPowerCoreCount(sys, "captain");
    if (coreCount <= 0) return { ok: false, reason: "noCore" };

    let reservationId;
    do reservationId = foundry.utils.randomID(20);
    while (DEAD_RECKONING_RESERVATIONS.has(reservationId));
    const cards = drawPile.slice(0, DEAD_RECKONING_PREVIEW_LIMIT);
    const shipId = this.ship?.uuid ?? this.ship?.id;

    await this.update({
      [`resources.${poolRole}.coreCount`]: coreCount - 1,
      "resources.captain.coreActionsPlayed": [
        ...(captain.coreActionsPlayed ?? []),
        "deadReckoning",
      ],
    });
    DEAD_RECKONING_RESERVATIONS.set(reservationId, {
      shipId,
      cardInstanceIds: cards.map(card => card.instanceId),
    });
    await _announceCoreAction.call(this, "deadReckoning");

    return {
      ok: true,
      reservationId,
      cards,
      tailCount: Math.max(0, drawPile.length - cards.length),
    };
  });
}

/** Apply a paid Dead Reckoning reservation without charging a second core. */
export async function completeDeadReckoning({ reservationId, orderedInstanceIds } = {}) {
  const reservation = DEAD_RECKONING_RESERVATIONS.get(reservationId);
  if (!reservation) return { ok: false };
  DEAD_RECKONING_RESERVATIONS.delete(reservationId);

  const shipId = this.ship?.uuid ?? this.ship?.id;
  if (!shipId || reservation.shipId !== shipId || !Array.isArray(orderedInstanceIds)) return { ok: false };
  if (orderedInstanceIds.length !== reservation.cardInstanceIds.length) return { ok: false };
  if (new Set(orderedInstanceIds).size !== orderedInstanceIds.length) return { ok: false };
  const reservedIds = new Set(reservation.cardInstanceIds);
  if (orderedInstanceIds.some(instanceId => !reservedIds.has(instanceId))) return { ok: false };

  const captain = this.getData().resources?.captain ?? {};
  const drawPile = normalizeCaptainZone(captain.drawPile, "draw");
  const currentPreview = drawPile.slice(0, reservation.cardInstanceIds.length);
  if (currentPreview.length !== reservation.cardInstanceIds.length
      || currentPreview.some(card => !reservedIds.has(card.instanceId))) return { ok: false };

  const cardsById = new Map(currentPreview.map(card => [card.instanceId, card]));
  const reordered = orderedInstanceIds.map(instanceId => cardsById.get(instanceId));
  await this.update({
    "resources.captain.drawPile": [...reordered, ...drawPile.slice(currentPreview.length)],
  });
  return { ok: true };
}

/** Close a reservation without refunding the already-spent preview cost. */
export async function cancelDeadReckoning({ reservationId } = {}) {
  const reservation = DEAD_RECKONING_RESERVATIONS.get(reservationId);
  const shipId = this.ship?.uuid ?? this.ship?.id;
  if (reservation?.shipId === shipId) DEAD_RECKONING_RESERVATIONS.delete(reservationId);
  return { ok: true };
}
