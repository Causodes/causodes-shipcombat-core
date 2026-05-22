/**
 * RamTargetPopup  -  popup listing valid ram targets within the ship's arc.
 *
 * Follows the same pattern as TargetingPopup:
 *   - Hover over a row → shows red ram arc preview + target ring on canvas
 *   - Click "Ram" → confirmation dialog → emits pilotRam socket
 *
 * Validity criteria:
 *   1. canReach() → bearingDeg + thrustPct available
 *   2. Lock tier ≥ 1 (NPC ships default to lock 3)
 */
import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { emitToGM }  from "../socket.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { HelmPreview } from "../canvas/HelmPreview.js";
import { getHitQuadrant } from "./TargetingPopup.js";
import { THEME, pixi } from "../theme.js";

export class RamTargetPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  /** @type {object}   Ship actor performing the ram */
  ship = null;
  /** @type {object[]} Computed target list */
  targets = [];
  /** @type {{x:number,y:number}} Ramming ship canvas centre */
  _shipPos = null;
  /** @type {object} PIXI ring graphic for hovered target */
  _targetRing = null;
  /** @type {number[]} Foundry hook IDs for live refresh */
  _liveHooks = null;
  /** @type {Function} Debounced re-render function */
  _rerenderFn = null;

  // ── Helm parameters (set by caller) ───────────────────────────────────────
  effSpeed        = 6;
  powerMax        = 100;
  powerRemaining  = 100;
  maxBearingDeg   = 30;
  minMoveGridUnits = 0;
  fuelBurned      = 0;
  shipBasis       = null;
  isRealistic     = false;
  velocityX       = 0;
  velocityY       = 0;
  carryPct        = 0;

  constructor(options = {}) {
    super(options);
    this.ship             = options.ship;
    this.effSpeed         = options.effSpeed         ?? 6;
    this.powerMax         = options.powerMax         ?? 100;
    this.powerRemaining   = options.powerRemaining   ?? 100;
    this.maxBearingDeg    = options.maxBearingDeg    ?? 30;
    this.minMoveGridUnits = options.minMoveGridUnits ?? 0;
    this.fuelBurned       = options.fuelBurned       ?? 0;
    this.shipBasis        = options.shipBasis        ?? null;
    this.isRealistic      = options.isRealistic      ?? false;
    this.velocityX        = options.velocityX        ?? 0;
    this.velocityY        = options.velocityY        ?? 0;
    this.carryPct         = options.carryPct         ?? 0;
  }

  static DEFAULT_OPTIONS = {
    id: "shipcombat-ram-target-popup",
    classes: ["shipcombat-ram-target-popup"],
    tag: "div",
    window: {
      title: "SHIPCOMBAT.Dialog.RamTitle",
      resizable: false,
    },
    position: { width: 420, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/ram-target-popup.hbs` },
  };

  /** Collect all valid ram targets. */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const ship    = this.ship;
    if (!ship) return { ...context, targets: [], noTargets: true };

    const tokens = ship.getActiveTokens?.() ?? [];
    if (!tokens.length) return { ...context, targets: [], noTargets: true };

    const token    = tokens[0];
    const gridSize = canvas.grid.size;
    const tokenW   = token.document.width  * gridSize;
    const tokenH   = token.document.height * gridSize;
    const cx       = token.x + tokenW / 2;
    const cy       = token.y + tokenH / 2;

    const shipBasis = this.shipBasis ?? HelmPreview._tokenBasis(token);

    // Gather candidates — all visible tokens that are not the ramming ship's
    // specific token.  Comparing by token ID (not actor ID) correctly handles
    // test scenarios where both the player ship and an NPC test token are linked
    // to the same actor prototype.
    const candidates = canvas.tokens.placeables.filter(
      t => t.id !== token.id && t.visible,
    );

    // Pre-compute ramming ship stats for damage preview (matches pilotRam formula)
    const RAM_COEFF      = 2;
    const rammingSys       = this.ship?.system;
    const rammingBowArmour = Math.max(1, rammingSys?.armour?.bow ?? 0);
    const rammingHullMax   = rammingSys?.hull?.max ?? 50;
    const rammingDmgBase   = rammingBowArmour + 0.25 * rammingHullMax;

    const targets = [];
    for (const candidate of candidates) {
      const cW = candidate.document.width  * gridSize;
      const cH = candidate.document.height * gridSize;
      const tx = candidate.x + cW / 2;
      const ty = candidate.y + cH / 2;

      // Arc/reach check
      const reach = this.isRealistic
        ? HelmPreview.canReachRealistic(
            shipBasis, tx, ty,
            this.effSpeed, this.maxBearingDeg,
            this.powerRemaining, this.powerMax,
            this.velocityX, this.velocityY,
            this.carryPct,
          )
        : HelmPreview.canRam(
            shipBasis, tx, ty,
            this.effSpeed, this.maxBearingDeg,
            this.powerRemaining, this.powerMax,
            this.minMoveGridUnits,
          );
      if (!reach) continue;

      const distSquares = Math.sqrt(
        Math.pow((tx - cx) / gridSize, 2) +
        Math.pow((ty - cy) / gridSize, 2),
      );
      const lockTier = ship.type === `${MODULE_ID}.npcShip`
        ? 3
        : ShipCombatState.getEffectiveLockTier(candidate.id, distSquares);
      if (lockTier < 1) continue;

      const attackAngle = Math.atan2(ty - cy, tx - cx);
      const hitSector   = getHitQuadrant(candidate.document.rotation ?? 0, attackAngle);
      const distVU      = Math.round(distSquares * 10) / 10;

      // Thrust fraction for estimated damage preview — ram consumes ALL remaining power
      const thrustFraction = Math.min(1, this.powerRemaining / (this.powerMax || 100));

      // ── Damage preview (mirrors pilotRam formulas exactly) ─────────────────
      const tgtHeadingRad  = (candidate.document.rotation ?? 0) * (Math.PI / 180);
      let   impactAngle    = attackAngle - tgtHeadingRad + Math.PI;
      impactAngle = ((impactAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (impactAngle > Math.PI) impactAngle -= 2 * Math.PI;
      const angleModRammed   = 0.5 + 0.5 * Math.abs(Math.sin(impactAngle));
      // Outgoing: hull damage our ship deals to the target
      const damageOut = Math.max(1, Math.round(rammingDmgBase * thrustFraction * angleModRammed * RAM_COEFF));
      // Incoming: hull damage the target deals back to us (soaked by our bow armour)
      const targetSys            = candidate.document.actor?.system;
      const targetArmourInSector = Math.max(1, targetSys?.armour?.[hitSector] ?? 0);
      const targetHullMax        = targetSys?.hull?.max ?? 50;
      const targetDmgBase        = targetArmourInSector + 0.25 * targetHullMax;
      const damageIn             = Math.round(Math.max(0, Math.round(targetDmgBase * thrustFraction * RAM_COEFF) - rammingBowArmour) / 5) * 5;

      targets.push({
        tokenId:      candidate.id,
        name:         lockTier >= 2 ? (candidate.document.name ?? "Unknown") : game.i18n.localize("SHIPCOMBAT.Targeting.UnknownContact"),
        img:          candidate.document.texture?.src ?? "icons/svg/mystery-man.svg",
        distance:     distVU,
        bearingDeg:   reach.bearingDeg,
        thrustPct:    reach.thrustPct,
        thrustFraction,
        thrustPctDisplay: Math.round(this.powerRemaining),
        hitSector,
        hitSectorLabel: game.i18n.localize(`SHIPCOMBAT.Sector.${hitSector.charAt(0).toUpperCase() + hitSector.slice(1)}`),
        lockTier,
        targetX:  tx,
        targetY:  ty,
        attackAngle,
        damageOut,
        damageIn,
      });
    }

    targets.sort((a, b) => a.distance - b.distance);
    this.targets  = targets;
    this._shipPos = { x: cx, y: cy };

    return {
      ...context,
      targets,
      noTargets:      targets.length === 0,
      powerRemaining: this.powerRemaining,
      powerMax:       this.powerMax,
      shipImg:        this.ship?.img ?? "icons/svg/mystery-man.svg",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Live refresh when state or tokens change
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

    // Wire up confirm buttons
    this.element.querySelectorAll("[data-action='confirmRam']").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        this._onConfirmRam(btn.dataset.tokenId);
      });
    });

    // Hover: show red arc preview + target ring
    this.element.querySelectorAll(".shipcombat-ram-target-row[data-token-id]").forEach(row => {
      row.addEventListener("mouseenter", () => {
        const target = this.targets.find(t => t.tokenId === row.dataset.tokenId);
        if (!target) return;
        const token = this.ship?.getActiveTokens?.()?.[0];
        if (token) {
          if (this.isRealistic) {
            HelmPreview.showRamRealistic(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.velocityX, this.velocityY, this.carryPct);
          } else {
            HelmPreview.showRam(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.minMoveGridUnits);
          }
        }
        this._showTargetRing(target);
      });
      row.addEventListener("mouseleave", () => {
        HelmPreview.hide();
        this._hideTargetRing();
      });
    });
  }

  /** Draw a red ring around the hovered target token on the canvas. */
  _showTargetRing(target) {
    this._hideTargetRing();
    if (!canvas?.ready) return;

    const candidate = canvas.tokens.placeables.find(t => t.id === target.tokenId);
    if (!candidate) return;

    const gridSize = canvas.grid.size;
    const w = candidate.document.width  * gridSize;
    const h = candidate.document.height * gridSize;
    const tx = candidate.x + w / 2;
    const ty = candidate.y + h / 2;
    const r  = Math.max(w, h) / 2 + 6;

    const container = new PIXI.Container();
    container.name = "shipcombat-ram-target-ring";
    container.eventMode = "none";
    canvas.tokens.addChild(container);

    const g = new PIXI.Graphics();
    g.lineStyle(3, pixi(THEME.overlay.helmRam), 0.9);
    g.drawCircle(tx, ty, r);
    container.addChild(g);

    this._targetRing = container;
  }

  _hideTargetRing() {
    if (this._targetRing && !this._targetRing.destroyed) {
      this._targetRing.destroy({ children: true });
    }
    this._targetRing = null;
  }

  _onClose(options) {
    HelmPreview.hide();
    this._hideTargetRing();
    if (this._liveHooks) {
      Hooks.off("updateActor",  this._rerenderFn);
      Hooks.off("updateToken",  this._rerenderFn);
      Hooks.off("refreshToken", this._rerenderFn);
      this._liveHooks  = null;
      this._rerenderFn = null;
    }
    super._onClose?.(options);
  }

  /** Called when the player clicks a Ram button. Shows confirmation dialog, then emits socket. */
  async _onConfirmRam(tokenId) {
    const target = this.targets.find(t => t.tokenId === tokenId);
    if (!target) return;

    const token    = this.ship?.getActiveTokens?.()?.[0];
    if (!token) return;

    const thrustPctDisplay = Math.round(this.powerRemaining);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window:  { title: game.i18n.localize("SHIPCOMBAT.Dialog.RamTitle") },
      content: `<p>${game.i18n.format("SHIPCOMBAT.Dialog.RamConfirmBody", {
        name:  target.name,
        pct:   thrustPctDisplay,
        sector: target.hitSectorLabel,
      })}</p>`,
    });
    if (!confirmed) return;

    // Show final arc preview while projecting
    if (this.isRealistic) {
      HelmPreview.showRamRealistic(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.velocityX, this.velocityY, this.carryPct);
    } else {
      HelmPreview.showRam(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.minMoveGridUnits);
    }

    let projected, waypoints;
    if (this.isRealistic) {
      projected = HelmPreview.projectPositionRealistic(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.velocityX, this.velocityY, this.carryPct);
      waypoints = HelmPreview.projectWaypointsRealistic(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.velocityX, this.velocityY, this.carryPct);
    } else {
      projected = HelmPreview.projectPosition(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.minMoveGridUnits);
      waypoints = HelmPreview.projectWaypoints(token, target.bearingDeg, target.thrustPct, this.effSpeed, this.minMoveGridUnits);
    }
    HelmPreview.hide();

    if (!projected) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.RamProjectionFailed"));
      return;
    }

    const fuelUsed = this.powerMax;  // ram consumes ALL remaining power

    // Max out the momentum slider visually (mirrors how thrust is maxed)
    if (this.isRealistic) {
      const sheet = this.ship?.sheet;
      if (sheet?._helmState) sheet._helmState.carryPct = 100;
    }

    emitToGM("pilotRam", {
      userId:         game.user.id,
      targetTokenId:  tokenId,
      fuelUsed,
      driftUsed:      this.isRealistic ? 0 : this.minMoveGridUnits,
      speed:          this.effSpeed,
      newX:           projected.x,
      newY:           projected.y,
      newRotation:    projected.rotation,
      waypoints,
      attackAngle:    target.attackAngle,
      powerMax:       this.powerMax,
      rammingActorId: this.ship?.id ?? null,
      maxBearingDeg:  this.maxBearingDeg,
    });

    this.close();
  }
}
