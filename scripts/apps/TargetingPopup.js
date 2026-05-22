/**
 * TargetingPopup  -  popup listing valid targets within a weapon's cone of fire.
 *
 * Opened by the Ordnance Master when a fire-mode button is clicked.
 * Filters enemy tokens by the weapon's arc (position + degreeOfFire),
 * computes range zone + accuracy modifiers, and lists each valid target
 * with a "Fire" confirmation button.
 */
import { MODULE_ID, CORE_MODULE_ID, MACRO_FIRE_TIERS, LANCE_CHARGE_TIERS, buildChargeTiers } from "../constants.js";
import { emitToGM } from "../socket.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { THEME, pixi } from "../theme.js";
import { isOrdnance as _isOrdActorType } from "../actors/ordnance/ordnance-types.js";

// ── Geometry helpers ────────────────────────────────────────────────────────

const ANGULAR_OFFSETS = {
  prow:       0,
  dorsal:     0,
  port:      -Math.PI / 2,
  starboard:  Math.PI / 2,
};

/**
 * Normalise an angle to [−π, +π].
 */
function _normAngle(a) {
  while (a >  Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Test whether a target point is within a weapon's arc cone.
 *
 * @param {number} cx      Ship centre X
 * @param {number} cy      Ship centre Y
 * @param {number} heading Ship heading in radians (0 = right, rotated by −90° from token rotation)
 * @param {object} weapon  The weapon item
 * @param {number} tx      Target centre X
 * @param {number} ty      Target centre Y
 * @returns {{ inArc: boolean, distance: number, angleDelta: number }}
 */
export function testArc(cx, cy, heading, weapon, tx, ty) {
  const sys     = weapon.system;
  const pos     = sys.weaponPosition ?? "prow";
  const bay     = sys.weaponBay ?? "port";
  const sideKey = pos === "flank" ? bay : pos;
  const offset  = ANGULAR_OFFSETS[sideKey] ?? 0;

  const centreAngle = heading + offset;
  const halfSpan    = ((Number(sys.degreeOfFire) || 0) / 2) * (Math.PI / 180);

  const dx = tx - cx;
  const dy = ty - cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angleToTarget = Math.atan2(dy, dx);
  const angleDelta = Math.abs(_normAngle(angleToTarget - centreAngle));

  return {
    inArc: angleDelta <= halfSpan && halfSpan > 0,
    distance,
    angleDelta,
  };
}

/**
 * Classify a target into a hit zone.
 *   Zone 1: close range (within autoScanRange AND weapon range  -  no extra bonus)
 *   Zone 2: normal      (within weapon range, roll at base sensor rating)
 *   Zone 3: extended    (beyond weapon range, −10 per band, limited by sensor rating)
 *   null:   out of range
 */
export function classifyZone(distSquares, weaponRange, sensor, step) {
  const _step     = step ?? SystemAdapter.current.getModifierStepSize();
  const scanRange = Math.min(sensor.autoScanRange ?? 0, weaponRange);
  const bandSize  = sensor.bandSize ?? 0;
  const rating    = sensor.rating ?? 0;

  if (scanRange > 0 && distSquares <= scanRange) {
    return { zone: 1, modifier: 0, label: "SHIPCOMBAT.Targeting.Zone1" };
  }
  if (distSquares <= weaponRange) {
    return { zone: 2, modifier: 0, label: "SHIPCOMBAT.Targeting.Zone2" };
  }
  if (bandSize > 0 && rating > 0) {
    const bands    = Math.ceil((distSquares - weaponRange) / bandSize);
    const maxBands = Math.floor(rating / _step);
    if (bands > maxBands) return null; // beyond maximum reach
    const penalty  = bands * -_step;
    return { zone: 3, modifier: penalty, label: "SHIPCOMBAT.Targeting.Zone3" };
  }
  return null;  // out of range
}

/**
 * Determine the quadrant a shot hits from the target's perspective.
 *   Uses the angle from target's heading to the incoming attack vector.
 */
export function getHitQuadrant(targetRotation, attackAngle) {
  const targetHeading = (targetRotation - 90) * (Math.PI / 180);
  const incoming = _normAngle(attackAngle - targetHeading + Math.PI);
  const deg = incoming * (180 / Math.PI);

  if (deg >= -45 && deg < 45)   return "bow";
  if (deg >= 45 && deg < 135)   return "starboard";
  if (deg >= -135 && deg < -45) return "port";
  return "stern";
}

// ── Popup class ──────────────────────────────────────────────────────────────

export class TargetingPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  /** @type {object} Weapon item reference */
  weapon = null;
  /** @type {string} Fire mode ID */
  fireMode = null;
  /** @type {string} Weapon type */
  weaponType = null;
  /** @type {object[]} Computed target list */
  targets = [];
  /** @type {boolean} Whether the Overcharge mode is active for plasma weapons */
  isOvercharged = false;

  constructor(options = {}) {
    super(options);
    this.weapon     = options.weapon;
    this.fireMode   = options.fireMode;
    this.weaponType = options.weapon?.system?.resourceType ?? "ammo";
  }

  static DEFAULT_OPTIONS = {
    id: "shipcombat-targeting-popup",
    classes: ["shipcombat-targeting-popup"],
    tag: "div",
    window: {
      title: "SHIPCOMBAT.Targeting.Title",
      resizable: false,
    },
    position: { width: 420, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/targeting-popup.hbs` },
  };

  /** Collect all valid targets within the weapon's arc and range. */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    // Use weapon.parent (the actor that owns the weapon)  -  NOT ShipCombatState.ship,
    // which can resolve to a different actor instance.
    const ship = this.weapon?.parent;
    if (!ship || !this.weapon) return { ...context, targets: [], weapon: null };

    const sys     = ship.system;
    const gunnerRes = sys.resources?.gunner ?? {};
    const tokens  = ship.getActiveTokens?.() ?? [];
    if (!tokens.length) return { ...context, targets: [], weapon: null };

    const token    = tokens[0];
    const gridSize = canvas.grid.size;
    const tokenW   = token.document.width  * gridSize;
    const tokenH   = token.document.height * gridSize;
    const cx       = token.x + tokenW / 2;
    const cy       = token.y + tokenH / 2;
    const heading  = (token.document.rotation - 90) * (Math.PI / 180);

    // Gather sensor stats from installed component (player ships) or flat fields (NPC ships)
    const sensorComp = ship.items.find(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "sensor"
    );
    const sensorEffects = sys.resources?.sensors?.effects ?? [];
    const rangeAmpActive = sensorEffects.some(e => e.actionId === "rangeAmplifier");
    const baseAutoScanRange = (sensorComp?.system?.autoScanRange ?? 0) || (sys.autoScanRange ?? 0);
    const bandExpanded = !!(sys.resources?.gunner?.sensorBandExpanded);
    const rawBandSize  = sensorComp?.system?.bandSize ?? sys.sensorBandSize ?? 0;
    const sensor = {
      rating:        sensorComp?.system?.rating ?? sys.sensorRating ?? 0,
      bandSize:      bandExpanded ? rawBandSize * 2 : rawBandSize,
      autoScanRange: rangeAmpActive ? baseAutoScanRange * 2 : baseAutoScanRange,
    };

    const weaponRange = Number(this.weapon.system.range) || 0;

    // Compute fire mode details
    const fireModeDetails = this._getFireModeDetails(gunnerRes);

    // Captain stance hit modifier (same for all targets in this popup)
    const adapter         = SystemAdapter.current;
    const step            = adapter.getModifierStepSize();
    const captainStance   = sys.resources?.captain?.stance ?? "none";
    const stanceHitMod    = captainStance === "aggressive" ? step : captainStance === "defensive" ? -step : 0;

    // Find valid target tokens: exclude own ship and own torpedoes / strike craft
    const shipTokenId = token.id;
    const candidates = canvas.tokens.placeables.filter(t => {
      if (!t.visible) return false;
      if (t.document.actor?.id === ship.id) return false;
      // Exclude own ordnance that was launched by this ship
      if (_isOrdActorType(t.document.actor) && t.document.actor.system?.parentShipTokenId === shipTokenId) return false;
      return true;
    });

    const targets = [];
    for (const candidate of candidates) {
      const cGridSize = canvas.grid.size;
      const cW = candidate.document.width  * cGridSize;
      const cH = candidate.document.height * cGridSize;
      const tx = candidate.x + cW / 2;
      const ty = candidate.y + cH / 2;

      const arc = testArc(cx, cy, heading, this.weapon, tx, ty);
      if (!arc.inArc) continue;

      const distSquares = arc.distance / gridSize;
      const zone = classifyZone(distSquares, weaponRange, sensor);
      if (!zone) continue;

      // Lock-tier gate: Gunner can only fire at targets with lock ≥ 1
      // NPC ships are treated as Lock 3 by default (no augur sensor system).
      const lockTier = ship.type === `${MODULE_ID}.npcShip`
        ? 3
        : ShipCombatState.getEffectiveLockTier(candidate.id, distSquares);
      if (lockTier < 1) continue;

      const attackAngle = Math.atan2(ty - cy, tx - cx);
      const hitQuadrant = getHitQuadrant(
        candidate.document.rotation ?? 0,
        attackAngle,
      );

      // Lock-tier accuracy bonuses
      let lockAccuracyBonus = 0;
      if (lockTier >= 4) {
        lockAccuracyBonus = step;        // +1 step accuracy at Lock 4
      }

      // Zone 3 penalty negated at Lock ≥ 4
      const finalZoneMod = (zone.zone === 3 && lockTier >= 4) ? 0 : zone.modifier;

      // Get target system data (must be before any reference to targetSys)
      const targetSys = candidate.document.actor?.system ?? {};

      // Total accuracy = sensor rating + zone mod + fire mode mod + lock bonus + SL allocation + weapon hit rating + stance
      const allocAccuracy = sys.resources?.gunner?.allocAccuracy ?? 0;
      const weaponHitMod  = this.weapon?.system?.traits?.hitRatingModifier ?? 0;

      // BDA fire correction: adjustBearing grants +1 step to this specific target+weapon
      // Ranging Fire bonus: grants +1 step to ALL weapons against the bracketed target
      const fcRaw = sys.resources?.sensors?.fireCorrection ?? null;
      const correctionMatches = fcRaw
        && fcRaw.targetTokenId === candidate.id
        && (fcRaw.type === "rangingFireBonus" || !fcRaw.weaponId || fcRaw.weaponId === this.weapon.id);
      const adjustBearingBonus    = (correctionMatches && fcRaw.type === "adjustBearing") ? step : 0;
      const rangingFireBonus      = (correctionMatches && fcRaw.type === "rangingFireBonus") ? step : 0;
      const activeCorrection      = correctionMatches ? fcRaw : null;

      // Battle Clarity: captain core action grants +1 step accuracy + 2 shield pierce on the nominated target
      const priorityTargetId     = sys.resources?.captain?.priorityTargetId ?? null;
      const battleClarityBonus   = (priorityTargetId && priorityTargetId === candidate.id) ? step : 0;
      const battleClarityPierce  = (priorityTargetId && priorityTargetId === candidate.id) ? 2 : 0;

      const halfStep     = step / 2;
      const captainHitBonus = sys.resources?.gunner?.captainHitBonus ?? 0;
      const allocEvasion    = targetSys.resources?.pilot?.allocEvasion ?? 0;
      const evasionPenalty  = allocEvasion * -halfStep;
      let totalAccuracy = sensor.rating + finalZoneMod + (fireModeDetails.hitMod ?? 0) + lockAccuracyBonus + (allocAccuracy * halfStep) + weaponHitMod + adjustBearingBonus + rangingFireBonus + battleClarityBonus + stanceHitMod + captainHitBonus + evasionPenalty;

      // Zone 1 (close scan): system-specific bonus (IM: halve the miss chance)
      let zone1Bonus = 0;
      if (zone.zone === 1) {
        zone1Bonus = adapter.computeZone1Bonus(totalAccuracy);
        totalAccuracy += zone1Bonus;
      }

      // Build accuracy breakdown tooltip
      const breakdownParts = [`Base Sensor: ${adapter.formatTargetNumber(sensor.rating)}`];
      if (finalZoneMod !== 0) breakdownParts.push(`Distance: ${adapter.formatModifier(finalZoneMod)}`);
      if ((fireModeDetails.hitMod ?? 0) !== 0) breakdownParts.push(`Fire Mode: ${adapter.formatModifier(fireModeDetails.hitMod ?? 0)}`);
      if (stanceHitMod !== 0) breakdownParts.push(`Stance: ${adapter.formatModifier(stanceHitMod)}`);
      if (lockAccuracyBonus !== 0) breakdownParts.push(`Lock Tier: ${adapter.formatModifier(lockAccuracyBonus)}`);
      if (allocAccuracy !== 0) breakdownParts.push(`Accuracy SL: ${adapter.formatModifier(allocAccuracy * halfStep)}`);
      if (weaponHitMod !== 0) breakdownParts.push(`Weapon Rating: ${adapter.formatModifier(weaponHitMod)}`);
      if (adjustBearingBonus !== 0) breakdownParts.push(`Adj. Bearing: ${adapter.formatModifier(adjustBearingBonus)}`);
      if (rangingFireBonus !== 0) breakdownParts.push(`Ranging Fire: ${adapter.formatModifier(rangingFireBonus)}`);
      if (battleClarityBonus !== 0) breakdownParts.push(`Battle Clarity: ${adapter.formatModifier(battleClarityBonus)}`);
      if (captainHitBonus !== 0) breakdownParts.push(`Insp. Targeting: ${adapter.formatModifier(captainHitBonus)}`);
      if (evasionPenalty  !== 0) breakdownParts.push(`Target Evasion: ${adapter.formatModifier(evasionPenalty)}`);
      if (zone1Bonus !== 0) breakdownParts.push(`Close Scan: ${adapter.formatModifier(zone1Bonus)}`);
      const accuracyTooltip = breakdownParts.join("\n");

      // Get target's armour for the hit quadrant  -  only visible at Lock 3+
      const targetArmour = targetSys.armour?.[hitQuadrant] ?? 0;
      const showArmour   = lockTier >= 3 && targetArmour > 0;

      // Show exact range only for extended zone (zone 3)
      const showDistance = zone.zone === 3;

      targets.push({
        tokenId:      candidate.id,
        name:         lockTier >= 2 ? (candidate.document.name ?? "Unknown") : (candidate.document.name ?? game.i18n.localize("SHIPCOMBAT.Targeting.UnknownContact")),
        img:          (() => {
          if (lockTier === 1) {
            const at = candidate.document.actor?.type ?? "";
            if (_isOrdActorType(candidate.document.actor)) {
              // Simple dot blip for L1 ordnance (no outer ring)
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="7" fill="#ff4444"/></svg>`;
              return `data:image/svg+xml,${encodeURIComponent(svg)}`;
            }
          }
          return candidate.document.texture?.src ?? "icons/svg/mystery-man.svg";
        })(),
        classification: (() => {
          if (lockTier < 1) return null;
          const cls = candidate.document.actor?.system?.classification ?? "";
          if (!cls) return null;
          const found = [{ value: "", label: "" }, { value: "fighter", label: "Fighter" }, { value: "picket", label: "Picket Ship" }, { value: "cutter", label: "Cutter" }, { value: "sloop", label: "Sloop" }, { value: "destroyer", label: "Destroyer" }, { value: "frigate", label: "Frigate" }, { value: "lightCruiser", label: "Light Cruiser" }, { value: "cruiser", label: "Cruiser" }, { value: "battlecruiser", label: "Battlecruiser" }, { value: "grandCruiser", label: "Grand Cruiser" }, { value: "battleship", label: "Battleship" }, { value: "capitalShip", label: "Capital Ship" }, { value: "planetKiller", label: "Planet Killer" }, { value: "other", label: "Other" }].find(c => c.value === cls);
          return found?.label ?? cls;
        })(),
        bearing: (() => {
          if (lockTier < 1) return null;
          const attackAngle = Math.atan2(ty - cy, tx - cx);
          return Math.round((attackAngle * 180 / Math.PI + 90 + 360) % 360);
        })(),
        isL1:         lockTier === 1,
        distance:     Math.round(distSquares * 10) / 10,
        showDistance,
        zone:         zone.zone,
        zoneLabel:    game.i18n.localize(zone.label),
        zoneModifier: finalZoneMod,
        hitQuadrant,
        hitQuadrantLabel: game.i18n.localize(`SHIPCOMBAT.Sector.${hitQuadrant.charAt(0).toUpperCase() + hitQuadrant.slice(1)}`),
        totalAccuracy,
        accuracyLabel: adapter.formatAccuracyDisplay(totalAccuracy),
        isAutoHit:    false,
        targetArmour,
        showArmour,
        lockTier,
        lockAccuracyBonus,
        adjustBearingBonus,
        rangingFireBonus,
        battleClarityBonus,
        battleClarityPierce,
        activeCorrection,
        accuracyTooltip,
        // Store positions for attack vector arrow
        targetX:  tx,
        targetY:  ty,
      });
    }

    // Sort by distance
    targets.sort((a, b) => a.distance - b.distance);
    this.targets = targets;
    this._shipPos = { x: cx, y: cy };

    return {
      ...context,
      weapon: this.weapon,
      weaponName: this.weapon.name,
      weaponType: this.weaponType,
      fireMode: this.fireMode,
      fireModeLabel: game.i18n.localize(fireModeDetails.label ?? "SHIPCOMBAT.Gunner.Fire"),
      fireModeDetails,
      targets,
      noTargets: targets.length === 0,
      hasOvercharge: !!(this.weapon?.system?.traits?.overcharge) && this.weaponType === "heat",
      isOvercharged: this.isOvercharged,
      overchargedTraits: this._buildOverchargedTraits(),
    };
  }

  /** Get details about the active fire mode. */
  _getFireModeDetails(gunnerRes) {
    const fp = 0;
    const baseSalvo = Number(this.weapon?.system?.salvoSize) || 1;

    if (this.weaponType === "ammo") {
      const tier = MACRO_FIRE_TIERS.find(t => t.id === this.fireMode);
      if (!tier) return { label: "SHIPCOMBAT.Gunner.Fire", salvoSize: 0, cost: 0, hitMod: 0 };
      const totalSalvo = Math.ceil(baseSalvo * tier.salvoMult);
      return {
        label:   tier.label,
        salvoSize: totalSalvo,
        cost:    tier.ammo,
        hitMod:  tier.hitMod,
        resource: "ammo",
        resourceLabel: game.i18n.localize("SHIPCOMBAT.Gunner.Ammo"),
      };
    }

    if (this.weaponType === "heat") {
      const traits = this.weapon?.system?.traits ?? {};
      const heatPerShot = traits.overcharge && this.isOvercharged ? 2 : 1;
      const heatCost = heatPerShot * baseSalvo;
      const dmgBonus = fp;
      return {
        label:   "SHIPCOMBAT.Gunner.PlasmaShot",
        salvoSize: baseSalvo,
        cost:    heatCost,
        hitMod:  0,
        resource: "heat",
        resourceLabel: game.i18n.localize("SHIPCOMBAT.Gunner.Heat"),
        dmgBonus,
      };
    }

    if (this.weaponType === "power") {
      const charge = gunnerRes.power ?? 0;
      const step = this.weapon?.system?.chargeStep || 5;
      const tiers = buildChargeTiers(step);
      const maxCharge = step * 4;
      const effectiveCharge = Math.min(charge, maxCharge);
      const tier = tiers.find(t => effectiveCharge >= t.min && effectiveCharge <= t.max);
      return {
        label:      tier?.label ?? "SHIPCOMBAT.Gunner.LanceFire",
        salvoSize:  baseSalvo,
        cost:       Math.min(charge, maxCharge),
        hitMod:     0,
        resource:   "power",
        resourceLabel: game.i18n.localize("SHIPCOMBAT.Gunner.Power"),
        multiplier: tier?.multiplier ?? 0,
        power: effectiveCharge,
      };
    }

    // pointDefense
    return {
      label:    "SHIPCOMBAT.Gunner.Fire",
      salvoSize: baseSalvo,
      cost:     0,
      hitMod:   0,
      resource: "none",
      resourceLabel: "",
    };
  }

  /** Build a list of trait entries showing base and overcharged (3×) values. */
  _buildOverchargedTraits() {
    const traits = this.weapon?.system?.traits ?? {};
    const entries = [];
    const MULT = 3;
    if ((traits.shieldBurn ?? 0) > 0) {
      entries.push({
        label: game.i18n.localize("SHIPCOMBAT.Trait.ShieldBurn"),
        base: traits.shieldBurn,
        oc:   traits.shieldBurn * MULT,
      });
    }
    if ((traits.rend ?? 0) > 0) {
      entries.push({
        label: game.i18n.localize("SHIPCOMBAT.Trait.Rend"),
        base: traits.rend,
        oc:   traits.rend * MULT,
      });
    }
    if ((traits.armourPenetration ?? 0) > 0) {
      entries.push({
        label: game.i18n.localize("SHIPCOMBAT.Trait.ArmourPenetration"),
        base: traits.armourPenetration,
        oc:   traits.armourPenetration * MULT,
      });
    }
    if ((traits.devastating ?? 0) > 0) {
      entries.push({
        label: game.i18n.localize("SHIPCOMBAT.Trait.Devastating"),
        base: traits.devastating,
        oc:   traits.devastating * MULT,
      });
    }
    return entries;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // ── Live accuracy refresh ────────────────────────────────────────────────
    // Re-render when the ship actor (state, SL allocation, stance, etc.) or any
    // token (position / rotation change affects zone and hit quadrant) changes.
    // Store hook IDs so we can deregister on close.
    if (!this._liveHooks) {
      const _rerender = foundry.utils.debounce(() => {
        if (this.rendered) this.render();
      }, 100);
      this._liveHooks = [
        Hooks.on("updateActor",  _rerender),
        Hooks.on("updateToken",  _rerender),
        Hooks.on("refreshToken", _rerender),
      ];
      this._rerenderFn = _rerender;
    }

    // Wire up fire buttons
    this.element.querySelectorAll("[data-action='confirmFire']").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        const tokenId = btn.dataset.tokenId;
        this._onConfirmFire(tokenId);
      });
    });

    // Wire up overcharge toggle
    const overchargeToggle = this.element.querySelector("[data-action='toggleOvercharge']");
    if (overchargeToggle) {
      overchargeToggle.addEventListener("click", ev => {
        ev.preventDefault();
        this.isOvercharged = !this.isOvercharged;
        this.render();
      });
    }

    // Wire up hover for attack vector arrow
    this.element.querySelectorAll("[data-token-id]").forEach(row => {
      if (row.tagName === "BUTTON") return; // skip fire buttons
      row.addEventListener("mouseenter", () => {
        const tokenId = row.dataset.tokenId;
        const target = this.targets.find(t => t.tokenId === tokenId);
        if (target) this._showArrow(target);
      });
      row.addEventListener("mouseleave", () => {
        this._hideArrow();
      });
    });
  }

  /** Draw an attack vector arrow from ship to target on the canvas. */
  _showArrow(target) {
    this._hideArrow();
    if (!canvas?.ready || !this._shipPos) return;

    const sx = this._shipPos.x;
    const sy = this._shipPos.y;
    const tx = target.targetX;
    const ty = target.targetY;

    const container = new PIXI.Container();
    container.name = "shipcombat-attack-vector";
    container.eventMode = "none";
    canvas.tokens.addChild(container);

    const g = new PIXI.Graphics();
    container.addChild(g);

    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    const nx = dx / len;
    const ny = dy / len;

    // Shorten line slightly so arrowhead sits at the target
    const headLen = Math.min(20, len * 0.15);
    const endX = tx - nx * headLen;
    const endY = ty - ny * headLen;

    // Shaft: dashed effect via dotted line segments
    g.lineStyle(2.5, pixi(THEME.overlay.attackVector), 0.8);
    g.moveTo(sx, sy);
    g.lineTo(endX, endY);

    // Arrowhead
    const perpX = -ny;
    const perpY =  nx;
    const hw = headLen * 0.5;

    g.beginFill(pixi(THEME.overlay.attackVector), 0.8);
    g.lineStyle(0);
    g.drawPolygon([
      tx, ty,
      endX + perpX * hw, endY + perpY * hw,
      endX - perpX * hw, endY - perpY * hw,
    ]);
    g.endFill();

    this._arrowContainer = container;
  }

  /** Remove the attack vector arrow from the canvas. */
  _hideArrow() {
    if (this._arrowContainer && !this._arrowContainer.destroyed) {
      this._arrowContainer.destroy({ children: true });
    }
    this._arrowContainer = null;
  }

  /** Clean up arrow and live hooks on close. */
  _onClose(options) {
    this._hideArrow();
    if (this._liveHooks) {
      Hooks.off("updateActor",  this._rerenderFn);
      Hooks.off("updateToken",  this._rerenderFn);
      Hooks.off("refreshToken", this._rerenderFn);
      this._liveHooks = null;
      this._rerenderFn = null;
    }
    super._onClose?.(options);
  }

  async _onConfirmFire(tokenId) {
    const target = this.targets.find(t => t.tokenId === tokenId);
    if (!target) return;

    // Compute salvo size for this fire mode
    const ship = this.weapon?.parent;
    const gunnerRes = ship?.system?.resources?.gunner ?? {};
    const fireModeDetails = this._getFireModeDetails(gunnerRes);

    emitToGM("fireWeapon", {
      actorId:      this.weapon.parent?.id,
      weaponId:     this.weapon.id,
      fireMode:     this.fireMode,
      targetToken:  tokenId,
      hitQuadrant:  target.hitQuadrant,
      accuracy:     target.totalAccuracy === "Auto" ? 999 : target.totalAccuracy,
      isAutoHit:    target.isAutoHit,
      zone:         target.zone,
      salvoSize:    fireModeDetails.salvoSize ?? 1,
      isOvercharged: this.isOvercharged,
      fireCorrection: target.activeCorrection ?? null,
    });

    this.close();
  }
}
