/**
 * captain-state.js – Captain role state methods.
 *
 * Exported functions are attached as static methods on ShipCombatState.
 * Inside each function `this` refers to ShipCombatState.
 *
 * Captain resource shape (in sys.resources.captain):
 *   stance           : string  – "none" | "aggressive" | "defensive" | "redAlert" | "devastation"
 *   pendingStance    : string  – next-round stance set by a Gambit card; promoted to stance at advanceRound
 *   hand             : string[] – card IDs currently held (cap 5)
 *   drawPile         : string[] – remaining undrawn cards
 *   discardPile      : string[] – played / discarded cards
 *   triageCount      : number  – triages remaining this round (max 2)
 *   triageConditionsUsed : string[] – location IDs already triaged this round (max 1 per location)
 *   cardPlaysUsed    : number  – (legacy, no longer checked)
 *   mulliganUsed     : boolean – whether the free mulligan was already used this round
 */

import { MODULE_ID, CAPTAIN_CARDS, CAPTAIN_CORE_ACTIONS, buildCaptainDeck } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const HAND_CAP   = 6;
const DRAWS_PER_ROUND = 3;
const TRIAGE_MAX = 2;

// ── Card lookup helper ────────────────────────────────────────────────────────
function _findCardDef(cardId) {
  return CAPTAIN_CARDS.find(c => c.id === cardId) ?? null;
}

