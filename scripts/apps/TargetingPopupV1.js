/**
 * TargetingPopupV1  -  AppV1 equivalent of TargetingPopup.
 *
 * Selected automatically by Core's _popupClass() helper when the active adapter
 * sets `useApplicationV1 = true` (e.g. SF2e).
 */
import { MODULE_ID, CORE_MODULE_ID, MACRO_FIRE_TIERS, buildChargeTiers }
  from "../constants.js";
import { emitToGM }
  from "../socket.js";
import { ShipCombatState }
  from "../state/ShipCombatState.js";
import { SystemAdapter }
  from "../systems/SystemAdapter.js";
import { THEME, pixi }
  from "../theme.js";
import { isOrdnance }
  from "../actors/ordnance/ordnance-types.js";
import { classifyZone, getHitQuadrant, testArc }
  from "./TargetingPopup.js";

// ── TargetingPopupV1 ─────────────────────────────────────────────────────────

export class TargetingPopupV1 extends foundry.appv1.api.Application {

  weapon          = null;
  fireMode        = null;
  weaponType      = null;
  targets         = [];
  isOvercharged   = false;
  _shipPos        = null;
  _liveHooks      = null;
  _rerenderFn     = null;
  _arrowContainer = null;

  constructor(options = {}) {
    super(options);
    this.weapon     = options.weapon;
    this.fireMode   = options.fireMode;
    this.weaponType = options.weapon?.system?.resourceType ?? "ammo";
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "shipcombat-targeting-popup",
      classes:   ["shipcombat-targeting-popup"],
      template:  `modules/${CORE_MODULE_ID}/templates/apps/targeting-popup.hbs`,
      title:     game.i18n.localize("SHIPCOMBAT.Targeting.Title"),
      width:     420,
      height:    "auto",
      resizable: false,
    });
  }

  async getData(options = {}) {
    const context = await super.getData(options);

    const ship = this.weapon?.parent;
    if (!ship || !this.weapon) return { ...context, targets: [], weapon: null };

    const sys       = ship.system;
    const gunnerRes = sys.resources?.gunner ?? {};
    const tokens    = ship.getActiveTokens?.() ?? [];
    if (!tokens.length) return { ...context, targets: [], weapon: null };

    const token    = tokens[0];
    const gridSize = canvas.grid.size;
    const tokenW   = token.document.width  * gridSize;
    const tokenH   = token.document.height * gridSize;
    const cx       = token.x + tokenW / 2;
    const cy       = token.y + tokenH / 2;
    const heading  = (token.document.rotation + 90) * (Math.PI / 180);

    const sensorComp = ship.items.find(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "sensor"
    );
    const sensorEffects  = sys.resources?.sensors?.effects ?? [];
    const rangeAmpActive = sensorEffects.some(e => e.actionId === "rangeAmplifier");
    const baseAutoScanRange = (sensorComp?.system?.autoScanRange ?? 0)
      || (sys.autoScanRange ?? 0);
    const bandExpanded = !!(sys.resources?.gunner?.sensorBandExpanded);
    const rawBandSize  = sensorComp?.system?.bandSize ?? sys.sensorBandSize ?? 0;
    const sensor = {
      rating:        sensorComp?.system?.rating ?? sys.sensorRating ?? 0,
      bandSize:      bandExpanded ? rawBandSize * 2 : rawBandSize,
      autoScanRange: rangeAmpActive ? baseAutoScanRange * 2 : baseAutoScanRange,
    };

    const weaponRange     = Number(this.weapon.system.range) || 0;
    const fireModeDetails = this._getFireModeDetails(gunnerRes);

    const adapter       = SystemAdapter.current;
    const step          = adapter.getModifierStepSize();
    const hbs           = adapter.getHitBonusStep();  // fixed hit-bonus step (lock, ranging, BDA, battle clarity)
    const captainStance = sys.resources?.captain?.stance ?? "none";
    const stanceHitMod  = captainStance === "aggressive" ? step
                        : captainStance === "defensive"  ? -step : 0;

    // Hostile sensor effects on the FIRING ship (registered by an enemy Sensors
    // Officer): Disruption penalises all rolls by the disruptor's sensor hit
    // modifier (min one range band); Overcharge limits weapons to the ship's
    // own auto-scan range.
    const inboundOvercharged = ShipCombatState.hasSensorEffectOn(ship, "sensorOvercharge");
    const disruptionPenalty  = -ShipCombatState.getDisruptionPenalty(ship);

    // Find valid target tokens: exclude own ship and own torpedoes / strike craft
    const shipTokenId = token.id;
    const candidates = canvas.tokens.placeables.filter(t => {
      if (!t.visible) return false;
      if (t.document.actor?.id === ship.id) return false;
      // Exclude own ordnance that was launched by this ship
      if (isOrdnance(t.document.actor) && t.document.actor.system?.parentShipTokenId === shipTokenId) return false;
      return true;
    });

    const targets = [];
    for (const candidate of candidates) {
      const cW = candidate.document.width  * gridSize;
      const cH = candidate.document.height * gridSize;
      const tx = candidate.x + cW / 2;
      const ty = candidate.y + cH / 2;

      const arc = testArc(cx, cy, heading, this.weapon, tx, ty);
      if (!arc.inArc) continue;

      const distSquares = arc.distance / gridSize;
      const zone = classifyZone(distSquares, weaponRange, sensor);
      if (!zone) continue;
      // Sensor Overcharge: this ship's weapons can only fire within auto-scan range
      if (inboundOvercharged && distSquares > sensor.autoScanRange) continue;

      const lockTier = ship.type === `${MODULE_ID}.npcShip`
        ? 3
        : ShipCombatState.getEffectiveLockTier(candidate.id, distSquares);
      if (lockTier < 1) continue;

      const attackAngle = Math.atan2(ty - cy, tx - cx);
      const hitQuadrant = getHitQuadrant(candidate.document.rotation ?? 0, attackAngle);

      const lockAccuracyBonus = lockTier >= 4 ? hbs : 0;
      const finalZoneMod      = (zone.zone === 3 && lockTier >= 4) ? 0 : zone.modifier;

      const targetSys       = candidate.document.actor?.system ?? {};
      const allocAccuracy   = sys.resources?.gunner?.allocAccuracy ?? 0;
      const weaponHitMod    = this.weapon?.system?.traits?.hitRatingModifier ?? 0;

      const fcRaw = sys.resources?.sensors?.fireCorrection ?? null;
      const correctionMatches = fcRaw
        && fcRaw.targetTokenId === candidate.id
        && (fcRaw.type === "rangingFireBonus" || !fcRaw.weaponId || fcRaw.weaponId === this.weapon.id);
      const adjustBearingBonus  = (correctionMatches && fcRaw.type === "adjustBearing")    ? hbs : 0;
      const rangingFireBonus    = (correctionMatches && fcRaw.type === "rangingFireBonus")  ? hbs : 0;
      const activeCorrection    = correctionMatches ? fcRaw : null;

      const priorityTargetId   = sys.resources?.captain?.priorityTargetId ?? null;
      const battleClarityBonus  = (priorityTargetId && priorityTargetId === candidate.id) ? hbs : 0;
      const battleClarityPierce = (priorityTargetId && priorityTargetId === candidate.id) ? 2    : 0;

      const halfStep        = step / 2;
      const captainHitBonus = sys.resources?.gunner?.captainHitBonus ?? 0;
      const allocEvasion    = targetSys.resources?.pilot?.allocEvasion ?? 0;
      // d20 adapters fold evasion into the target's AC (getTargetAC); applying
      // it to accuracy as well would double-count it. Only roll-under systems
      // (getTargetAC → null) take it as an accuracy penalty.
      const evasionPenalty  = adapter.getTargetAC(candidate.document.actor) === null
        ? allocEvasion * -halfStep
        : 0;

      let totalAccuracy = sensor.rating
        + finalZoneMod
        + (fireModeDetails.hitMod ?? 0)
        + lockAccuracyBonus
        + (allocAccuracy * halfStep)
        + weaponHitMod
        + adjustBearingBonus
        + rangingFireBonus
        + battleClarityBonus
        + stanceHitMod
        + captainHitBonus
        + evasionPenalty
        + disruptionPenalty;

      let zone1Bonus = 0;
      if (zone.zone === 1) {
        zone1Bonus     = adapter.computeZone1Bonus(totalAccuracy);
        totalAccuracy += zone1Bonus;
      }

      const breakdownParts = [`Base Sensor: ${adapter.formatTargetNumber(sensor.rating)}`];
      if (finalZoneMod !== 0)                 breakdownParts.push(`Distance: ${adapter.formatModifier(finalZoneMod)}`);
      if ((fireModeDetails.hitMod ?? 0) !== 0) breakdownParts.push(`Fire Mode: ${adapter.formatModifier(fireModeDetails.hitMod ?? 0)}`);
      if (stanceHitMod !== 0)                 breakdownParts.push(`Stance: ${adapter.formatModifier(stanceHitMod)}`);
      if (lockAccuracyBonus !== 0)            breakdownParts.push(`Lock Tier: ${adapter.formatModifier(lockAccuracyBonus)}`);
      if (allocAccuracy !== 0)                breakdownParts.push(`Accuracy SL: ${adapter.formatModifier(allocAccuracy * halfStep)}`);
      if (weaponHitMod !== 0)                 breakdownParts.push(`Weapon Rating: ${adapter.formatModifier(weaponHitMod)}`);
      if (adjustBearingBonus !== 0)           breakdownParts.push(`Adj. Bearing: ${adapter.formatModifier(adjustBearingBonus)}`);
      if (rangingFireBonus !== 0)             breakdownParts.push(`Ranging Fire: ${adapter.formatModifier(rangingFireBonus)}`);
      if (battleClarityBonus !== 0)           breakdownParts.push(`Battle Clarity: ${adapter.formatModifier(battleClarityBonus)}`);
      if (captainHitBonus !== 0)              breakdownParts.push(`Insp. Targeting: ${adapter.formatModifier(captainHitBonus)}`);
      if (evasionPenalty !== 0)               breakdownParts.push(`Target Evasion: ${adapter.formatModifier(evasionPenalty)}`);
      if (disruptionPenalty !== 0)            breakdownParts.push(`Sensor Disruption: ${adapter.formatModifier(disruptionPenalty)}`);
      if (zone1Bonus !== 0)                   breakdownParts.push(`Close Scan: ${adapter.formatModifier(zone1Bonus)}`);
      const accuracyTooltip = breakdownParts.join("\n");

      const targetArmour = targetSys.armour?.[hitQuadrant] ?? 0;
      const showArmour   = lockTier >= 3 && targetArmour > 0;
      const showDistance = zone.zone === 3;
      const isAutoHit    = false;

      targets.push({
        tokenId: candidate.id,
        name:    lockTier >= 2
          ? (candidate.document.name ?? "Unknown")
          : (candidate.document.name ?? game.i18n.localize("SHIPCOMBAT.Targeting.UnknownContact")),
        img: (() => {
          if (lockTier === 1 && isOrdnance(candidate.document.actor)) {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="7" fill="#ff4444"/></svg>`;
            return `data:image/svg+xml,${encodeURIComponent(svg)}`;
          }
          return candidate.document.texture?.src ?? "icons/svg/mystery-man.svg";
        })(),
        classification: (() => {
          if (lockTier < 1) return null;
          const cls = candidate.document.actor?.system?.classification ?? "";
          if (!cls) return null;
          const CLASSES = [
            { value: "fighter",      label: "Fighter" },
            { value: "picket",       label: "Picket Ship" },
            { value: "cutter",       label: "Cutter" },
            { value: "sloop",        label: "Sloop" },
            { value: "destroyer",    label: "Destroyer" },
            { value: "frigate",      label: "Frigate" },
            { value: "lightCruiser", label: "Light Cruiser" },
            { value: "cruiser",      label: "Cruiser" },
            { value: "battlecruiser",label: "Battlecruiser" },
            { value: "grandCruiser", label: "Grand Cruiser" },
            { value: "battleship",   label: "Battleship" },
            { value: "capitalShip",  label: "Capital Ship" },
            { value: "planetKiller", label: "Planet Killer" },
            { value: "other",        label: "Other" },
          ];
          return CLASSES.find(c => c.value === cls)?.label ?? cls;
        })(),
        bearing: (() => {
          if (lockTier < 1) return null;
          const a = Math.atan2(ty - cy, tx - cx);
          return Math.round((a * 180 / Math.PI + 90 + 360) % 360);
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
        accuracyLabel: isAutoHit ? game.i18n.localize("SHIPCOMBAT.Targeting.Auto") : adapter.formatAccuracyDisplay(totalAccuracy),
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
        targetX: tx,
        targetY: ty,
      });
    }

    targets.sort((a, b) => a.distance - b.distance);
    this.targets  = targets;
    this._shipPos = { x: cx, y: cy };

    return {
      ...context,
      weapon:       this.weapon,
      weaponName:   this.weapon.name,
      weaponType:   this.weaponType,
      fireMode:     this.fireMode,
      fireModeLabel: game.i18n.localize(fireModeDetails.label ?? "SHIPCOMBAT.Gunner.Fire"),
      fireModeDetails,
      targets,
      noTargets:    targets.length === 0,
      hasOvercharge: !!(this.weapon?.system?.traits?.overcharge) && this.weaponType === "heat",
      isOvercharged: this.isOvercharged,
      overchargedTraits: this._buildOverchargedTraits(),
    };
  }

  activateListeners($html) {
    super.activateListeners($html);
    const html = $html[0];

    // Register live refresh hooks only once (persist across re-renders).
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

    html.querySelectorAll("[data-action='confirmFire']").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        this._onConfirmFire(btn.dataset.tokenId);
      });
    });

    const ocToggle = html.querySelector("[data-action='toggleOvercharge']");
    if (ocToggle) {
      ocToggle.addEventListener("click", ev => {
        ev.preventDefault();
        this.isOvercharged = !this.isOvercharged;
        this.render();
      });
    }

    html.querySelectorAll("[data-token-id]").forEach(row => {
      if (row.tagName === "BUTTON") return;
      row.addEventListener("mouseenter", () => {
        const target = this.targets.find(t => t.tokenId === row.dataset.tokenId);
        if (target) this._showArrow(target);
      });
      row.addEventListener("mouseleave", () => this._hideArrow());
    });
  }

  async close(options = {}) {
    this._hideArrow();
    if (this._liveHooks) {
      Hooks.off("updateActor",  this._rerenderFn);
      Hooks.off("updateToken",  this._rerenderFn);
      Hooks.off("refreshToken", this._rerenderFn);
      this._liveHooks  = null;
      this._rerenderFn = null;
    }
    return super.close(options);
  }

  _getFireModeDetails(gunnerRes) {
    const fp        = 0;
    const baseSalvo = Number(this.weapon?.system?.salvoSize) || 1;

    if (this.weaponType === "ammo") {
      const tier = MACRO_FIRE_TIERS.find(t => t.id === this.fireMode);
      if (!tier) return { label: "SHIPCOMBAT.Gunner.Fire", salvoSize: 0, cost: 0, hitMod: 0 };
      return {
        label:         tier.label,
        salvoSize:     Math.ceil(baseSalvo * tier.salvoMult),
        cost:          tier.ammo,
        hitMod:        tier.hitMod,
        resource:      "ammo",
        resourceLabel: game.i18n.localize("SHIPCOMBAT.Gunner.Ammo"),
      };
    }

    if (this.weaponType === "heat") {
      const traits      = this.weapon?.system?.traits ?? {};
      const heatPerShot = traits.overcharge && this.isOvercharged ? 2 : 1;
      return {
        label:         "SHIPCOMBAT.Gunner.PlasmaShot",
        salvoSize:     baseSalvo,
        cost:          heatPerShot * baseSalvo,
        hitMod:        0,
        resource:      "heat",
        resourceLabel: game.i18n.localize("SHIPCOMBAT.Gunner.Heat"),
        dmgBonus:      fp,
      };
    }

    if (this.weaponType === "power") {
      const charge          = gunnerRes.power ?? 0;
      const chargeStep      = this.weapon?.system?.chargeStep || 5;
      const tiers           = buildChargeTiers(chargeStep);
      const maxCharge       = chargeStep * 4;
      const effectiveCharge = Math.min(charge, maxCharge);
      const tier            = tiers.find(t => effectiveCharge >= t.min && effectiveCharge <= t.max);
      return {
        label:         tier?.label ?? "SHIPCOMBAT.Gunner.LanceFire",
        salvoSize:     baseSalvo,
        cost:          Math.min(charge, maxCharge),
        hitMod:        0,
        resource:      "power",
        resourceLabel: game.i18n.localize("SHIPCOMBAT.Gunner.Power"),
        multiplier:    tier?.multiplier ?? 0,
        power:         effectiveCharge,
      };
    }

    // pointDefense / unknown
    return { label: "SHIPCOMBAT.Gunner.Fire", salvoSize: baseSalvo, cost: 0, hitMod: 0, resource: "none", resourceLabel: "" };
  }

  _buildOverchargedTraits() {
    const traits  = this.weapon?.system?.traits ?? {};
    const entries = [];
    const MULT    = 3;
    if ((traits.shieldBurn        ?? 0) > 0) entries.push({ label: game.i18n.localize("SHIPCOMBAT.Trait.ShieldBurn"),        base: traits.shieldBurn,        oc: traits.shieldBurn        * MULT });
    if ((traits.rend              ?? 0) > 0) entries.push({ label: game.i18n.localize("SHIPCOMBAT.Trait.Rend"),              base: traits.rend,              oc: traits.rend              * MULT });
    if ((traits.armourPenetration ?? 0) > 0) entries.push({ label: game.i18n.localize("SHIPCOMBAT.Trait.ArmourPenetration"), base: traits.armourPenetration, oc: traits.armourPenetration * MULT });
    if ((traits.devastating       ?? 0) > 0) entries.push({ label: game.i18n.localize("SHIPCOMBAT.Trait.Devastating"),       base: traits.devastating,       oc: traits.devastating       * MULT });
    return entries;
  }

  _showArrow(target) {
    this._hideArrow();
    if (!canvas?.ready || !this._shipPos) return;

    const sx = this._shipPos.x, sy = this._shipPos.y;
    const tx = target.targetX,  ty = target.targetY;

    const container = new PIXI.Container();
    container.name      = "shipcombat-attack-vector";
    container.eventMode = "none";
    canvas.tokens.addChild(container);

    const g  = new PIXI.Graphics();
    container.addChild(g);

    const dx = tx - sx, dy = ty - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    const nx = dx / len, ny = dy / len;
    const headLen = Math.min(20, len * 0.15);
    const endX = tx - nx * headLen, endY = ty - ny * headLen;

    g.lineStyle(2.5, pixi(THEME.overlay.attackVector), 0.8);
    g.moveTo(sx, sy);
    g.lineTo(endX, endY);

    const perpX = -ny, perpY = nx;
    const hw = headLen * 0.5;
    g.beginFill(pixi(THEME.overlay.attackVector), 0.8);
    g.lineStyle(0);
    g.drawPolygon([tx, ty, endX + perpX * hw, endY + perpY * hw, endX - perpX * hw, endY - perpY * hw]);
    g.endFill();

    this._arrowContainer = container;
  }

  _hideArrow() {
    if (this._arrowContainer && !this._arrowContainer.destroyed) {
      this._arrowContainer.destroy({ children: true });
    }
    this._arrowContainer = null;
  }

  async _onConfirmFire(tokenId) {
    const target = this.targets.find(t => t.tokenId === tokenId);
    if (!target) return;

    const ship        = this.weapon?.parent;
    const gunnerRes   = ship?.system?.resources?.gunner ?? {};
    const fmd         = this._getFireModeDetails(gunnerRes);

    emitToGM("fireWeapon", {
      actorId:        this.weapon.parent?.id,
      weaponId:       this.weapon.id,
      fireMode:       this.fireMode,
      targetToken:    tokenId,
      hitQuadrant:    target.hitQuadrant,
      accuracy:       target.totalAccuracy === "Auto" ? 999 : target.totalAccuracy,
      isAutoHit:      target.isAutoHit,
      zone:           target.zone,
      salvoSize:      fmd.salvoSize ?? 1,
      isOvercharged:  this.isOvercharged,
      fireCorrection: target.activeCorrection ?? null,
    });

    this.close();
  }
}
