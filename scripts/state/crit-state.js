/**
 * crit-state.js – Crit roll resolution for ship-to-ship combat.
 *
 * Trigger: any hit dealing damage > 10% of target hull max.
 * Devastation Protocol stance: force crit regardless of damage threshold (both ways).
 *
 * Roll:  d6 → location,  d10 → severity tier (1-5 Low, 6-8 Medium, 9-10 High).
 * Escalation: if condition already exists at location, roll d6.
 *   4+ → escalate one tier.  High already → deal −3 hull instead.
 *   1-3 → condition stays at current tier.
 */

import { MODULE_ID, CRIT_CONDITIONS, CRIT_LOCATIONS, critLocationFromRoll, critSeverityFromRoll } from "../constants.js";

const TIER_ORDER = ["low", "medium", "high"];

/**
 * Roll a crit against a target actor.
 * May be called with `this` = ShipCombatState (domain method pattern) or standalone.
 *
 * Any net hull damage triggers a crit.
 *   - totalDamage > 10% hull max → roll d10 for tier (Low/Medium/High)
 *   - totalDamage > 0 but ≤ 10% hull max → guaranteed Low tier (no d10)
 *   - Devastation Protocol → always roll d10 regardless of damage level
 *
 * @param {Actor}   targetActor          – The ship actor receiving the crit
 * @param {number}  totalDamage          – Total net hull damage from the attack
 * @param {boolean} [forceCrit=false]    – Bypass threshold (Devastation Protocol)
 * @param {number}  [thresholdReduction=0] – Reduce crit threshold by this many percentage points (Fire for Effect: SL value)
 */
export async function rollCrit(targetActor, totalDamage, forceCrit = false, thresholdReduction = 0) {
  if (!targetActor) return;
  if (!forceCrit && totalDamage <= 0) return;

  const hullMax = targetActor.system?.hull?.max ?? 50;
  const critThresholdPct = Math.max(0, 0.10 - (thresholdReduction / 100));
  const thresholdMet = forceCrit || totalDamage > hullMax * critThresholdPct;

  // Collect dice rolls for the chat card (only include rolls that were actually made)
  const critRolls = [];

  // ── 1. Determine severity tier ────────────────────────────────────────────
  let rolledTier;
  if (thresholdMet) {
    // Full roll: d10 for tier
    const sevRoll = await new Roll("1d10").evaluate();
    if (game.dice3d) game.dice3d.showForRoll(sevRoll, game.user, true);
    critRolls.push(sevRoll);
    rolledTier = critSeverityFromRoll(sevRoll.total);
  } else {
    // Below threshold but damage got through  -  guaranteed Low
    rolledTier = "low";
  }

  // If the attacking ship's gunner pre-selected a location via Directed Fire,
  // use that stored choice (the picker ran on the gunner player's screen, not here).
  const isPlayerFiring    = this?.ship && targetActor?.id !== this.ship?.id;
  const chooseCritLoc     = isPlayerFiring && (this.getData?.()?.resources?.gunner?.chooseCritLocation ?? false);
  const storedLocId       = this.getData?.()?.resources?.gunner?.critLocationChoice ?? null;
  let locationEntry;

  if (chooseCritLoc && storedLocId) {
    locationEntry = CRIT_LOCATIONS.find(l => l.id === storedLocId) ?? null;
    // Flags persist for the remainder of the turn; advanceRound clears them.
  }

  if (!locationEntry) {
    const locRoll = await new Roll("1d6").evaluate();
    if (game.dice3d) game.dice3d.showForRoll(locRoll, game.user, true);
    critRolls.push(locRoll);
    locationEntry = critLocationFromRoll(locRoll.total);
  }

  // NPC ships use the same Core Systems conditions (speed reduction instead of core distribution)

  const locId         = locationEntry.id;
  const condDef       = CRIT_CONDITIONS[locId];

  const existing     = targetActor.system?.conditions?.[locId] ?? {};
  const existingTier = existing?.tier ?? null;

  let finalTier   = rolledTier;
  let escalated   = false;
  let extraHullDmg = 0;
  let escRollTotal = null;

  // ── 2. Escalation check if condition already exists ──────────────────────
  if (existingTier) {
    const escRoll = await new Roll("1d6").evaluate();
    escRollTotal  = escRoll.total;
    if (game.dice3d) game.dice3d.showForRoll(escRoll, game.user, true);

    if (escRollTotal >= 4) {
      if (existingTier === "high") {
        // Already at max  -  deal bonus hull damage instead
        extraHullDmg = 3;
        finalTier    = "high";
      } else {
        finalTier = TIER_ORDER[TIER_ORDER.indexOf(existingTier) + 1];
        escalated = true;
      }
    } else {
      // No escalation  -  condition holds at current tier
      finalTier = existingTier;
    }
  }

  // ── 3. Build new condition meta (preserve existing meta on escalation) ──────
  const newMeta = { ...(existingTier ? existing : {}), tier: finalTier };

  // weaponsSensors: pick a random weapon SECTION (weaponPosition) for the sensor-blind
  // overlay (blindedSectionId). Only sections with at least one weapon are eligible.
  // Persists on escalation (not re-rolled).
  if (locId === "weaponsSensors") {
    const weapons = targetActor.items?.filter(
      i => i.type === `${MODULE_ID}.component` && i.system?.slot === "weapon"
    ) ?? [];

    if (weapons.length > 0 && !newMeta.blindedSectionId) {
      const sections = [...new Set(weapons.map(w => {
        const pos = w.system?.weaponPosition ?? "prow";
        return (pos === "flank") ? (w.system?.weaponBay ?? "port") : pos;
      }))];
      newMeta.blindedSectionId = sections[Math.floor(Math.random() * sections.length)];
    }
  }

  // ── 4. Apply condition (and any extra hull damage) to the target actor ──────
  const updates = { [`system.conditions.${locId}`]: newMeta };
  if (extraHullDmg > 0) {
    const hullVal = targetActor.system?.hull?.value ?? 0;
    updates["system.hull.value"] = Math.min(hullMax, hullVal + extraHullDmg);
  }
  await targetActor.update(updates);

  // ── 5. Build crit result (returned to caller for embedding in fire-result card) ──
  const locLabel  = game.i18n.localize(locationEntry.label);
  const tierKey   = `SHIPCOMBAT.Crit.Tier.${finalTier.charAt(0).toUpperCase() + finalTier.slice(1)}`;
  const tierLabel = game.i18n.localize(tierKey);
  const condLabel = game.i18n.localize(condDef?.[finalTier]?.label ?? "");

  let detail = "";
  if (escalated) {
    detail = game.i18n.localize("SHIPCOMBAT.Crit.Escalated");
  } else if (extraHullDmg > 0) {
    detail = game.i18n.format("SHIPCOMBAT.Crit.MaxTierHull", { dmg: extraHullDmg });
  }

  const critResult = {
    hasCrit:      true,
    critRolls,
    locLabel,
    tierLabel,
    condLabel,
    finalTier,
    escalated,
    extraHullDmg,
    detail,
  };

  return critResult;
}
