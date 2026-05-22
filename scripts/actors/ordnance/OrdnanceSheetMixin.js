/**
 * OrdnanceSheetMixin – system-agnostic sheet behaviour for ship ordnance actors.
 *
 * Usage:
 *   import { OrdnanceSheetMixin } from ".../OrdnanceSheetMixin.js";
 *   export class OrdnanceSheet extends OrdnanceSheetMixin(SystemAdapter.current.SheetBaseClass) {}
 *
 * The mixin owns all layout, helm controls, and actions. The system-specific
 * base class (e.g. IMActorSheet) is injected by the system module at registration time.
 */

import { MODULE_ID, CORE_MODULE_ID, hullDisplay } from "../../constants.js";
import { isTorpedo, isStrikeCraft } from "./ordnance-types.js";
import { HelmPreview } from "../../canvas/HelmPreview.js";
import { TorpedoOverlay } from "../../canvas/TorpedoOverlay.js";
import { StrikeCraftArcOverlay } from "../../canvas/StrikeCraftArcOverlay.js";
import { StrikeCraftAttackPopup } from "../../apps/StrikeCraftPopups.js";
import { emitToGM, emitToAll } from "../../socket.js";
import { ShipCombatState } from "../../state/ShipCombatState.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";

async function _animateTokenPath(token, waypoints, projected) {
  const canvasToken = token.object ?? token;
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    await canvasToken.animate(
      { x: wp.x, y: wp.y, rotation: wp.rotation },
      { duration: 50, chain: i > 0 },
    );
  }
  await token.document.update(
    { x: projected.x, y: projected.y, rotation: projected.rotation },
    { animate: false },
  );
}

// ── Standalone action functions (shared by both AppV2 DEFAULT_OPTIONS.actions and the AppV1 click dispatcher) ───

async function _onOrdConfirmHelm() {
  const sys = SystemAdapter.current.getShipData(this.actor);
  if (sys.turnComplete) return;
  const helm    = sys.helm ?? {};
  const speed   = sys.movement.speed ?? 0;
  const html    = this.element;
  const bearing = parseInt(html?.querySelector("[data-helm-bearing]")?.value) || 0;
  const newPct  = parseInt(html?.querySelector("[data-helm-fuel]")?.value) || 0;
  const carryPct = parseInt(html?.querySelector("[data-helm-carry]")?.value) || 0;
  const oldPct  = helm.thrustPct ?? 0;
  const isRealistic = game.settings?.get(MODULE_ID, "movementMode") === "realistic";

  // Torpedo has variable powerMax; SC always 100
  const powerMax   = sys.subtype === "torpedo"
    ? (sys.powerBoostActive ? 200 : 100) : 100;
  const minMove    = Math.ceil(speed / 2);
  const totalSq    = minMove + speed;
  const deltaSquares = (newPct - oldPct) / powerMax * totalSq;

  if (isRealistic) {
    const vx = helm.velocityX ?? 0;
    const vy = helm.velocityY ?? 0;
    const velMag = Math.hypot(vx, vy);
    if (deltaSquares <= 0 && (velMag === 0 || carryPct === 0)) {
      return ui.notifications.warn("No movement to commit.");
    }
  } else if (deltaSquares <= 0) {
    return ui.notifications.warn("No movement to commit.");
  }

  // thrustArg must be relative to totalSq (speed + minMove) so the arc radius
  // matches the player ship — same (speed + minMove) × gridSize / bearingRad formula.
  const thrustArg = deltaSquares > 0 ? deltaSquares * 100 / totalSq : 0;
  const token = this.actor.getActiveTokens()?.[0];
  if (token && canvas?.ready) {
    if (isRealistic) {
      const vx = helm.velocityX ?? 0;
      const vy = helm.velocityY ?? 0;
      const projected = HelmPreview.projectPositionRealistic(
        token, bearing, thrustArg, speed, vx, vy, carryPct);
      if (projected) {
        const waypoints = HelmPreview.projectWaypointsRealistic(
          token, bearing, thrustArg, speed, vx, vy, carryPct);
        if (waypoints?.length > 1) {
          await _animateTokenPath(token, waypoints, projected);
        } else {
          await token.document.update(
            { x: projected.x, y: projected.y, rotation: projected.rotation },
            { animate: true },
          );
        }
      }
    } else {
      const projected = HelmPreview.projectPosition(token, bearing, thrustArg, speed, minMove);
      if (projected) {
        const waypoints = HelmPreview.projectWaypoints(token, bearing, thrustArg, speed, minMove);
        if (waypoints?.length > 1) {
          await _animateTokenPath(token, waypoints, projected);
        } else {
          await token.document.update(
            { x: projected.x, y: projected.y, rotation: projected.rotation },
            { animate: true },
          );
        }
      }
    }
  }

  const prevTurnMove = helm.prevTurnMove ?? 0;
  const updates = {
    [SystemAdapter.current.systemPath("helm.thrustPct")]:    newPct,
    [SystemAdapter.current.systemPath("helm.prevTurnMove")]: (prevTurnMove || 0) + Math.round(deltaSquares),
    [SystemAdapter.current.systemPath("helm.bearing")]:      bearing,
  };
  if (isRealistic && token) {
    const h0 = (token.document.rotation - 90) * (Math.PI / 180);
    const thrustDir = h0 + bearing * (Math.PI / 180);
    const thrustMag = (thrustArg / 100) * speed;
    updates[SystemAdapter.current.systemPath("helm.velocityX")] = (helm.velocityX ?? 0) + Math.cos(thrustDir) * thrustMag;
    updates[SystemAdapter.current.systemPath("helm.velocityY")] = (helm.velocityY ?? 0) + Math.sin(thrustDir) * thrustMag;
    updates[SystemAdapter.current.systemPath("helm.momentumUsed")] = carryPct;
  }
  await this.actor.update(updates);
  HelmPreview.hide();
}

