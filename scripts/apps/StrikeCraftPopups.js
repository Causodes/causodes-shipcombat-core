/**
 * StrikeCraftPopups  -  two popup classes used by the Ordnance role.
 *
 * StrikeCraftAttackPopup:
 *   Opened from StrikeCraftSheet when the pilot triggers an attack run.
 *   Lists valid targets in arc/range with accuracy, draws a red attack vector
 *   arrow on hover, and enforces a 1-attack-per-target-per-turn limit tracked
 *   via actor flags (cleared by advanceRound).
 *
 * RecoverCraftPopup:
 *   Replaces the old plain DialogV2 in the "recallCraft" ordnance action.
 *   Lists nearby friendly strike craft with distance and draws an orange arrow
 *   to each craft on hover.  Returns a Promise<tokenId|null>.
 */

import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { emitToGM } from "../socket.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { THEME, pixi } from "../theme.js";
import { classifyZone, getHitQuadrant } from "./TargetingPopup.js";
import { isOrdnance } from "../actors/ordnance/ordnance-types.js";

// ── Shared arrow helper ──

export function _drawArrow(container, sx, sy, tx, ty, color) {
  const g = new PIXI.Graphics();
  container.addChild(g);

  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const nx = dx / len;
  const ny = dy / len;
  const headLen = Math.min(20, len * 0.15);
  const endX = tx - nx * headLen;
  const endY = ty - ny * headLen;

  g.lineStyle(2.5, color, 0.8);
  g.moveTo(sx, sy);
  g.lineTo(endX, endY);

  const perpX = -ny;
  const perpY =  nx;
  const hw = headLen * 0.5;
  g.beginFill(color, 0.8);
  g.lineStyle(0);
  g.drawPolygon([
    tx, ty,
    endX + perpX * hw, endY + perpY * hw,
    endX - perpX * hw, endY - perpY * hw,
  ]);
  g.endFill();
}

export function _makeArrowContainer(name) {
  const c = new PIXI.Container();
  c.name = name;
  c.eventMode = "none";
  canvas.tokens.addChild(c);
  return c;
}

export function _destroyContainer(ref) {
  if (ref && !ref.destroyed) ref.destroy({ children: true });
}

// ── StrikeCraftAttackPopup ──