// ── Shuffle helper (Fisher-Yates) ─────────────────────────────────────────────
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Draw cards from the pile, reshuffling discard if needed ──────────────────
function _drawFrom(drawPile, discardPile, count) {
  let pile = [...drawPile];
  let discard = [...discardPile];
  const drawn = [];

  for (let i = 0; i < count; i++) {
    if (pile.length === 0) {
      if (discard.length === 0) break;           // truly empty
      pile = _shuffle(discard);
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
  const hand    = [...(captain.hand ?? [])];
  const cap      = HAND_CAP + (captain.handCapBonus ?? 0) + (captain.allocInspire ?? 0);
  const headroom = cap - hand.length;
  if (headroom <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.CaptainHandFull"));
    return;
  }

  const toDraw = Math.min(count, headroom);
  const _excl = (sys.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (sys.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
  const _exclCards = (sys.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
  const { drawn, drawPile, discardPile } = _drawFrom(
    captain.drawPile   ?? buildCaptainDeck(_excl, _exclCards),
    captain.discardPile ?? [],
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
export async function playCard({ cardId, sector }) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = [...(captain.hand ?? [])];
  const cardIdx = hand.indexOf(cardId);
  if (cardIdx === -1) return;   // card not in hand

  const cardDef = _findCardDef(cardId);
  if (!cardDef) return;

  // (no stance pre-requisite for hardenShields)

  // Remove from hand, add to discard
  hand.splice(cardIdx, 1);
  const discardPile = [...(captain.discardPile ?? []), cardId];
  const updates = {
    "resources.captain.hand":        hand,
    "resources.captain.discardPile": discardPile,
    "resources.captain.playedCards": [...(captain.playedCards ?? []), cardId],
  };

  // Apply card effect
  if (cardDef.category === "gambit" && cardDef.setsStance) {
    updates["resources.captain.pendingStance"] = cardDef.setsStance;
  }

  // Per-card immediate effects
  switch (cardId) {
    // Free core action: grant a virtual core (does NOT set assignedCores, so Engineer can still assign a real one later)
    case "gunsHot":         updates["resources.gunner.coreCount"]   = (sys.resources?.gunner?.coreCount   ?? 0) + 1; break;
    case "pressTheAttack":  updates["resources.pilot.coreCount"]    = (sys.resources?.pilot?.coreCount    ?? 0) + 1; break;
    case "enhancedSensor":  updates["resources.sensors.coreCount"]  = (sys.resources?.sensors?.coreCount  ?? 0) + 1; break;
    case "armamentOrder":    updates["resources.ordnance.coreCount"] = (sys.resources?.ordnance?.coreCount ?? 0) + 1; break;
    // Gunner hit bonus
    case "inspiredTargeting":
      updates["resources.gunner.captainHitBonus"] = (sys.resources?.gunner?.captainHitBonus ?? 0) + SystemAdapter.current.getHitBonusStep();
      break;
    // Pilot maneuverability doubled
    case "hardOver":
      updates["resources.pilot.hardOverActive"] = true;
      break;
    // Sensors: L1/L2 lock costs 0 AP
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
        updates[`resources.${roleId}.coreCount`] = (sys.resources?.[roleId]?.coreCount ?? 0) + 1;
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
// mulligan({ cardId })   -  Discard one card and draw one replacement
//   Free once per round. Second mulligan would cost triage, but is not offered.
// ─────────────────────────────────────────────────────────────────────────────
export async function mulligan({ cardId }) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = [...(captain.hand ?? [])];

  if (captain.mulliganUsed) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.CaptainMulliganUsed"));
    return;
  }
  const cardIdx = hand.indexOf(cardId);
  if (cardIdx === -1) return;

  // Remove from hand → discard, then draw 1 replacement
  hand.splice(cardIdx, 1);
  const discard = [...(captain.discardPile ?? []), cardId];

  const _excl = (sys.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (sys.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
  const _exclCards = (sys.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
  const { drawn, drawPile, discardPile } = _drawFrom(
    captain.drawPile   ?? buildCaptainDeck(_excl, _exclCards),
    discard,
    1,
  );

  await this.update({
    "resources.captain.hand":         [...hand, ...drawn],
    "resources.captain.drawPile":     drawPile,
    "resources.captain.discardPile":  discardPile,
    "resources.captain.mulliganUsed": true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// discardCard({ cardId })   -  Remove one card from hand to the discard pile.
// ─────────────────────────────────────────────────────────────────────────────
export async function discardCard({ cardId }) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};
  const hand    = [...(captain.hand ?? [])];
  const cardIdx = hand.indexOf(cardId);
  if (cardIdx === -1) return;
  hand.splice(cardIdx, 1);
  const discardPile = [...(captain.discardPile ?? []), cardId];
  await this.update({
    "resources.captain.hand":        hand,
    "resources.captain.discardPile": discardPile,
  });
}

// fullRedraw()   -  Discard entire hand, draw fresh up to 5. Costs both triages.
// ─────────────────────────────────────────────────────────────────────────────
export async function fullRedraw() {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};

  // Burn both triages
  const discard = [...(captain.discardPile ?? []), ...(captain.hand ?? [])];
  const _excl = (sys.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (sys.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
  const _exclCards = (sys.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
  const { drawn, drawPile, discardPile } = _drawFrom(
    captain.drawPile ?? buildCaptainDeck(_excl, _exclCards),
    discard,
    HAND_CAP + (captain.handCapBonus ?? 0) + (captain.allocInspire ?? 0),
  );

  await this.update({
    "resources.captain.hand":                drawn,
    "resources.captain.drawPile":            drawPile,
    "resources.captain.discardPile":         discardPile,
    "resources.captain.triageCount":         0,
    "resources.captain.triageConditionsUsed": [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
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
export async function captainCoreAction({ actionId, tokenId, cardId, newPile } = {}) {
  const sys     = this.getData();
  const captain = sys.resources?.captain ?? {};

  const hasCoreAvail = ((captain.coreCount ?? 0) > 0) || (!!(sys.assignedCores?.captain) && sys.assignedCores.captain !== "spent");
  if (!hasCoreAvail) return;

  const TIER_ORDER = ["low", "medium", "high"];
  const updates    = {};

  // ── Emergency Protocols: clear all Low conditions; discard hand ──
  if (actionId === "emergencyProtocols") {
    const conditions = sys.conditions ?? {};
    for (const [locId, cond] of Object.entries(conditions)) {
      if (cond.tier === "low") updates[SystemAdapter.current.systemPath(`conditions.${locId}`)] = { tier: null };
    }
    const discard = [...(captain.discardPile ?? []), ...(captain.hand ?? [])];
    updates[SystemAdapter.current.systemPath("resources.captain.hand")]         = [];
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
    const discard = [...(captain.discardPile ?? []), ...(captain.hand ?? [])];
    updates[SystemAdapter.current.systemPath("resources.captain.hand")]         = [];
    updates[SystemAdapter.current.systemPath("resources.captain.discardPile")]  = discard;
  }

  // ── Battle Clarity: mark priority target; +10 acc, pierce 2 shields ──
  else if (actionId === "battleClarity") {
    if (!tokenId) return;
    updates[SystemAdapter.current.systemPath("resources.captain.priorityTargetId")] = tokenId;
  }

  // ── Emergency Salvage: retrieve one card from discard to hand ──
  else if (actionId === "emergencySalvage") {
    if (!cardId) return;
    const hand    = [...(captain.hand ?? [])];
    const discard = [...(captain.discardPile ?? [])];
    const idx = discard.indexOf(cardId);
    if (idx === -1) return;
    discard.splice(idx, 1);
    hand.push(cardId);
    updates[SystemAdapter.current.systemPath("resources.captain.hand")]        = hand;
    updates[SystemAdapter.current.systemPath("resources.captain.discardPile")] = discard;
  }

  // ── Command Override: promote pendingStance immediately ──
  else if (actionId === "commandOverride") {
    const pending = captain.pendingStance;
    if (!pending) return;
    updates[SystemAdapter.current.systemPath("resources.captain.stance")]        = pending;
    updates[SystemAdapter.current.systemPath("resources.captain.pendingStance")] = "";
  }

  // ── Dead Reckoning: reorder top 12 draw pile cards; block mulligan ──
  else if (actionId === "deadReckoning") {
    if (!newPile) return;
    updates[SystemAdapter.current.systemPath("resources.captain.drawPile")]    = newPile;
    updates[SystemAdapter.current.systemPath("resources.captain.mulliganUsed")] = true; // block mulligan this round
  }

  else return; // unknown actionId

  // Consume one core (card-granted coreCount first, then Engineer-assigned core)
  if ((captain.coreCount ?? 0) > 0) {
    updates[SystemAdapter.current.systemPath("resources.captain.coreCount")] = captain.coreCount - 1;
  } else {
    updates[SystemAdapter.current.systemPath("assignedCores.captain")] = "spent";
  }

  await this.ship.update(updates);

  // Chat notification
  const actionDef = CAPTAIN_CORE_ACTIONS.find(a => a.id === actionId);
  await ChatMessage.create({
    flavor:  game.i18n.localize(actionDef?.label ?? actionId),
    content: `<p>${game.i18n.localize(actionDef?.desc ?? "")}</p>`,
    speaker: { alias: SystemAdapter.current.getShipData(this.ship)?.roleTitles?.captain || game.i18n.localize("SHIPCOMBAT.Role.Captain") },
  });
}