async function _onOrdMarkTurnComplete() {
  const current = SystemAdapter.current.getShipData(this.actor).turnComplete;
  const tokenId = this.actor.token?.id ?? this.actor.getActiveTokens()?.[0]?.id;
  if (!tokenId) return;
  emitToGM("setOrdnanceTurnDone", { tokenId, done: !current });
}

async function _onOrdAttack() {
  const sys = SystemAdapter.current.getShipData(this.actor);
  if (sys.turnComplete) return;
  if ((sys.ammo?.value ?? 0) <= 0) return ui.notifications.warn("No ammunition remaining.");
  const token = this.actor.getActiveTokens()?.[0];
  if (!token || !canvas?.ready) return;
  const StrikeCraftAttackPopupClass = ShipCombat._popupClass("strikeCraftAttack", StrikeCraftAttackPopup);
  new StrikeCraftAttackPopupClass({ craftActor: this.actor }).render(true);
}

async function _onOrdDetonate() {
  const sys = SystemAdapter.current.getShipData(this.actor);
  if (sys.turnComplete || sys.designated) return;
  const token = this.actor.getActiveTokens()?.[0];
  if (!token || !canvas?.ready) return;

  const radius      = sys.payloadRadius;
  const baseDmg     = sys.payloadDamage;
  const warheads    = Math.max(1, (sys.hull?.max ?? 1) - (sys.hull?.value ?? 0));
  const gs          = canvas.grid.size;
  const cx          = token.x + (token.document.width * gs) / 2;
  const cy          = token.y + (token.document.height * gs) / 2;
  const radiusPx    = radius * gs;

  const shipTypes   = [`${MODULE_ID}.ship`, `${MODULE_ID}.npcShip`];
  const targets     = canvas.tokens.placeables.filter(t => {
    if (!shipTypes.includes(t.document.actor?.type)) return false;
    return _closestEdgeDist(cx, cy, t, gs) <= radiusPx;
  });
  const torpedoTargets = canvas.tokens.placeables.filter(t => {
    if (t === token) return false;
    if (!isTorpedo(t.document.actor)) return false;
    return _closestEdgeDist(cx, cy, t, gs) <= radiusPx;
  });
  const craftTargets = canvas.tokens.placeables.filter(t => {
    if (!isStrikeCraft(t.document.actor)) return false;
    return _closestEdgeDist(cx, cy, t, gs) <= radiusPx;
  });

  const parts = [];
  if (targets.length)        parts.push(`${targets.length} ship(s)`);
  if (torpedoTargets.length) parts.push(`${torpedoTargets.length} torpedo(es)`);
  if (craftTargets.length)   parts.push(`${craftTargets.length} strike craft`);
  const confirmMsg = `<p>Detonate warhead?${parts.length > 0 ? ` ${parts.join(", ")} in blast radius.` : " Nothing in blast radius."}</p>`;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Confirm Detonation" },
    content: confirmMsg,
  });
  if (!ok) return;

  for (const t of targets) {
    const dist = _closestEdgeDist(cx, cy, t, gs);
    const innerRadius = gs;
    let decayMult;
    if (dist <= innerRadius) {
      decayMult = 1;
    } else {
      const outerDist  = Math.min(dist - innerRadius, radiusPx - innerRadius);
      const outerRange = Math.max(1, radiusPx - innerRadius);
      decayMult = 1 - 0.75 * (outerDist / outerRange);
    }
    const damage    = Math.max(1, Math.round(baseDmg * warheads * decayMult));
    const _dc = sys.payloadDiceCount;
    const _ds = sys.payloadDiceSize;
    const diceFormula = (_dc && _ds)
      ? `${Math.max(1, Math.round(warheads * decayMult)) * _dc}${_ds}`
      : null;
    const tw = t.document.width * gs;
    const th = t.document.height * gs;
    const tx = t.x + tw / 2;
    const ty = t.y + th / 2;
    const attackAngle = Math.atan2(ty - cy, tx - cx);
    const heading     = (t.document.rotation ?? 0) * (Math.PI / 180);
    const relAngle    = attackAngle - heading;
    const norm        = ((relAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let hitQuadrant;
    if (norm < Math.PI / 4 || norm >= 7 * Math.PI / 4) hitQuadrant = "bow";
    else if (norm < 3 * Math.PI / 4) hitQuadrant = "starboard";
    else if (norm < 5 * Math.PI / 4) hitQuadrant = "stern";
    else hitQuadrant = "port";
    emitToGM("torpedoDamage", {
      targetActorId: t.document.actorId,
      torName: this.actor.name,
      torImg:  this.actor.img,
      damage,
      diceFormula,
      hitQuadrant,
      traits: sys.traits,
    });
  }

  if (torpedoTargets.length > 0 || craftTargets.length > 0) {
    const craftDamages = craftTargets.map(t => {
      const dist = _closestEdgeDist(cx, cy, t, gs);
      const outerDist  = Math.min(Math.max(0, dist - gs), radiusPx - gs);
      const outerRange = Math.max(1, radiusPx - gs);
      const decay = dist <= gs ? 1 : 1 - 0.75 * (outerDist / outerRange);
      return {
        tokenId: t.document.id,
        actorId: t.document.actorId,
        damage:  Math.max(1, Math.round(baseDmg * warheads * decay)),
      };
    });
    emitToGM("blastOrdnance", {
      torpedoTokenIds: torpedoTargets.map(t => t.document.id),
      craftDamages,
      torName: this.actor.name,
    });
  }

  TorpedoOverlay.hide();
  const tokenDoc = token.document;
  emitToAll("playWeaponAnimation", {
    weaponCategory: "torpedo_detonation",
    fireMode: "",
    firingActorId: null,
    targetTokenId: tokenDoc.id,
    totalHits:    targets.length > 0 ? 1 : 0,
    totalSalvo:   1,
    isNpcFire:    false,
    blastRadius:  sys.payloadRadius ?? 1,
  });
  if (token._animation) await CanvasAnimation.terminateAnimation(token._animation);
  await new Promise(r => setTimeout(r, 2000));
  await canvas.scene.deleteEmbeddedDocuments("Token", [tokenDoc.id]);
}

export const OrdnanceSheetMixin = (BaseClass) => {
  // Named class for debuggability
  class OrdnanceSheetBase extends BaseClass {

    static DEFAULT_OPTIONS = {
      classes: ["vehicle", "shipcombat-ship", "shipcombat-ordnance"],
      actions: {
        confirmHelm:      _onOrdConfirmHelm,
        detonate:         _onOrdDetonate,
        markTurnComplete: _onOrdMarkTurnComplete,
        attack:           _onOrdAttack,
      },
      position: { width: 380, height: 520 },
      defaultTab: "main",
    };

    static TABS = {
      main:   { id: "main",   group: "primary", label: "SHIPCOMBAT.Tab.Ordnance" },
      config: { id: "config", group: "primary", label: "SHIPCOMBAT.Tab.Configuration" },
    };

    static PARTS = {
      header: {
        template: `modules/${CORE_MODULE_ID}/templates/actor/sheets/ordnance-header.hbs`,
        classes: ["vehicle-header"],
      },
      tabs:   { template: "templates/generic/tab-navigation.hbs" },
      main: {
        template: `modules/${CORE_MODULE_ID}/templates/actor/sheets/ordnance-main.hbs`,
        scrollable: [""],
      },
      config: {
        template: `modules/${CORE_MODULE_ID}/templates/actor/sheets/ordnance-config.hbs`,
        scrollable: [""],
      },
    };

    get isEditable() {
      if (game.user.isGM) return true;
      const ship = ShipCombatState.ship;
      return ship?.system?.roles?.[game.user.id] === "ordnance";
    }

    _prepareTabs() {
      const tabs = super._prepareTabs();
      if (!this.actor.isOwner) delete tabs.config;

      const subtype = SystemAdapter.current.getShipData(this.actor).subtype ?? "";
      if (subtype === "strikeCraft") {
        const craftType = SystemAdapter.current.getShipData(this.actor).craftType ?? "fighter";
        tabs.main.label = craftType === "bomber"
          ? "SHIPCOMBAT.CraftType.Bomber"
          : "SHIPCOMBAT.CraftType.Fighter";
      } else if (subtype === "torpedo") {
        tabs.main.label = "SHIPCOMBAT.Tab.Warhead";
      }
      return tabs;
    }

    _configureRenderOptions(options) {
      super._configureRenderOptions(options);
      if (!this.actor.isOwner && options.parts) {
        options.parts = options.parts.filter(p => p !== "config");
      }
    }

    formatConditions() { return []; }

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      context.conditions = [];
      const sys = SystemAdapter.current.getShipData(this.actor);

      const subtype     = sys.subtype ?? "";
      const _isTorpedo    = subtype === "torpedo";
      const _isStrikeCraft = subtype === "strikeCraft";

      context.sys           = sys;
      context.owner         = this.actor.isOwner;
      context.isTorpedo     = _isTorpedo;
      context.isStrikeCraft = _isStrikeCraft;
      context.subtype       = subtype;

      // ── Bar percentages ──────────────────────────────────────────────────
      context.fuelPct = sys.fuel.max > 0
        ? Math.round((sys.fuel.value / sys.fuel.max) * 100) : 0;
      // hull.value = units lost; display follows hullDisplayMode setting
      const _hullDisp = hullDisplay(sys.hull.value, sys.hull.max);
      context.hullPct          = _hullDisp.pct;
      context.hullDisplayValue = _hullDisp.displayValue;
      context.hullRemaining    = Math.max(0, (sys.hull.max ?? 0) - (sys.hull.value ?? 0));
      context.hullBarLabel     = _hullDisp.isDamageTaken
        ? (context.isStrikeCraft
            ? game.i18n.localize("SHIPCOMBAT.Label.FlightLosses")
            : game.i18n.localize("SHIPCOMBAT.Label.WarheadsLost"))
        : (context.isStrikeCraft
            ? game.i18n.localize("SHIPCOMBAT.Label.FlightsRemaining")
            : game.i18n.localize("SHIPCOMBAT.Label.WarheadsRemaining"));

      if (_isStrikeCraft) {
        context.ammoPct = sys.ammo.max > 0
          ? Math.round((sys.ammo.value / sys.ammo.max) * 100) : 0;
        context.effectiveSpeed = sys.rtb ? sys.movement.speed * 2 : sys.movement.speed;
        context.craftTypeLabel = sys.craftType === "bomber"
          ? game.i18n.localize("SHIPCOMBAT.CraftType.Bomber")
          : game.i18n.localize("SHIPCOMBAT.CraftType.Fighter");
      }

      // ── Active weapon traits ──────────────────────────────────────────────
      context.activeTraits = [];
      if (sys.traits?.rend > 0)              context.activeTraits.push(`Rend ${sys.traits.rend}`);
      if (sys.traits?.armourPenetration > 0) context.activeTraits.push(`AP ${sys.traits.armourPenetration}`);
      if (sys.traits?.shieldBurn > 0)        context.activeTraits.push(`Shield Burn ${sys.traits.shieldBurn}`);
      if (sys.traits?.shieldBypass)          context.activeTraits.push("Shield Bypass");

      // ── Helm ──────────────────────────────────────────────────────────────
      const speed = sys.movement.speed ?? 0;
      const mano  = sys.movement.maneuverability ?? 0;
      const helm  = sys.helm ?? {};
      const isRealistic    = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
      const velocityMagCtx = isRealistic
        ? Math.floor(Math.hypot(helm.velocityX ?? 0, helm.velocityY ?? 0)) : 0;
      const minMove      = isRealistic ? velocityMagCtx : Math.ceil(speed / 2);
      const totalSquares = minMove + speed;
      const thrustPct    = helm.thrustPct ?? 0;

      // Torpedo has variable powerMax; strike craft always 100
      const powerMax = _isTorpedo
        ? (sys.designated ? 0 : (sys.powerBoostActive ? 200 : 100))
        : 100;

      const minMovePct = powerMax > 0 && totalSquares > 0
        ? Math.round(minMove / totalSquares * powerMax) : 0;

      context.helm = {
        speed,
        mano,
        minMove,
        minMovePct,
        maxBearing:           mano * 15,
        bearingMax:           mano * 15,
        bearing:              helm.bearing ?? 0,
        thrustPct,
        powerMax,
        designated:           sys.designated ?? false,
        isRealistic,
        velocityX:            helm.velocityX ?? 0,
        velocityY:            helm.velocityY ?? 0,
        // bearingUsed always 0 for ordnance — ordnance uses linked actors so
        // actor-level accumulation would contaminate all tokens of the same template.
        bearingUsed:          0,
        momentumUsed:         0,
        bearingRemaining:     mano * 15,
        bearingBudgetTooltip: (() => {
          if (!isRealistic || typeof game === "undefined") return "";
          const bMax = mano * 15;
          return game.i18n.format("SHIPCOMBAT.Helm.BearingBudgetTooltip", { val: bMax, max: bMax });
        })(),
      };

      // ── Parent ship power bar data ────────────────────────────────────────
      const parentTokenId  = sys.parentShipTokenId ?? "";
      const parentToken    = parentTokenId ? canvas?.scene?.tokens.get(parentTokenId) : null;
      const parentSys      = parentToken?.actor?.system ?? {};
      const parentPilot    = parentSys.resources?.pilot ?? {};
      const parentOverdrive = parentPilot.overdrive ?? false;
      const shipPowerMax   = parentOverdrive ? 200 : 100;
      const shipFuelBurned = parentPilot.fuelBurned ?? 0;
      context.shipPower = {
        fuelBurned: shipFuelBurned,
        powerMax:   shipPowerMax,
        pct:        shipPowerMax > 0 ? Math.round((shipFuelBurned / shipPowerMax) * 100) : 0,
      };

      return context;
    }

    _onClose(options) {
      HelmPreview.hide();
      super._onClose?.(options);
    }

    _onRender(context, options) {
      super._onRender(context, options);
      const html = this.element;
      if (!html) return;

      const { isTorpedo: isTorp, isStrikeCraft: isSC } = context;

      // ── Helm slider setup (identical for both subtypes) ───────────────────
      const isRealistic  = context.helm.isRealistic;
      const bearingMax   = context.helm.maxBearing;
      const bearingUsed  = 0;   // always 0 for ordnance
      const bearingRemain = bearingMax;
      const momentumUsed = 0;
      const velocityMag  = isRealistic
        ? Math.floor(Math.hypot(context.helm.velocityX, context.helm.velocityY)) : 0;
      const momentumFloor = (isRealistic && velocityMag === 0) ? 100 : 0;

      // Bearing budget bar
      const bearingBudgetBar  = html.querySelector("[data-bearing-budget-bar]");
      const bearingBudgetDisp = html.querySelector("[data-bearing-budget-display]");
      const _syncBearingBudgetBar = (bearingAbs) => {
        if (!bearingBudgetBar || !bearingMax) return;
        const committed = (bearingUsed / bearingMax) * 100;
        const extra     = (Math.min(bearingAbs, bearingRemain) / bearingMax) * 100;
        bearingBudgetBar.style.setProperty("--committed", `${committed}%`);
        bearingBudgetBar.style.setProperty("--extra",     `${extra}%`);
        bearingBudgetBar.style.setProperty("--minmove",   "0%");
        if (bearingBudgetDisp) {
          bearingBudgetDisp.textContent =
            `${Math.round(bearingUsed + Math.min(bearingAbs, bearingRemain))}`;
        }
      };
      _syncBearingBudgetBar(Math.abs(context.helm.bearing ?? 0));

      // Carry bar
      const carryBarEl = html.querySelector("[data-helm-carry-bar]");
      const carryInput = html.querySelector("[data-helm-carry]");
      const carryDisp  = html.querySelector("[data-carry-display]");
      const _syncCarryBar = (carryPct) => {
        if (!carryBarEl) return;
        carryBarEl.style.setProperty("--committed", `${momentumUsed}%`);
        carryBarEl.style.setProperty("--extra",     `${Math.max(0, carryPct - momentumUsed)}%`);
        carryBarEl.style.setProperty("--minmove",   "0%");
        if (carryDisp) carryDisp.textContent = `${Math.round(carryPct)}`;
      };
      if (carryInput) {
        carryInput.value = String(momentumFloor);
        if (isTorp && context.helm.designated) carryInput.disabled = true;
        carryInput.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
        carryInput.addEventListener("input", ev => {
          ev.stopPropagation();
          const val = Math.max(momentumFloor, Math.min(100, Number(ev.target.value)));
          if (val !== Number(ev.target.value)) ev.target.value = String(val);
          _syncCarryBar(val);
          _updatePreview();
        }, true);
      }
      _syncCarryBar(momentumFloor);

      // Canvas ghost preview
      const _updatePreview = () => {
        const token = this.actor.getActiveTokens()?.[0];
        if (!token || !canvas?.ready) return;
        const sys = SystemAdapter.current.getShipData(this.actor);
        const spd  = sys.movement.speed ?? 0;
        const h    = sys.helm ?? {};
        const committedPct = h.thrustPct ?? 0;
        const pMax = isTorp ? (sys.powerBoostActive ? 200 : 100) : 100;
        const minMv = Math.ceil(spd / 2);
        const totSq = minMv + spd;

        const curBearing = parseInt(html.querySelector("[data-helm-bearing]")?.value) || 0;
        const curFuel    = parseInt(html.querySelector("[data-helm-fuel]")?.value)    || 0;
        const deltaSq = (curFuel - committedPct) / pMax * totSq;

        if (isRealistic) {
          const vx = h.velocityX ?? 0;
          const vy = h.velocityY ?? 0;
          const velMag = Math.hypot(vx, vy);
          const thrustArg = deltaSq > 0 ? deltaSq * 100 / spd : 0;
          if (velMag === 0 && thrustArg === 0) { HelmPreview.hide(); return; }
          const curCarry = parseInt(html.querySelector("[data-helm-carry]")?.value) || 0;
          const projected = HelmPreview.projectPositionRealistic(token, curBearing, thrustArg, spd, vx, vy, curCarry);
          if (!projected) { HelmPreview.hide(); return; }
          HelmPreview.show(token, projected);
          HelmPreview.updateLineRealistic(curBearing, thrustArg, spd, vx, vy, curCarry);
        } else {
          if (deltaSq <= 0) { HelmPreview.hide(); return; }
          const thrustArg = deltaSq * 100 / totSq;
          const projected = HelmPreview.projectPosition(token, curBearing, thrustArg, spd, minMv);
          if (!projected) { HelmPreview.hide(); return; }
          HelmPreview.show(token, projected);
          HelmPreview.updateLine(curBearing, thrustArg, spd, minMv);
        }
      };

      // Bearing slider
      const bearingSlider  = html.querySelector("[data-helm-bearing]");
      const bearingDisplay = html.querySelector("[data-bearing-display]");
      if (bearingSlider) {
        if (isRealistic) {
          const sliderMax = Math.min(bearingRemain, 180);
          bearingSlider.min = String(-sliderMax);
          bearingSlider.max = String(sliderMax);
        }
        if (isTorp && context.helm.designated) bearingSlider.disabled = true;
        bearingSlider.addEventListener("input", (e) => {
          let val = Number(e.target.value);
          if (isRealistic && bearingMax > 0 && Math.abs(val) > bearingRemain) {
            val = Math.sign(val || 1) * bearingRemain;
            e.target.value = String(val);
          }
          if (bearingDisplay) bearingDisplay.textContent = `${val}`;
          _syncBearingBudgetBar(Math.abs(val));
          _updatePreview();
        });
      }

      // Power/fuel bar
      const powerBarEl  = html.querySelector("[data-helm-power-bar]");
      const fuelSlider  = html.querySelector("[data-helm-fuel]");
      const fuelDisplay = html.querySelector("[data-fuel-display]");
      const thrustPct   = context.helm.thrustPct;
      const powerMax    = context.helm.powerMax;
      const minMovePct  = context.helm.minMovePct;

      const _syncPowerBar = (selectedPct) => {
        if (!powerMax) return;
        if (isRealistic) {
          if (powerBarEl) {
            powerBarEl.style.setProperty("--committed", "0%");
            powerBarEl.style.setProperty("--extra",     `${(selectedPct / powerMax) * 100}%`);
            powerBarEl.style.setProperty("--minmove",   "0%");
            const line = powerBarEl.querySelector(".shipcombat-power-minmove-line");
            if (line) line.style.display = "none";
          }
        } else {
          const ratio     = 100 / powerMax;
          const committed = thrustPct * ratio;
          const extra     = Math.max(0, selectedPct - thrustPct) * ratio;
          const effectiveMinmove = selectedPct >= minMovePct ? 0 : (minMovePct / powerMax) * 100;
          if (powerBarEl) {
            powerBarEl.style.setProperty("--committed", `${committed}%`);
            powerBarEl.style.setProperty("--extra",     `${extra}%`);
            powerBarEl.style.setProperty("--minmove",   `${effectiveMinmove}%`);
            const line = powerBarEl.querySelector(".shipcombat-power-minmove-line");
            if (line) line.style.display = effectiveMinmove > 0 ? "" : "none";
          }
        }
        if (fuelDisplay) fuelDisplay.textContent = `${selectedPct}`;
      };

      if (fuelSlider) {
        fuelSlider.value = String(thrustPct);
        if (isTorp && context.helm.designated) fuelSlider.disabled = true;
        fuelSlider.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
        fuelSlider.addEventListener("input", (ev) => {
          ev.stopPropagation();
          let val = Math.max(thrustPct, Math.min(powerMax, Number(ev.target.value)));
          if (val !== Number(ev.target.value)) ev.target.value = String(val);
          _syncPowerBar(val);
          _updatePreview();
        }, true);
      }
      _syncPowerBar(thrustPct);
      _updatePreview();

      // ── Subtype-specific UI hookups ────────────────────────────────────────
      if (isTorp) {
        const detonateBtn = html.querySelector("[data-action='detonate']");
        if (detonateBtn) {
          if (context.helm.designated) detonateBtn.disabled = true;
          detonateBtn.addEventListener("mouseenter", () => {
            const token = this.actor.getActiveTokens()?.[0];
            if (token) TorpedoOverlay.show(token, SystemAdapter.current.getShipData(this.actor).payloadRadius);
          });
          detonateBtn.addEventListener("mouseleave", () => TorpedoOverlay.hide());
        }
      }

      if (isSC) {
        const attackBtn = html.querySelector("[data-action='attack']");
        if (attackBtn) {
          attackBtn.addEventListener("mouseenter", () => StrikeCraftArcOverlay.show(this.actor));
          attackBtn.addEventListener("mouseleave", () => StrikeCraftArcOverlay.hide());
        }
      }
    }

    async _onChangeInput(event) {
      const input = event.currentTarget;
      if (input.name?.startsWith("system.")) {
        input.name = SystemAdapter.current.systemPath(input.name.slice("system.".length));
      }
      return super._onChangeInput(event);
    }
  }

  return OrdnanceSheetBase;
};