export class StrikeCraftAttackPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  craftActor    = null;
  targets       = [];
  _shipPos      = null;
  _arrowContainer = null;

  constructor(options = {}) {
    super(options);
    this.craftActor = options.craftActor;
  }

  static DEFAULT_OPTIONS = {
    id: "shipcombat-sc-attack-popup",
    classes: ["shipcombat-sc-attack-popup", "shipcombat-targeting-popup"],
    tag: "div",
    window: { title: "SHIPCOMBAT.StrikeCraft.AttackTitle", resizable: false },
    position: { width: 380, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/strike-craft-attack-popup.hbs` },
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.craftActor;
    if (!actor) return { ...context, targets: [], noTargets: true };

    const sys = actor.system;
    const token = actor.getActiveTokens()?.[0];
    if (!token || !canvas?.ready) return { ...context, targets: [], noTargets: true };

    const gs = canvas.grid.size;
    const cx = token.x + (token.document.width  * gs) / 2;
    const cy = token.y + (token.document.height * gs) / 2;

    // Heading: Foundry 0° = south (forward), add π/2 to align with atan2 (east = 0)
    const heading = ((token.document.rotation ?? 0) + 90) * (Math.PI / 180);
    const halfArc = ((sys.payloadAngle ?? 120) / 2) * (Math.PI / 180);

    // Sensor stats from the craft's own fields
    const sensor = {
      rating:        sys.sensorRating   ?? 0,
      bandSize:      sys.sensorBandSize ?? 0,
      autoScanRange: sys.autoScanRange  ?? 0,
    };
    // ASR defines the standard engagement envelope; bands extend beyond it with penalties
    const weaponRange = sys.autoScanRange ?? 0;

    // Targets already attacked this turn (flag cleared each round by advanceRound)
    const attackedThisTurn = actor.getFlag(MODULE_ID, "attackedThisTurn") ?? [];

    const isFighter = sys.craftType === "fighter";
    const shipTypes = [`${MODULE_ID}.ship`, `${MODULE_ID}.npcShip`];
    if (isFighter) {
      shipTypes.push(`${MODULE_ID}.torpedo`);
      shipTypes.push(`${MODULE_ID}.strikeCraft`);
    }

    const parentShipTokenId = sys.parentShipTokenId ?? null;

    const candidates = canvas.tokens.placeables.filter(t => {
      if (!shipTypes.includes(t.document.actor?.type) && !(isFighter && isOrdnance(t.document.actor))) return false;
      // Exclude self
      if (t.id === token.id) return false;
      // Exclude parent ship
      if (parentShipTokenId && t.id === parentShipTokenId) return false;
      // Exclude sibling ordnance (same parent ship)
      const tParent = t.document.actor?.system?.parentShipTokenId;
      if (tParent && tParent === parentShipTokenId) return false;
      return true;
    });

    const targets = [];
    for (const candidate of candidates) {
      const cW = candidate.document.width  * gs;
      const cH = candidate.document.height * gs;
      const tx = candidate.x + cW / 2;
      const ty = candidate.y + cH / 2;

      // Closest-edge distance from craft to target
      const clx = Math.max(candidate.x, Math.min(cx, candidate.x + cW));
      const cly = Math.max(candidate.y, Math.min(cy, candidate.y + cH));
      const dist = Math.sqrt((cx - clx) ** 2 + (cy - cly) ** 2);

      // Forward-arc check (same logic as _onAttack)
      const angle = Math.atan2(ty - cy, tx - cx);
      let rel = angle - heading;
      rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (rel > Math.PI) rel -= 2 * Math.PI;
      if (Math.abs(rel) > halfArc) continue;

      const distSquares = dist / gs;
      const zone = classifyZone(distSquares, weaponRange, sensor);
      if (!zone) continue;

      // Lock tier check  -  uses parent ship's sensor data
      const lockTier = ShipCombatState.getEffectiveLockTier(candidate.id, distSquares);
      if (lockTier < 1) continue;

      // Accuracy = craft's sensor rating + zone mod + lock-4 bonus + zone-1 half-miss
      const adapter      = SystemAdapter.current;
      const step         = adapter.getModifierStepSize();
      const lockBonus    = lockTier >= 4 ? step : 0;
      const finalZoneMod = (zone.zone === 3 && lockTier >= 4) ? 0 : zone.modifier;
      let totalAccuracy  = sensor.rating + finalZoneMod + lockBonus;

      // Zone 1 (close scan): system-specific bonus
      let zone1Bonus = 0;
      if (zone.zone === 1) {
        zone1Bonus = adapter.computeZone1Bonus(totalAccuracy);
        totalAccuracy += zone1Bonus;
      }

      const attackAngle = Math.atan2(ty - cy, tx - cx);
      const hitQuadrant = getHitQuadrant(candidate.document.rotation ?? 0, attackAngle);
      const hitQuadrantLabel = game.i18n.localize(
        `SHIPCOMBAT.Sector.${hitQuadrant.charAt(0).toUpperCase() + hitQuadrant.slice(1)}`
      );

      // Build accuracy breakdown tooltip
      const breakdown = [`Base: ${adapter.formatTargetNumber(sensor.rating)}`];
      if (finalZoneMod !== 0) breakdown.push(`Distance: ${adapter.formatModifier(finalZoneMod)}`);
      if (lockBonus    !== 0) breakdown.push(`Lock Tier: ${adapter.formatModifier(lockBonus)}`);
      if (zone1Bonus   !== 0) breakdown.push(`Close Scan: ${adapter.formatModifier(zone1Bonus)}`);
      const accuracyTooltip = breakdown.join("\n");

      targets.push({
        tokenId:          candidate.id,
        name:             candidate.document.name ?? "Unknown",
        img:              candidate.document.texture?.src ?? "icons/svg/mystery-man.svg",
        distance:         Math.round(distSquares * 10) / 10,
        zone:             zone.zone,
        zoneLabel:        game.i18n.localize(zone.label),
        zoneModifier:     finalZoneMod,
        hitQuadrant,
        hitQuadrantLabel,
        totalAccuracy,
        lockTier,
        alreadyAttacked:  attackedThisTurn.includes(candidate.id),
        accuracyTooltip,
        targetX: tx,
        targetY: ty,
      });
    }

    targets.sort((a, b) => a.distance - b.distance);
    this.targets = targets;
    this._shipPos = { x: cx, y: cy };

    return {
      ...context,
      targets,
      noTargets:      targets.length === 0,
      craftName:      actor.name,
      craftImg:       actor.img ?? "icons/svg/mystery-man.svg",
      craftTypeLabel: sys.craftType === "bomber"
        ? game.i18n.localize("SHIPCOMBAT.CraftType.Bomber")
        : game.i18n.localize("SHIPCOMBAT.CraftType.Fighter"),
      ammo:           sys.ammo?.value ?? 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // ── Live accuracy refresh ─────────────────────────────────────────────
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

    this.element.querySelectorAll("[data-action='confirmAttack']").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        this._onConfirmAttack(btn.dataset.tokenId);
      });
    });

    this.element.querySelectorAll(".shipcombat-tp-target[data-token-id]").forEach(row => {
      row.addEventListener("mouseenter", () => {
        const t = this.targets.find(x => x.tokenId === row.dataset.tokenId);
        if (t) this._showArrow(t);
      });
      row.addEventListener("mouseleave", () => this._hideArrow());
    });
  }

  async _onConfirmAttack(tokenId) {
    const target = this.targets.find(t => t.tokenId === tokenId);
    if (!target || target.alreadyAttacked) return;

    const sys       = this.craftActor.system;
    // HP-remaining systems store intact airframes in hull.value directly;
    // damage-taken systems store wounds, so remaining = max − value.
    const _scIsHP    = SystemAdapter.current.hullDisplayMode === "hpRemaining";
    const flightSize = Math.max(1, _scIsHP ? (sys.hull?.value ?? 1) : (sys.hull?.max ?? 1) - (sys.hull?.value ?? 0));
    const damage     = sys.payloadDamage ?? 0;
    const salvoSize  = (sys.payloadCount ?? 1) * flightSize;

    emitToGM("strikeCraftAttack", {
      craftActorId:    this.craftActor.id,
      craftName:       this.craftActor.name,
      craftImg:        this.craftActor.img,
      targetTokenId:   tokenId,
      hitQuadrant:     target.hitQuadrant,
      accuracy:        target.totalAccuracy,
      damage,
      payloadDiceCount: sys.payloadDiceCount ?? null,
      payloadDiceSize:  sys.payloadDiceSize  ?? null,
      payloadDamageType: sys.payloadDamageType ?? null,
      traits:          sys.traits,
      salvoSize,
    });

    // Consume 1 ammo
    await this.craftActor.update({
      [SystemAdapter.current.systemPath("ammo.value")]: Math.max(0, (sys.ammo?.value ?? 0) - 1),
    });

    // Mark this target as attacked this turn (cleared by advanceRound)
    const prev = this.craftActor.getFlag(MODULE_ID, "attackedThisTurn") ?? [];
    await this.craftActor.setFlag(MODULE_ID, "attackedThisTurn", [...prev, tokenId]);

    this.close();
  }

  _showArrow(target) {
    this._hideArrow();
    if (!canvas?.ready || !this._shipPos) return;
    const container = _makeArrowContainer("shipcombat-sc-attack-vector");
    _drawArrow(
      container,
      this._shipPos.x, this._shipPos.y,
      target.targetX, target.targetY,
      pixi(THEME.overlay.attackVector),
    );
    this._arrowContainer = container;
  }

  _hideArrow() {
    _destroyContainer(this._arrowContainer);
    this._arrowContainer = null;
  }

  _onClose(options) {
    this._hideArrow();
    if (this._liveHooks) {
      Hooks.off("updateActor",  this._rerenderFn);
      Hooks.off("updateToken",  this._rerenderFn);
      Hooks.off("refreshToken", this._rerenderFn);
      this._liveHooks  = null;
      this._rerenderFn = null;
    }
    super._onClose?.(options);
  }
}

// ── RecoverCraftPopup ──

export class RecoverCraftPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  _nearbyCraft    = [];
  _shipPos        = null;
  _arrowContainer = null;
  _resolvePromise = null;

  constructor(options = {}) {
    super(options);
    this._nearbyCraft = options.nearbyCraft ?? [];
    this._shipPos     = options.shipPos ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: "shipcombat-recover-craft-popup",
    classes: ["shipcombat-recover-craft-popup", "shipcombat-targeting-popup"],
    tag: "div",
    window: { title: "SHIPCOMBAT.Ordnance.SelectCraftTitle", resizable: false },
    position: { width: 320, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/recover-craft-popup.hbs` },
  };

  /**
   * Render the popup and return a Promise that resolves with the selected
   * tokenId (string) or null if the popup is dismissed without selection.
   */
  show() {
    return new Promise(resolve => {
      this._resolvePromise = resolve;
      this.render(true);
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      craft:     this._nearbyCraft,
      noTargets: this._nearbyCraft.length === 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    this.element.querySelectorAll("[data-action='confirmRecall']").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        const tokenId = btn.dataset.tokenId;
        this._resolvePromise?.(tokenId);
        this._resolvePromise = null;
        this.close();
      });
    });

    this.element.querySelectorAll(".shipcombat-tp-target[data-token-id]").forEach(row => {
      row.addEventListener("mouseenter", () => {
        const c = this._nearbyCraft.find(x => x.tokenId === row.dataset.tokenId);
        if (c) this._showArrow(c);
      });
      row.addEventListener("mouseleave", () => this._hideArrow());
    });
  }

  _showArrow(craft) {
    this._hideArrow();
    if (!canvas?.ready || !this._shipPos) return;
    const container = _makeArrowContainer("shipcombat-recover-vector");
    _drawArrow(
      container,
      this._shipPos.x, this._shipPos.y,
      craft.targetX, craft.targetY,
      pixi(THEME.roles.ordnance),   // orange
    );
    this._arrowContainer = container;
  }

  _hideArrow() {
    _destroyContainer(this._arrowContainer);
    this._arrowContainer = null;
  }

  _onClose(options) {
    this._hideArrow();
    this._resolvePromise?.(null);
    this._resolvePromise = null;
    super._onClose?.(options);
  }
}