function _closestEdgeDist(px, py, token, gs) {
  const tw = token.document.width  * gs;
  const th = token.document.height * gs;
  const clx = Math.max(token.x, Math.min(px, token.x + tw));
  const cly = Math.max(token.y, Math.min(py, token.y + th));
  return Math.sqrt((px - clx) ** 2 + (py - cly) ** 2);
}

// ══════════════════════════════════════════════════════════════════════════════
// Action dispatch map (shared by AppV2 DEFAULT_OPTIONS.actions and AppV1 handler)
// ══════════════════════════════════════════════════════════════════════════════

const ORD_ACTIONS = {
  confirmHelm:      _onOrdConfirmHelm,
  detonate:         _onOrdDetonate,
  markTurnComplete: _onOrdMarkTurnComplete,
  attack:           _onOrdAttack,
};

// ══════════════════════════════════════════════════════════════════════════════
// AppV1 ordnance sheet mixin
// ══════════════════════════════════════════════════════════════════════════════

/**
 * AppV1 (legacy ActorSheet) variant of OrdnanceSheetMixin.
 * Shares the same standalone action functions but adapts the lifecycle to
 * AppV1: getData / activateListeners / _updateObject.
 */
export const OrdnanceSheetV1Mixin = (BaseClass) => {
  class OrdnanceSheetV1Base extends BaseClass {

    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes:        [],
        width:          380,
        height:         520,
        template:       `modules/${CORE_MODULE_ID}/templates/actor/ordnance-v1.hbs`,
        tabs:           [{ navSelector: ".ordnance-sheet-tabs", contentSelector: ".ordnance-sheet-body", initial: "main" }],
        scrollY:        [".tab.active"],
        submitOnChange: true,
        closeOnSubmit:  false,
      });
    }

    get isEditable() {
      if (game.user.isGM) return true;
      return ShipCombatState.ship?.system?.roles?.[game.user.id] === "ordnance";
    }

    async getData(options = {}) {
      const base = await super.getData(options);
      const sys  = SystemAdapter.current.getShipData(this.actor);

      const subtype       = sys.subtype ?? "";
      const _isTorpedo    = subtype === "torpedo";
      const _isStrikeCraft = subtype === "strikeCraft";

      const fuelPct = sys.fuel.max > 0
        ? Math.round((sys.fuel.value / sys.fuel.max) * 100) : 0;
      const _hullDisp      = hullDisplay(sys.hull.value, sys.hull.max);
      const hullPct        = _hullDisp.pct;
      const hullDisplayValue = _hullDisp.displayValue;
      const hullRemaining  = Math.max(0, (sys.hull.max ?? 0) - (sys.hull.value ?? 0));
      const hullBarLabel   = _hullDisp.isDamageTaken
        ? (_isStrikeCraft
            ? game.i18n.localize("SHIPCOMBAT.Label.FlightLosses")
            : game.i18n.localize("SHIPCOMBAT.Label.WarheadsLost"))
        : (_isStrikeCraft
            ? game.i18n.localize("SHIPCOMBAT.Label.FlightsRemaining")
            : game.i18n.localize("SHIPCOMBAT.Label.WarheadsRemaining"));

      let ammoPct, effectiveSpeed, craftTypeLabel;
      if (_isStrikeCraft) {
        ammoPct        = sys.ammo.max > 0 ? Math.round((sys.ammo.value / sys.ammo.max) * 100) : 0;
        effectiveSpeed = sys.rtb ? sys.movement.speed * 2 : sys.movement.speed;
        craftTypeLabel = sys.craftType === "bomber"
          ? game.i18n.localize("SHIPCOMBAT.CraftType.Bomber")
          : game.i18n.localize("SHIPCOMBAT.CraftType.Fighter");
      }

      const activeTraits = [];
      if (sys.traits?.rend > 0)              activeTraits.push(`Rend ${sys.traits.rend}`);
      if (sys.traits?.armourPenetration > 0) activeTraits.push(`AP ${sys.traits.armourPenetration}`);
      if (sys.traits?.shieldBurn > 0)        activeTraits.push(`Shield Burn ${sys.traits.shieldBurn}`);
      if (sys.traits?.shieldBypass)          activeTraits.push("Shield Bypass");

      const speed = sys.movement.speed ?? 0;
      const mano  = sys.movement.maneuverability ?? 0;
      const helm  = sys.helm ?? {};
      const isRealistic    = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
      const velocityMagCtx = isRealistic
        ? Math.floor(Math.hypot(helm.velocityX ?? 0, helm.velocityY ?? 0)) : 0;
      const minMove    = isRealistic ? velocityMagCtx : Math.ceil(speed / 2);
      const totalSquares = minMove + speed;
      const thrustPct  = helm.thrustPct ?? 0;
      const powerMax   = _isTorpedo
        ? (sys.designated ? 0 : (sys.powerBoostActive ? 200 : 100)) : 100;
      const minMovePct = powerMax > 0 && totalSquares > 0
        ? Math.round(minMove / totalSquares * powerMax) : 0;

      const mainTabLabel = _isStrikeCraft
        ? (sys.craftType === "bomber" ? "SHIPCOMBAT.CraftType.Bomber" : "SHIPCOMBAT.CraftType.Fighter")
        : _isTorpedo ? "SHIPCOMBAT.Tab.Warhead"
        :              "SHIPCOMBAT.Tab.SelectOrdnanceType";

      const parentTokenId   = sys.parentShipTokenId ?? "";
      const parentToken     = parentTokenId ? canvas?.scene?.tokens.get(parentTokenId) : null;
      const parentPilot     = parentToken?.actor?.system?.resources?.pilot ?? {};
      const parentOverdrive = parentPilot.overdrive ?? false;
      const shipPowerMax    = parentOverdrive ? 200 : 100;
      const shipFuelBurned  = parentPilot.fuelBurned ?? 0;

      return Object.assign({}, base, {
        actor:        this.actor,
        sys,
        owner:        this.actor.isOwner,
        isTorpedo:    _isTorpedo,
        isStrikeCraft: _isStrikeCraft,
        // tabsById: provides {id, cssClass} objects for each AppV1 tab so that
        // the self-wrapping tab partials render with the correct data-tab value.
        tabsById: {
          main:   { id: "main",   cssClass: "" },
          config: { id: "config", cssClass: "" },
        },
        subtype,
        mainTabLabel,
        fuelPct,
        hullPct,
        hullRemaining,
        hullDisplayValue,
        hullBarLabel,
        ammoPct,
        effectiveSpeed,
        craftTypeLabel,
        activeTraits,
        conditions: [],
        helm: {
          speed, mano, minMove, minMovePct,
          maxBearing:  mano * 15,
          bearingMax:  mano * 15,
          bearing:     helm.bearing ?? 0,
          thrustPct,
          powerMax,
          designated:  sys.designated ?? false,
          isRealistic,
          velocityX:   helm.velocityX ?? 0,
          velocityY:   helm.velocityY ?? 0,
          bearingUsed: 0, momentumUsed: 0,
          bearingRemaining: mano * 15,
        },
        shipPower: {
          fuelBurned: shipFuelBurned,
          powerMax:   shipPowerMax,
          pct: shipPowerMax > 0 ? Math.round((shipFuelBurned / shipPowerMax) * 100) : 0,
        },
      });
    }

    activateListeners($html) {
      super.activateListeners($html);
      const el    = $html[0];
      const sheet = this;

      // Proxy so action functions see `this.element` as the raw form DOM,
      // not the jQuery-wrapped AppV1 window element.
      const sheetProxy = new Proxy(this, {
        get(target, prop, receiver) {
          if (prop === "element") return el;
          const val = Reflect.get(target, prop, receiver);
          return typeof val === "function" ? val.bind(target) : val;
        },
      });

      $html.on("click", "[data-action]", async (ev) => {
        const handler = ORD_ACTIONS[ev.currentTarget.dataset.action];
        if (handler) await handler.call(sheetProxy, ev, ev.currentTarget);
      });

      // Derive context values from sys for helm slider wiring
      const sys         = SystemAdapter.current.getShipData(this.actor);
      const subtype     = sys.subtype ?? "";
      const isTorp      = subtype === "torpedo";
      const isSC        = subtype === "strikeCraft";
      const isRealistic = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
      const speed       = sys.movement.speed ?? 0;
      const mano        = sys.movement.maneuverability ?? 0;
      const helm        = sys.helm ?? {};
      const velocityMag = isRealistic ? Math.floor(Math.hypot(helm.velocityX ?? 0, helm.velocityY ?? 0)) : 0;
      const momentumFloor  = (isRealistic && velocityMag === 0) ? 100 : 0;
      const bearingMax     = mano * 15;
      const bearingRemain  = bearingMax;
      const thrustPct      = helm.thrustPct ?? 0;
      const powerMax       = isTorp ? (sys.powerBoostActive ? 200 : 100) : 100;
      const minMove        = isRealistic ? velocityMag : Math.ceil(speed / 2);
      const totalSq        = minMove + speed;
      const minMovePct     = powerMax > 0 && totalSq > 0 ? Math.round(minMove / totalSq * powerMax) : 0;
      const designated     = sys.designated ?? false;

      // ── Bearing budget bar ────────────────────────────────────────────────
      const bearingBudgetBar  = el.querySelector("[data-bearing-budget-bar]");
      const bearingBudgetDisp = el.querySelector("[data-bearing-budget-display]");
      const _syncBearingBudgetBar = (bearingAbs) => {
        if (!bearingBudgetBar || !bearingMax) return;
        const extra = (Math.min(bearingAbs, bearingRemain) / bearingMax) * 100;
        bearingBudgetBar.style.setProperty("--committed", "0%");
        bearingBudgetBar.style.setProperty("--extra",     `${extra}%`);
        bearingBudgetBar.style.setProperty("--minmove",   "0%");
        if (bearingBudgetDisp) bearingBudgetDisp.textContent = `${Math.round(Math.min(bearingAbs, bearingRemain))}`;
      };
      _syncBearingBudgetBar(Math.abs(helm.bearing ?? 0));

      // ── Carry (momentum) bar ──────────────────────────────────────────────
      const carryBarEl = el.querySelector("[data-helm-carry-bar]");
      const carryInput = el.querySelector("[data-helm-carry]");
      const carryDisp  = el.querySelector("[data-carry-display]");
      const _syncCarryBar = (carryPct) => {
        if (!carryBarEl) return;
        carryBarEl.style.setProperty("--committed", "0%");
        carryBarEl.style.setProperty("--extra",     `${Math.max(0, carryPct)}%`);
        carryBarEl.style.setProperty("--minmove",   "0%");
        if (carryDisp) carryDisp.textContent = `${Math.round(carryPct)}`;
      };
      if (carryInput) {
        carryInput.value = String(momentumFloor);
        if (isTorp && designated) carryInput.disabled = true;
        carryInput.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
        carryInput.addEventListener("input", ev => {
          ev.stopPropagation();
          const val = Math.max(momentumFloor, Math.min(100, Number(ev.target.value)));
          if (val !== Number(ev.target.value)) ev.target.value = String(val);
          _syncCarryBar(val);
          _updatePreview();
        }, true);
      }
      _syncCarryBar(momentumFloor);

      // ── Canvas ghost preview ──────────────────────────────────────────────
      const _updatePreview = () => {
        const token = sheet.actor.getActiveTokens()?.[0];
        if (!token || !canvas?.ready) return;
        const curSys  = SystemAdapter.current.getShipData(sheet.actor);
        const spd     = curSys.movement.speed ?? 0;
        const h       = curSys.helm ?? {};
        const pMax    = isTorp ? (curSys.powerBoostActive ? 200 : 100) : 100;
        const minMv   = Math.ceil(spd / 2);
        const totSq   = minMv + spd;
        const committedPct = h.thrustPct ?? 0;
        const curBearing   = parseInt(el.querySelector("[data-helm-bearing]")?.value) || 0;
        const curFuel      = parseInt(el.querySelector("[data-helm-fuel]")?.value)    || 0;
        const deltaSq      = (curFuel - committedPct) / pMax * totSq;
        if (isRealistic) {
          const vx = h.velocityX ?? 0;
          const vy = h.velocityY ?? 0;
          const velMag  = Math.hypot(vx, vy);
          const thrustArg = deltaSq > 0 ? deltaSq * 100 / spd : 0;
          if (velMag === 0 && thrustArg === 0) { HelmPreview.hide(); return; }
          const curCarry = parseInt(el.querySelector("[data-helm-carry]")?.value) || 0;
          const projected = HelmPreview.projectPositionRealistic(token, curBearing, thrustArg, spd, vx, vy, curCarry);
          if (!projected) { HelmPreview.hide(); return; }
          HelmPreview.show(token, projected);
          HelmPreview.updateLineRealistic(curBearing, thrustArg, spd, vx, vy, curCarry);
        } else {
          if (deltaSq <= 0) { HelmPreview.hide(); return; }
          const thrustArg = deltaSq * 100 / totSq;
          const projected = HelmPreview.projectPosition(token, curBearing, thrustArg, spd, minMv);
          if (!projected) { HelmPreview.hide(); return; }
          HelmPreview.show(token, projected);
          HelmPreview.updateLine(curBearing, thrustArg, spd, minMv);
        }
      };

      // ── Bearing slider ────────────────────────────────────────────────────
      const bearingSlider  = el.querySelector("[data-helm-bearing]");
      const bearingDisplay = el.querySelector("[data-bearing-display]");
      if (bearingSlider) {
        if (isRealistic) {
          const sliderMax  = Math.min(bearingRemain, 180);
          bearingSlider.min = String(-sliderMax);
          bearingSlider.max = String(sliderMax);
        }
        if (isTorp && designated) bearingSlider.disabled = true;
        bearingSlider.addEventListener("input", (e) => {
          let val = Number(e.target.value);
          if (isRealistic && bearingMax > 0 && Math.abs(val) > bearingRemain) {
            val = Math.sign(val || 1) * bearingRemain;
            e.target.value = String(val);
          }
          if (bearingDisplay) bearingDisplay.textContent = `${val}`;
          _syncBearingBudgetBar(Math.abs(val));
          _updatePreview();
        });
      }

      // ── Power/fuel bar ────────────────────────────────────────────────────
      const powerBarEl  = el.querySelector("[data-helm-power-bar]");
      const fuelSlider  = el.querySelector("[data-helm-fuel]");
      const fuelDisplay = el.querySelector("[data-fuel-display]");

      const _syncPowerBar = (selectedPct) => {
        if (!powerMax) return;
        if (isRealistic) {
          if (powerBarEl) {
            powerBarEl.style.setProperty("--committed", "0%");
            powerBarEl.style.setProperty("--extra",     `${(selectedPct / powerMax) * 100}%`);
            powerBarEl.style.setProperty("--minmove",   "0%");
            const line = powerBarEl.querySelector(".shipcombat-power-minmove-line");
            if (line) line.style.display = "none";
          }
        } else {
          const ratio               = 100 / powerMax;
          const committed           = thrustPct * ratio;
          const extra               = Math.max(0, selectedPct - thrustPct) * ratio;
          const effectiveMinmove    = selectedPct >= minMovePct ? 0 : (minMovePct / powerMax) * 100;
          if (powerBarEl) {
            powerBarEl.style.setProperty("--committed", `${committed}%`);
            powerBarEl.style.setProperty("--extra",     `${extra}%`);
            powerBarEl.style.setProperty("--minmove",   `${effectiveMinmove}%`);
            const line = powerBarEl.querySelector(".shipcombat-power-minmove-line");
            if (line) line.style.display = effectiveMinmove > 0 ? "" : "none";
          }
        }
        if (fuelDisplay) fuelDisplay.textContent = `${selectedPct}`;
      };

      if (fuelSlider) {
        fuelSlider.value = String(thrustPct);
        if (isTorp && designated) fuelSlider.disabled = true;
        fuelSlider.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
        fuelSlider.addEventListener("input", (ev) => {
          ev.stopPropagation();
          let val = Math.max(thrustPct, Math.min(powerMax, Number(ev.target.value)));
          if (val !== Number(ev.target.value)) ev.target.value = String(val);
          _syncPowerBar(val);
          _updatePreview();
        }, true);
      }
      _syncPowerBar(thrustPct);
      _updatePreview();

      // ── Subtype-specific UI hookups ────────────────────────────────────────
      if (isTorp) {
        const detonateBtn = el.querySelector("[data-action='detonate']");
        if (detonateBtn) {
          if (designated) detonateBtn.disabled = true;
          detonateBtn.addEventListener("mouseenter", () => {
            const token = sheet.actor.getActiveTokens()?.[0];
            if (token) TorpedoOverlay.show(token, SystemAdapter.current.getShipData(sheet.actor).payloadRadius);
          });
          detonateBtn.addEventListener("mouseleave", () => TorpedoOverlay.hide());
        }
      }

      if (isSC) {
        const attackBtn = el.querySelector("[data-action='attack']");
        if (attackBtn) {
          attackBtn.addEventListener("mouseenter", () => StrikeCraftArcOverlay.show(sheet.actor));
          attackBtn.addEventListener("mouseleave", () => StrikeCraftArcOverlay.hide());
        }
      }
    }

    async _updateObject(event, formData) {
      const keysToRemap = Object.keys(formData).filter(k => k.startsWith("system."));
      for (const key of keysToRemap) {
        const newKey = SystemAdapter.current.systemPath(key.slice("system.".length));
        if (newKey !== key) {
          formData[newKey] = formData[key];
          delete formData[key];
        }
      }
      return super._updateObject(event, formData);
    }

    close(options) {
      HelmPreview.hide();
      return super.close(options);
    }
  }

  return OrdnanceSheetV1Base;
};
