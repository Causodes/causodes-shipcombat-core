/**
 * Pilot / Helmsman role – all helm-related action handlers, state management,
 * and preview logic extracted from ShipSheet.
 *
 * Every function in PILOT_ACTIONS is a static action handler (bound to the sheet
 * instance by Foundry's ApplicationV2 action system).
 * The lifecycle hooks (onRender, updatePreview) must be called from ShipSheet.
 */
import { emitToGM } from "../socket.js";
import { HelmPreview } from "../canvas/HelmPreview.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { RamTargetPopup } from "../apps/RamTargetPopup.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { MODULE_ID } from "../constants.js";
import { getEffectiveSkillSpec } from "../actors/ship/ShipSheetMixin.js";

// ── Action handlers (static, `this` = sheet instance) ──────────────────────

async function _onAllocBonus(event, target) {
  const sys = this.actor.system;
  const stat  = target.dataset.stat;
  const delta = Number(target.dataset.delta);
  const pilotingSL  = sys.resources?.pilot?.pilotingSL  ?? 0;
  const allocSpeed   = sys.resources?.pilot?.allocSpeed   ?? 0;
  const allocMano    = sys.resources?.pilot?.allocMano    ?? 0;
  const allocEvasion = sys.resources?.pilot?.allocEvasion ?? 0;
  const fuelBurned   = sys.resources?.pilot?.fuelBurned   ?? 0;

  if (fuelBurned > 0) return;

  let newAllocSpeed   = allocSpeed;
  let newAllocMano    = allocMano;
  let newAllocEvasion = allocEvasion;

  if (stat === "speed") {
    newAllocSpeed = Math.max(0, allocSpeed + delta);
  } else if (stat === "mano") {
    newAllocMano = Math.max(0, allocMano + delta);
  } else if (stat === "evasion") {
    newAllocEvasion = Math.max(0, allocEvasion + delta);
  }

  if (newAllocSpeed + newAllocMano + newAllocEvasion > pilotingSL) return;

  if (stat === "speed") {
    emitToGM("updateResource", { roleId: "pilot", key: "allocSpeed",   value: newAllocSpeed });
  } else if (stat === "mano") {
    emitToGM("updateResource", { roleId: "pilot", key: "allocMano",    value: newAllocMano });
  } else if (stat === "evasion") {
    emitToGM("updateResource", { roleId: "pilot", key: "allocEvasion", value: newAllocEvasion });
  }
}

async function _onRollPiloting() {
  const sys = this.actor.system;
  const crewSize = sys.crewSize ?? 6;
  const is3man = crewSize <= 3;
  // In 3-man mode the Engineer handles helm; roll Engineering instead of Piloting.
  // Look up the engineer crewActor first; fall back to pilot slot for 4-6 man.
  let crewActor = null;

  if (is3man) {
    const enginRef = sys.crewActors?.engineer;
    if (enginRef?.uuid) {
      try { crewActor = await fromUuid(enginRef.uuid); } catch { /* ignore */ }
    }
    if (!crewActor) {
      const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "engineer");
      if (entry) {
        const user = game.users.get(entry[0]);
        crewActor = user?.character ?? null;
      }
    }
    if (!crewActor) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoPilotAssigned"));
    }
  } else {
    const pilotRef = sys.crewActors?.pilot;
    if (pilotRef?.uuid) {
      try { crewActor = await fromUuid(pilotRef.uuid); } catch { /* ignore */ }
    }
    if (!crewActor) {
      const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "pilot");
      if (entry) {
        const user = game.users.get(entry[0]);
        crewActor = user?.character ?? null;
      }
    }
    if (!crewActor) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoPilotAssigned"));
    }
  }

  const skillKey = is3man
    ? (sys.roleSkillOverrides?.engineer ?? "engineering")
    : (sys.roleSkillOverrides?.pilot     ?? "pilot");
  const result = await SystemAdapter.current.rollSkillTest(crewActor, skillKey);
  if (!result) return;

  const sl = Math.max(0, result.SL);
  emitToGM("updateResource", { roleId: "pilot", key: "pilotingSL",   value: sl });
  emitToGM("updateResource", { roleId: "pilot", key: "allocSpeed",   value: 0  });
  emitToGM("updateResource", { roleId: "pilot", key: "allocMano",    value: 0  });
  emitToGM("updateResource", { roleId: "pilot", key: "allocEvasion", value: 0  });

  const msgId = result.messageId ?? "";
  if (msgId) {
    emitToGM("updateResource", { roleId: "pilot", key: "pilotingMessageId", value: msgId });
  }
}

async function _onResetHelm() {
  emitToGM("resetHelmState", {});
}

async function _onConfirmHelm() {
  const token = this.actor.getActiveTokens()?.[0];
  if (!token) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return;
  }

  const sys        = this.actor.system;
  const speed      = (sys.movement?.speed ?? 6) + (sys.resources?.pilot?.allocSpeed ?? 0);
  const fuelBurned = sys.resources?.pilot?.fuelBurned ?? 0;
  const fuelSlider = this._helmState?.fuelSlider ?? fuelBurned;
  const bearing    = this._helmState?.bearing ?? 0;

  const thrustPct  = fuelSlider - fuelBurned;
  const prevTurnMove = sys.resources?.pilot?.prevTurnMove ?? 0;
  const minMove      = Math.ceil(prevTurnMove / 2);
  const isFirstCommit = fuelBurned === 0;
  const driftUnits = isFirstCommit ? minMove : 0;

  const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";

  if (isRealistic) {
    const vx = sys.resources?.pilot?.velocityX ?? 0;
    const vy = sys.resources?.pilot?.velocityY ?? 0;
    const velMag = Math.hypot(vx, vy);
    const carryPct = this._helmState?.carryPct ?? 0;
    if (thrustPct <= 0 && velMag === 0 && bearing === 0) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Helm.WarnNoFuel"));
      return;
    }
    const projected = HelmPreview.projectPositionRealistic(token, bearing, thrustPct, speed, vx, vy, carryPct);
    if (!projected) return;
    HelmPreview.hide();
    const waypoints = HelmPreview.projectWaypointsRealistic(token, bearing, thrustPct, speed, vx, vy, carryPct);
    // Compute new velocity: old vel + thrust vector
    const h0 = (token.document.rotation - 90) * (Math.PI / 180);
    const thrustDir = h0 + bearing * (Math.PI / 180);
    const thrustMag = (thrustPct / 100) * speed;
    const newVx = vx + Math.cos(thrustDir) * thrustMag;
    const newVy = vy + Math.sin(thrustDir) * thrustMag;
    emitToGM("confirmMovement", {
      fuelUsed:     fuelSlider,
      driftUsed:    0,
      speed,
      newX:         projected.x,
      newY:         projected.y,
      newRotation:  projected.rotation,
      waypoints,
      velocityX:    newVx,
      velocityY:    newVy,
      bearingDelta: Math.abs(bearing),
      momentumUsed: carryPct,
    });
    this._helmState = {
      ...this._helmState,
      bearing:   0,
      fuelSlider,
      confirmed: true,
    };
    return;
  }

  if (thrustPct <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Helm.WarnNoFuel"));
    return;
  }

  const projected = HelmPreview.projectPosition(token, bearing, thrustPct, speed, driftUnits);
  if (!projected) return;
  HelmPreview.hide();

  const waypoints = HelmPreview.projectWaypoints(token, bearing, thrustPct, speed, driftUnits);

  emitToGM("confirmMovement", {
    fuelUsed:       fuelSlider,
    driftUsed:      0,
    speed:          speed + driftUnits,
    newX:           projected.x,
    newY:           projected.y,
    newRotation:    projected.rotation,
    waypoints,
  });

  const round = sys.round ?? 0;
  this._helmState = {
    round,
    helmResetId: sys.resources?.pilot?.helmResetId ?? 0,
    bearing: 0,
    fuelSlider,
    confirmed: true,
  };
}

// ── Overcharge action handlers ──────────────────────────────────────────────

async function _onPilotRetrograde() {
  const sys = this.actor.system;
  if (!((sys.resources?.pilot?.coreCount ?? 0) > 0)) return;

  const token = this.actor.getActiveTokens()?.[0];
  if (!token) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return;
  }

  const retroValue   = this._retrogradeState?.value ?? 1;
  const prevTurnMove = sys.resources?.pilot?.prevTurnMove ?? 0;
  const minMove      = Math.ceil(prevTurnMove / 2);
  const backDist     = Math.max(0, retroValue - minMove);

  const projected = backDist > 0 ? HelmPreview.projectRetrograde(token, backDist) : null;
  const waypoints = backDist > 0 ? HelmPreview.projectRetrogradeWaypoints(token, backDist) : [];

  emitToGM("pilotRetrograde", {
    userId:      game.user.id,
    retroValue,
    newX:        projected?.x ?? token.document.x,
    newY:        projected?.y ?? token.document.y,
    newRotation: token.document.rotation,
    waypoints,
  });
}

async function _onPilotOverdrive() {
  const sys = this.actor.system;
  if (!((sys.resources?.pilot?.coreCount ?? 0) > 0)) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("SHIPCOMBAT.Dialog.OverdriveTitle") },
    content: `<p>${game.i18n.localize("SHIPCOMBAT.Dialog.OverdriveBody")}</p>`,
  });
  if (!confirmed) return;
  emitToGM("pilotOverdrive", { userId: game.user.id });
}

async function _onApToThrust() {
  const sys = this.actor.system;
  const ap = sys.resources?.engineer?.auxiliaryPower ?? 0;
  if (ap <= 0) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoAuxiliaryPower"));
    return;
  }
  emitToGM("apToThrust", { userId: game.user.id });
}

async function _onPilotStrafe() {
  const sys = this.actor.system;
  if (!((sys.resources?.pilot?.coreCount ?? 0) > 0)) return;

  const token = this.actor.getActiveTokens()?.[0];
  if (!token) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return;
  }

  const v = this._strafeState?.value ?? 0;
  if (v === 0) return;
  const dir  = Math.sign(v);
  const dist = Math.abs(v);

  const projected = HelmPreview.projectStrafe(token, dir, dist);
  if (!projected) return;

  const waypoints = HelmPreview.projectStrafeWaypoints(token, dir, dist);
  HelmPreview.hide();

  const dirLabel = dir === 1
    ? game.i18n.localize("SHIPCOMBAT.Helm.StrafeStarboard")
    : game.i18n.localize("SHIPCOMBAT.Helm.StrafePort");

  emitToGM("pilotStrafe", {
    userId:      game.user.id,
    newX:        projected.x,
    newY:        projected.y,
    newRotation: projected.rotation,
    dist,
    dirLabel,
    waypoints,
  });
}

async function _onPilotFlipAndBurn() {
  const sys = this.actor.system;
  if (!((sys.resources?.pilot?.coreCount ?? 0) > 0)) return;

  const token = this.actor.getActiveTokens()?.[0];
  if (!token) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return;
  }

  // Requires ≥50% power remaining
  const fuelBurned    = sys.resources?.pilot?.fuelBurned    ?? 0;
  const overdrive     = sys.resources?.pilot?.overdrive     ?? false;
  const apThrustBonus = sys.resources?.pilot?.apThrustBonus ?? 0;
  const powerMax      = (overdrive ? 200 : 100) + apThrustBonus;
  if ((powerMax - fuelBurned) < 50) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.FlipBurnNeedsPower"));
    return;
  }

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window:  { title: game.i18n.localize("SHIPCOMBAT.Dialog.FlipAndBurnTitle") },
    content: `<p>${game.i18n.localize("SHIPCOMBAT.Dialog.FlipAndBurnBody")}</p>`,
  });
  if (!confirmed) return;

  const baseSpeed      = sys.movement?.speed ?? 6;
  const allocSpeed     = sys.resources?.pilot?.allocSpeed ?? 0;
  const effSpeed       = Math.max(0, baseSpeed + allocSpeed);
  const halfSpeedUnits = Math.max(1, Math.round(effSpeed * 0.5));

  const projected = HelmPreview.projectFlipAndBurn(token, halfSpeedUnits);
  if (!projected) return;

  const waypoints = HelmPreview.projectFlipAndBurnWaypoints(token, halfSpeedUnits);
  HelmPreview.hide();

  emitToGM("pilotFlipAndBurn", {
    userId:         game.user.id,
    halfSpeedUnits,
    newX:           projected.x,
    newY:           projected.y,
    newRotation:    projected.rotation,
    waypoints,
  });
}

async function _onPilotRam() {
  const token = this.actor.getActiveTokens()?.[0];
  if (!token || !canvas?.ready) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
    return;
  }

  const sys            = this.actor.system;
  const fuelBurned     = sys.resources?.pilot?.fuelBurned ?? 0;
  const isFirstCommit  = fuelBurned === 0;
  const prevTurnMove   = sys.resources?.pilot?.prevTurnMove ?? 0;
  const minMove        = Math.ceil(prevTurnMove / 2);
  const minMoveGridUnits = isFirstCommit ? minMove : 0;

  const isRealistic    = game.settings.get(MODULE_ID, "movementMode") === "realistic";
  const vx             = isRealistic ? (sys.resources?.pilot?.velocityX ?? 0) : 0;
  const vy             = isRealistic ? (sys.resources?.pilot?.velocityY ?? 0) : 0;
  const carryPct       = isRealistic ? (this._helmState?.carryPct ?? 0) : 0;

  const baseSpeed      = sys.movement?.speed ?? 6;
  const allocSpeed     = sys.resources?.pilot?.allocSpeed ?? 0;
  const overdrive      = sys.resources?.pilot?.overdrive ?? false;
  const apThrustBonus  = sys.resources?.pilot?.apThrustBonus ?? 0;
  const effSpeed       = Math.max(0, baseSpeed + allocSpeed);
  const powerMax       = (overdrive ? 200 : 100) + apThrustBonus;
  const powerRemaining = Math.max(0, powerMax - fuelBurned);

  const baseMano       = sys.movement?.maneuverability ?? 2;
  const allocMano      = sys.resources?.pilot?.allocMano ?? 0;
  const effMano        = Math.max(0, baseMano + allocMano);
  const maxBearingDeg  = effMano * 15;

  const shipBasis = HelmPreview._tokenBasis(token);

  // Quick pre-check: does at least one reachable lock≥1 target exist?
  const candidates = canvas.tokens.placeables.filter(t =>
    t !== token && !t.document.hidden,
  );
  const gridSize = canvas.grid.size;
  const tokenW   = token.document.width  * gridSize;
  const tokenH   = token.document.height * gridSize;
  const cx       = token.x + tokenW / 2;
  const cy       = token.y + tokenH / 2;

  let hasAny = false;
  for (const tgt of candidates) {
    const tW  = tgt.document.width  * gridSize;
    const tH  = tgt.document.height * gridSize;
    const tx  = tgt.x + tW / 2;
    const ty  = tgt.y + tH / 2;
    const reach = isRealistic
      ? HelmPreview.canReachRealistic(shipBasis, tx, ty, effSpeed, maxBearingDeg, powerRemaining, powerMax, vx, vy, carryPct)
      : HelmPreview.canReach(shipBasis, tx, ty, effSpeed, maxBearingDeg, powerRemaining, powerMax, minMoveGridUnits);
    if (!reach) continue;
    const distSquares = Math.sqrt(Math.pow((tx - cx) / gridSize, 2) + Math.pow((ty - cy) / gridSize, 2));
    const lockTier = ShipCombatState.getEffectiveLockTier(tgt.id, distSquares);
    if (lockTier >= 1) { hasAny = true; break; }
  }

  if (!hasAny) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoRamTargets"));
    return;
  }

  const popup = new RamTargetPopup({
    ship:            this.actor,
    effSpeed,
    powerMax,
    powerRemaining,
    maxBearingDeg,
    minMoveGridUnits: isRealistic ? 0 : minMoveGridUnits,
    fuelBurned,
    shipBasis,
    isRealistic,
    velocityX:       vx,
    velocityY:       vy,
    carryPct,
  });
  popup.render(true);
}

// ── Exported action map (merged into ShipSheet.DEFAULT_OPTIONS.actions) ────

export const PILOT_ACTIONS = {
  allocBonus:       _onAllocBonus,
  rollPiloting:     _onRollPiloting,
  resetHelm:        _onResetHelm,
  confirmHelm:      _onConfirmHelm,
  pilotRetrograde:  _onPilotRetrograde,
  pilotOverdrive:   _onPilotOverdrive,
  pilotStrafe:      _onPilotStrafe,
  pilotFlipAndBurn: _onPilotFlipAndBurn,
  apToThrust:       _onApToThrust,
  pilotRam:         _onPilotRam,
};

// ── Helm context builder ────────────────────────────────────────────────────

export function buildHelmContext(sys, opts = {}) {
  const { engineComponent } = opts;
  const is3man = (sys.crewSize ?? 6) <= 3;
  const baseSpeed = sys.movement?.speed ?? 6;
  const baseMano  = sys.movement?.maneuverability ?? 2;
  const pilotingSL  = sys.resources?.pilot?.pilotingSL  ?? 0;
  const allocSpeed   = sys.resources?.pilot?.allocSpeed   ?? 0;
  const allocMano    = sys.resources?.pilot?.allocMano    ?? 0;
  const allocEvasion = sys.resources?.pilot?.allocEvasion ?? 0;
  const overdrive    = sys.resources?.pilot?.overdrive    ?? false;
  const speedPayloadBonus = sys.resources?.pilot?.payload === "fuelCatalyst"
    ? Math.max(1, Math.ceil(baseSpeed * 0.5))
    : 0;
  const manoPayloadBonus = sys.resources?.pilot?.payload === "chaffPods"
    ? Math.max(1, Math.ceil(baseMano * 0.5))
    : 0;

  // ── Captain card: Hard Over doubles base maneuverability ───────────────────────────
  const hardOverActive = sys.resources?.pilot?.hardOverActive ?? false;
  const effectiveBaseMano = hardOverActive ? baseMano * 2 : baseMano;
  const PILOT_BOOST_CARDS = ["pressTheAttack", "hardOver"];
  const _captainPlayedCards = sys.resources?.captain?.playedCards ?? [];
  const captainBoosts = _captainPlayedCards
    .filter(id => PILOT_BOOST_CARDS.includes(id))
    .map(id => ({
      id,
      label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${id}`),
    }));

  // ── Crit condition penalties ───────────────────────────────────────────────────────
  const conditions = sys.conditions ?? {};
  const engineTier = conditions.engines?.tier;
  const manTier    = conditions.manoeuvring?.tier;
  const enginePenalty = engineTier === "high" ? 4 : engineTier === "medium" ? 2 : engineTier === "low" ? 1 : 0;
  const manPenalty    = manTier    === "high" ? 4 : manTier    === "medium" ? 2 : manTier    === "low" ? 1 : 0;

  // ── Captain stance modifiers ───────────────────────────────────────────────────
  const stance       = sys.resources?.captain?.stance ?? "none";
  const stanceSpeedMod = stance === "aggressive" ? -1 : stance === "defensive" ? 1 : 0;
  const stanceManoMod  = stance === "aggressive" ? -1 : stance === "defensive" ? 1 : 0;

  const effSpeed   = Math.max(0, baseSpeed + allocSpeed + speedPayloadBonus + stanceSpeedMod - enginePenalty);
  const effMano    = Math.max(0, effectiveBaseMano + allocMano + manoPayloadBonus + stanceManoMod - manPenalty);
  const overdriveMult = overdrive ? 2 : 1;
  const powerPerAP    = engineComponent?.system?.powerPerAP ?? 0;
  const auxiliaryPower = sys.resources?.engineer?.auxiliaryPower ?? 0;
  const auxPowerCapacity = opts.reactorStats?.auxPowerCapacity ?? 0;
  const apThrustBonus  = sys.resources?.pilot?.apThrustBonus ?? 0;
  const powerMax   = 100 * overdriveMult + apThrustBonus;
  const fuelBurned = sys.resources?.pilot?.fuelBurned ?? 0;
  const pilotingMessageId = sys.resources?.pilot?.pilotingMessageId ?? "";
  const prevTurnMove = sys.resources?.pilot?.prevTurnMove ?? 0;
  const velocityX    = sys.resources?.pilot?.velocityX ?? 0;
  const velocityY    = sys.resources?.pilot?.velocityY ?? 0;
  const velocityMag  = Math.floor(Math.hypot(velocityX, velocityY));
  const velocityDirDeg = velocityMag > 0
    ? Math.round((Math.atan2(velocityY, velocityX) * 180 / Math.PI + 90 + 360) % 360)
    : 0;
  const isRealistic = (typeof game !== "undefined") && game.settings?.get(MODULE_ID, "movementMode") === "realistic";
  const minMove     = isRealistic ? velocityMag : Math.ceil(prevTurnMove / 2);
  const bearingUsed     = sys.resources?.pilot?.bearingUsed  ?? 0;
  const momentumUsed    = sys.resources?.pilot?.momentumUsed ?? 0;
  const bearingMax      = effMano * 15;
  const bearingRemaining = isRealistic ? Math.max(0, bearingMax - bearingUsed) : bearingMax;

  // Velocity bearing display
  const shipRotation           = opts.shipRotation ?? 0;
  const velocityBearingRelative = (opts.velocityBearingMode ?? "relative") === "relative";
  const velocityArrowRotation   = velocityBearingRelative
    ? Math.round((velocityDirDeg - shipRotation + 360) % 360)
    : velocityDirDeg;
  const velocityTooltip = isRealistic && velocityMag > 0 && (typeof game !== "undefined")
    ? (velocityBearingRelative
        ? game.i18n.format("SHIPCOMBAT.Helm.VelocityTooltipRelative", { mag: velocityMag, dir: velocityArrowRotation })
        : game.i18n.format("SHIPCOMBAT.Helm.VelocityTooltipTrue",     { mag: velocityMag, dir: velocityDirDeg }))
    : "";
  return {
    speed:           baseSpeed,
    maneuverability: baseMano,
    pilotingSL,
    allocSpeed,
    allocMano,
    allocEvasion,
    evasionPct:      allocEvasion * 5,
    overdrive,
    powerMax,
    effectiveSpeed:  effSpeed,
    effectiveMano:   effMano,
    remainingSL:     Math.max(0, pilotingSL - allocSpeed - allocMano - allocEvasion),
    allocLocked:     fuelBurned > 0 || (sys.resources?.pilot?.ramAllocLocked ?? false),
    slCapped:        !!pilotingMessageId && (pilotingSL - allocSpeed - allocMano - allocEvasion) <= 0,
    hasRolledPiloting: !!pilotingMessageId,
    is3man,
    helmSLLabel:     (() => {
      const roleId = is3man ? "engineer" : "pilot";
      const effective = getEffectiveSkillSpec(sys, roleId);
      if (effective?.includes("|")) {
        const idx  = effective.indexOf("|");
        const spec = effective.slice(idx + 1);
        const key  = effective.slice(0, idx);
        return `${spec || SystemAdapter.current.getSkillLabel(key)} SL`;
      }
      return game.i18n.localize(is3man ? "SHIPCOMBAT.Helm.EngineeringSL" : "SHIPCOMBAT.Helm.PilotingSL");
    })(),
    helmSLTooltip:   (() => {
      const roleId = is3man ? "engineer" : "pilot";
      const effective = getEffectiveSkillSpec(sys, roleId);
      if (effective?.includes("|")) {
        const idx  = effective.indexOf("|");
        const key  = effective.slice(0, idx);
        const spec = effective.slice(idx + 1);
        const skillName    = SystemAdapter.current.getSkillLabel(key);
        const skillDisplay = spec ? `${skillName} (${spec})` : skillName;
        return `Roll ${skillDisplay} to generate Helm SL for Speed, Maneuverability, and Evasion allocation.`;
      }
      return game.i18n.localize(is3man ? "SHIPCOMBAT.Helm.EngineeringSLTooltip" : "SHIPCOMBAT.Helm.PilotingSLTooltip");
    })(),
    helmRollLabel:   (() => {
      const roleId = is3man ? "engineer" : "pilot";
      const effective = getEffectiveSkillSpec(sys, roleId);
      if (effective?.includes("|")) {
        const idx  = effective.indexOf("|");
        const spec = effective.slice(idx + 1);
        const key  = effective.slice(0, idx);
        return `Roll ${spec || SystemAdapter.current.getSkillLabel(key)}`;
      }
      return game.i18n.localize(is3man ? "SHIPCOMBAT.Helm.RollEngineering" : "SHIPCOMBAT.Helm.RollPiloting");
    })(),
    minMove,
    prevTurnMove,
    bearingUsed,
    bearingMax,
    bearingRemaining,
    momentumUsed,
    minMovePct:      isRealistic ? 0 : ((powerMax > 0 && (minMove + effSpeed) > 0) ? Math.max(0, Math.round(minMove / (minMove + effSpeed) * 100)) : 0),
    maxBearing:      effMano * 15,
    fuelBurned,
    fuelSlider:      fuelBurned,
    bearing:         sys.resources?.pilot?.bearing ?? 0,
    speedTooltip:    game.i18n.format("SHIPCOMBAT.Helm.SpeedTooltip",    { val: effSpeed }),
    manoTooltip:     game.i18n.format("SHIPCOMBAT.Helm.ManoTooltip",     { val: effMano * 15, mano: effMano }),
    minMoveTooltip:  isRealistic
      ? game.i18n.format("SHIPCOMBAT.Helm.MinMoveMomentumTooltip", { val: velocityMag })
      : game.i18n.format("SHIPCOMBAT.Helm.MinMoveTooltip",         { val: minMove }),
    bearingBudgetTooltip: isRealistic && (typeof game !== "undefined")
      ? game.i18n.format("SHIPCOMBAT.Helm.BearingBudgetTooltip", { val: bearingRemaining, max: bearingMax })
      : "",
    isRealistic,
    velocityX,
    velocityY,
    velocityMag,
    velocityDirDeg,
    velocityArrowRotation,
    velocityBearingRelative,
    velocityTooltip,
    strafeMax:       Math.max(1, Math.floor(baseSpeed / 2)),
    retroMax:        Math.max(1, baseSpeed),
    overchargeAction: sys.resources?.pilot?.overchargeAction ?? "",
    // Per-action flags for template button gating (replaced overchargedUsed boolean)
    overdriveUsed:    (sys.resources?.pilot?.coreActionsPlayed ?? []).includes("overdrive"),
    strafeUsed:       (sys.resources?.pilot?.coreActionsPlayed ?? []).includes("strafe"),
    retroUsed:        (sys.resources?.pilot?.coreActionsPlayed ?? []).includes("retro"),
    flipAndBurnUsed:  (sys.resources?.pilot?.coreActionsPlayed ?? []).includes("flipBurn"),
    flipAndBurnAvailable: (() => {
      const powerMax = ((sys.resources?.pilot?.overdrive ?? false) ? 200 : 100)
        + (sys.resources?.pilot?.apThrustBonus ?? 0);
      return (powerMax - (sys.resources?.pilot?.fuelBurned ?? 0)) >= 50;
    })(),
    coreActionsPlayedLabels: (() => {
      const played = sys.resources?.pilot?.coreActionsPlayed ?? [];
      const LABELS = {
        overdrive: "SHIPCOMBAT.Action.PilotOverdrive",
        strafe:    "SHIPCOMBAT.Action.PilotStrafe",
        retro:     "SHIPCOMBAT.Action.PilotOverchargeRetro",
        flipBurn:  "SHIPCOMBAT.Action.PilotFlipAndBurn",
      };
      return played.map(id => game.i18n.localize(LABELS[id] ?? id));
    })(),
    // Condition / stance info for UI
    enginePenalty,
    manPenalty,
    stanceSpeedMod,
    stanceManoMod,
    hasMovementCondition: enginePenalty > 0 || manPenalty > 0 || stanceSpeedMod !== 0 || stanceManoMod !== 0,
    hardOverActive,
    captainBoosts,
    hasCaptainFreeCore: false,
    // hasCoreAssigned drives the core action button visibility in the helm template.
    // True whenever ANY core is available (captain-granted OR engineer-dispatched).
    hasCoreAssigned: (sys.resources?.pilot?.coreCount ?? 0) > 0,
    // Auxiliary Power (from engineer resources, read-only display in pilot tab)
    auxiliaryPower,
    auxPowerCapacity,
    auxPowerPct: auxPowerCapacity > 0 ? Math.min(100, (auxiliaryPower / auxPowerCapacity) * 100) : 0,
    powerPerAP,
    apThrustBonus,
    prowGunLocked:   sys.resources?.pilot?.prowGunLocked  ?? false,
    ramAllocLocked:  sys.resources?.pilot?.ramAllocLocked ?? false,
  };
}

// ── Helm _onRender wiring ───────────────────────────────────────────────────

/**
 * Wire up helm sliders and power bar.  Called from ShipSheet._onRender().
 * @param {ShipSheet} sheet – the sheet instance (provides _helmState, element, _updateHelmPreview)
 */
export function helmOnRender(sheet) {
  const sys          = sheet.actor.system;
  const fuelBurned   = sys.resources?.pilot?.fuelBurned ?? 0;
  const currentRound = sys.round ?? 0;
  const helmResetId  = sys.resources?.pilot?.helmResetId ?? 0;

  const overdrive    = sys.resources?.pilot?.overdrive ?? false;
  const apThrustBonus = sys.resources?.pilot?.apThrustBonus ?? 0;
  const powerMax     = (overdrive ? 200 : 100) + apThrustBonus;

  // Compute velocity/mode early so momentum floor can be capped when the vessel is stopped
  const isRealistic  = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
  const velocityMag  = isRealistic ? Math.floor(Math.hypot(
    sys.resources?.pilot?.velocityX ?? 0,
    sys.resources?.pilot?.velocityY ?? 0)) : 0;

  if (!sheet._helmState
      || sheet._helmState.round !== currentRound
      || sheet._helmState.helmResetId !== helmResetId) {
    sheet._helmState = {
      round: currentRound,
      helmResetId,
      bearing:   sys.resources?.pilot?.bearing ?? 0,
      fuelSlider: fuelBurned,
      carryPct:  (isRealistic && velocityMag === 0) ? 100 : (sys.resources?.pilot?.momentumUsed ?? 0),
    };
  } else {
    sheet._helmState.bearing = sys.resources?.pilot?.bearing ?? 0;
    if (sheet._helmState.fuelSlider < fuelBurned) {
      sheet._helmState.fuelSlider = fuelBurned;
    }
    // Cap to new powerMax (in case overdrive just changed)
    if (sheet._helmState.fuelSlider > powerMax) {
      sheet._helmState.fuelSlider = powerMax;
    }
    // Carry can't be less than what's already committed; when stopped, clamp to 100%
    const momentumFloor = (isRealistic && velocityMag === 0) ? 100 : (sys.resources?.pilot?.momentumUsed ?? 0);
    if ((sheet._helmState.carryPct ?? 0) < momentumFloor) {
      sheet._helmState.carryPct = momentumFloor;
    }
  }

  if (!sheet._strafeState || !("value" in sheet._strafeState)) {
    sheet._strafeState = { value: 0 };
  }

  const powerBarEl       = sheet.element.querySelector("[data-helm-power-bar]");
  const powerInput       = sheet.element.querySelector("[data-helm-fuel]");
  const bearingSlider    = sheet.element.querySelector("[data-helm-bearing]");
  const bearingDisp      = sheet.element.querySelector("[data-bearing-display]");
  const fuelDisp         = sheet.element.querySelector("[data-fuel-display]");
  const bearingBudgetBar = sheet.element.querySelector("[data-bearing-budget-bar]");
  const carryInput       = sheet.element.querySelector("[data-helm-carry]");
  const carryDisp        = sheet.element.querySelector("[data-carry-display]");
  const carryBarEl       = sheet.element.querySelector("[data-helm-carry-bar]");

  // Realistic-mode bearing budget values
  const baseManoHOR   = sys.movement?.maneuverability ?? 2;
  const allocManoHOR  = sys.resources?.pilot?.allocMano ?? 0;
  const effManoHOR    = Math.max(0, baseManoHOR + allocManoHOR);
  const bearingMax    = effManoHOR * 15;
  const bearingUsed   = sys.resources?.pilot?.bearingUsed  ?? 0;
  const momentumUsed  = sys.resources?.pilot?.momentumUsed ?? 0;
  const momentumFloor = (isRealistic && velocityMag === 0) ? 100 : momentumUsed;
  const bearingRemain = Math.max(0, bearingMax - bearingUsed);

  const _syncBearingBudgetBar = (bearingAbs) => {
    if (!bearingBudgetBar || !bearingMax) return;
    const committed = (bearingUsed / bearingMax) * 100;
    const extra     = (Math.min(bearingAbs, bearingRemain) / bearingMax) * 100;
    bearingBudgetBar.style.setProperty("--committed", `${committed}%`);
    bearingBudgetBar.style.setProperty("--extra",     `${extra}%`);
    bearingBudgetBar.style.setProperty("--minmove",   "0%");
    const bearingBudgetDisp = sheet.element.querySelector("[data-bearing-budget-display]");
    if (bearingBudgetDisp) bearingBudgetDisp.textContent = `${Math.round(bearingUsed + Math.min(bearingAbs, bearingRemain))}°`;
  };
  _syncBearingBudgetBar(Math.abs(sheet._helmState.bearing));

  // Bearing slider: clamp range to remaining budget (capped at 180), then set value
  if (bearingSlider) {
    const sliderMax = Math.min(bearingRemain, 180);
    bearingSlider.min = String(-sliderMax);
    bearingSlider.max = String(sliderMax);
    const clampedBearing = Math.max(-sliderMax, Math.min(sliderMax, sheet._helmState.bearing));
    if (clampedBearing !== sheet._helmState.bearing) {
      sheet._helmState.bearing = clampedBearing;
    }
    bearingSlider.value = String(sheet._helmState.bearing);
    if (bearingDisp) bearingDisp.textContent = `${sheet._helmState.bearing}°`;
    // Update the degree labels on each end of the realistic bearing slider
    const minLbl = sheet.element.querySelector("[data-bearing-min-label]");
    const maxLbl = sheet.element.querySelector("[data-bearing-max-label]");
    if (minLbl) minLbl.textContent = `\u2212${sliderMax}\u00b0`;
    if (maxLbl) maxLbl.textContent = `${sliderMax}\u00b0`;
  }

  // Min-move marker position: written as data-minmove-pct on the power bar by the template
  const minMovePct = parseInt(powerBarEl?.dataset?.minmovePct ?? "0") || 0;

  // Set dynamic power max
  if (powerInput) {
    powerInput.max = String(powerMax);
    powerInput.value = String(sheet._helmState.fuelSlider);
  }

  const _syncPowerBar = (selectedPct) => {
    const ratio      = 100 / powerMax;
    const committed  = fuelBurned  * ratio;
    const extra      = Math.max(0, selectedPct - fuelBurned) * ratio;
    if (powerBarEl) {
      // Hide the delimiter once the slider (even uncommitted) passes the min-move
      // threshold; redisplay it if the slider moves back below the threshold.
      const effectiveMinmove = (selectedPct * ratio) >= minMovePct ? 0 : minMovePct;
      powerBarEl.style.setProperty("--committed", `${committed}%`);
      powerBarEl.style.setProperty("--extra",     `${extra}%`);
      powerBarEl.style.setProperty("--minmove",   `${effectiveMinmove}%`);
      const line = powerBarEl.querySelector(".shipcombat-power-minmove-line");
      if (line) line.style.display = effectiveMinmove > 0 ? "" : "none";
    }
    if (fuelDisp) fuelDisp.textContent = `${selectedPct}%`;
  };

  _syncPowerBar(sheet._helmState.fuelSlider);

  if (powerInput) {
    powerInput.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
    powerInput.addEventListener("input",  ev => {
      ev.stopPropagation();
      let val = Math.max(fuelBurned, Math.min(powerMax, Number(ev.target.value)));
      if (val !== Number(ev.target.value)) ev.target.value = String(val);
      sheet._helmState.fuelSlider = val;
      sheet._helmState.confirmed = false;
      _syncPowerBar(val);
      sheet._updateHelmPreview();
    }, true);
  }

  if (bearingSlider) {
    bearingSlider.addEventListener("change", ev => ev.stopPropagation());
    bearingSlider.addEventListener("input",  ev => {
      let val = Number(ev.target.value);
      // In Realistic mode, clamp to remaining bearing budget
      if (isRealistic && bearingMax > 0) {
        const maxAllowed = bearingRemain;
        if (Math.abs(val) > maxAllowed) {
          val = Math.sign(val || 1) * maxAllowed;
          ev.target.value = String(val);
        }
      }
      sheet._helmState.bearing = val;
      sheet._helmState.confirmed = false;
      if (bearingDisp) bearingDisp.textContent = `${val}°`;
      _syncBearingBudgetBar(Math.abs(val));
      sheet._updateHelmPreview();
      // Persist bearing to system data for auto-move on turn end
      clearTimeout(sheet._bearingDebounce);
      sheet._bearingDebounce = setTimeout(() => {
        emitToGM("updateResource", { roleId: "pilot", key: "bearing", value: val });
      }, 300);
    });
  }

  // ── Carry slider (Realistic mode) ────────────────────────────────────────
  const _syncCarryBar = (carryPct) => {
    if (!carryBarEl) return;
    const committed = momentumUsed;
    const extra     = Math.max(0, carryPct - momentumUsed);
    carryBarEl.style.setProperty("--committed", `${committed}%`);
    carryBarEl.style.setProperty("--extra",     `${extra}%`);
    carryBarEl.style.setProperty("--minmove",   "0%");
    if (carryDisp) carryDisp.textContent = `${Math.round(carryPct)}%`;
  };

  if (carryInput) {
    carryInput.value = String(sheet._helmState.carryPct ?? momentumFloor);
    carryInput.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
    carryInput.addEventListener("input",  ev => {
      ev.stopPropagation();
      const val = Math.max(momentumFloor, Math.min(100, Number(ev.target.value)));
      if (val !== Number(ev.target.value)) ev.target.value = String(val);
      sheet._helmState.carryPct = val;
      sheet._helmState.confirmed = false;
      _syncCarryBar(val);
      sheet._updateHelmPreview();
    }, true);
  }
  _syncCarryBar(sheet._helmState.carryPct ?? momentumFloor);

  // ── Strafe controls ──────────────────────────────────────────────────────
  const token = sheet.actor.getActiveTokens()?.[0];

  const strafeSlider  = sheet.element.querySelector("[data-strafe-slider]");
  const strafeDisplay = sheet.element.querySelector("[data-strafe-display]");
  const strafeConfirm = sheet.element.querySelector("[data-strafe-confirm]");

  const _syncStrafe = () => {
    const v = sheet._strafeState.value;
    let label;
    if (v === 0) label = game.i18n.localize("SHIPCOMBAT.Helm.StrafeCenter");
    else if (v > 0) label = `${game.i18n.localize("SHIPCOMBAT.Helm.StrafeStarboard")} ${v}`;
    else label = `${game.i18n.localize("SHIPCOMBAT.Helm.StrafePort")} ${Math.abs(v)}`;
    if (strafeDisplay) strafeDisplay.textContent = label;
    if (strafeConfirm) strafeConfirm.disabled = (v === 0);
    if (v !== 0 && token && canvas?.ready) {
      HelmPreview.showStrafe(token, Math.sign(v), Math.abs(v));
    } else {
      HelmPreview.hide();
    }
  };

  if (strafeSlider) {
    strafeSlider.value = String(sheet._strafeState.value);
    strafeSlider.addEventListener("input", ev => {
      sheet._strafeState.value = Number(ev.target.value);
      _syncStrafe();
    });
  }
  _syncStrafe();

  // ── Retrograde controls ───────────────────────────────────────────────────
  if (!sheet._retrogradeState || !("value" in sheet._retrogradeState)) {
    sheet._retrogradeState = { value: 1 };
  }

  const retroSlider  = sheet.element.querySelector("[data-retro-slider]");
  const retroDisplay = sheet.element.querySelector("[data-retro-display]");

  const _syncRetro = () => {
    const v = sheet._retrogradeState.value;
    const prevTurnMove2 = sys.resources?.pilot?.prevTurnMove ?? 0;
    const minMove2 = Math.ceil(prevTurnMove2 / 2);
    const netAft     = Math.max(0, v - minMove2);
    const netForward = Math.max(0, minMove2 - v);
    let label;
    if (netAft > 0)          label = `${netAft} ${game.i18n.localize("SHIPCOMBAT.Label.VoidUnits")} ${game.i18n.localize("SHIPCOMBAT.Helm.Sternward")}`;
    else if (netForward > 0) label = game.i18n.format("SHIPCOMBAT.Helm.RetrogradePartial", { n: netForward });
    else                     label = game.i18n.localize("SHIPCOMBAT.Helm.RetrogradeNeutral");
    if (retroDisplay) retroDisplay.textContent = label;

    const retroBtn = sheet.element.querySelector("[data-action='pilotRetrograde']");
    const canPreview = retroBtn && !retroBtn.disabled && token && canvas?.ready;
    if (canPreview && netAft > 0) {
      HelmPreview.showRetrograde(token, netAft);
    } else {
      HelmPreview.hide();
    }
  };

  if (retroSlider) {
    retroSlider.value = String(sheet._retrogradeState.value);
    retroSlider.addEventListener("input", ev => {
      sheet._retrogradeState.value = Number(ev.target.value);
      _syncRetro();
    });
  }
  _syncRetro();

  // Show projected drift immediately on render (no slider interaction needed)
  sheet._updateHelmPreview();

  // ── Flip and Burn preview (hover on panel) ──────────────────────────────
  const flipBurnPanel = sheet.element.querySelector("[data-flip-burn-panel]");
  if (flipBurnPanel && token && canvas?.ready) {
    const baseSpdFB  = sys.movement?.speed ?? 6;
    const allocSpdFB = sys.resources?.pilot?.allocSpeed ?? 0;
    const effSpdFB   = Math.max(0, baseSpdFB + allocSpdFB);
    const halfDist   = Math.max(1, Math.round(effSpdFB * 0.5));

    // Inject the striped overlay zone into the power bar (once per render)
    const powerBar = sheet.element.querySelector("[data-helm-power-bar]");
    let flipZone = powerBar?.querySelector(".shipcombat-flip-burn-zone");
    if (powerBar && !flipZone) {
      flipZone = document.createElement("div");
      flipZone.className = "shipcombat-flip-burn-zone";
      flipZone.style.display = "none";
      powerBar.appendChild(flipZone);
    }

    const _showFlipZone = () => {
      if (!flipZone || !canvas?.ready) return;
      const fuelBurnedNow = sheet.actor.system.resources?.pilot?.fuelBurned ?? 0;
      const overdriveNow  = sheet.actor.system.resources?.pilot?.overdrive  ?? false;
      const apBonusNow    = sheet.actor.system.resources?.pilot?.apThrustBonus ?? 0;
      const powerMaxNow   = (overdriveNow ? 200 : 100) + apBonusNow;
      const leftPct  = (fuelBurnedNow / powerMaxNow) * 100;
      const widthPct = Math.min(50 / powerMaxNow * 100, 100 - leftPct);
      flipZone.style.left    = `${leftPct}%`;
      flipZone.style.width   = `${widthPct}%`;
      flipZone.style.display = "";
      HelmPreview.showFlipAndBurn(token, halfDist);
    };

    const _hideFlipZone = () => {
      if (flipZone) flipZone.style.display = "none";
      HelmPreview.hide();
    };

    flipBurnPanel.addEventListener("mouseenter", _showFlipZone);
    flipBurnPanel.addEventListener("mouseleave", _hideFlipZone);
  }

  // ── Velocity bearing toggle (Realistic mode) ────────────────────────────
  if (!sheet._velocityBearingMode) sheet._velocityBearingMode = "relative";
  const velBearingToggle = sheet.element.querySelector("[data-vel-bearing-toggle]");
  if (velBearingToggle) {
    velBearingToggle.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      sheet._velocityBearingMode = sheet._velocityBearingMode === "relative" ? "true" : "relative";
      sheet.render();
    });
  }
}

// ── Helm preview updater ────────────────────────────────────────────────────

/**
 * Compute the ghost token position from current helm state and update the
 * canvas preview.  Called from ShipSheet._updateHelmPreview().
 * @param {ShipSheet} sheet
 */
export function helmUpdatePreview(sheet) {
  const token = sheet.actor.getActiveTokens()?.[0];
  if (!token || !canvas?.ready) return;

  const sys          = sheet.actor.system;
  const speed        = (sys.movement?.speed ?? 6) + (sys.resources?.pilot?.allocSpeed ?? 0);
  const prevTurnMove = sys.resources?.pilot?.prevTurnMove ?? 0;
  const minMove      = Math.ceil(prevTurnMove / 2);
  const fuelBurned   = sys.resources?.pilot?.fuelBurned ?? 0;
  const fuelSlider   = sheet._helmState?.fuelSlider ?? fuelBurned;
  const bearing      = sheet._helmState?.bearing ?? 0;

  const isRealistic = game.settings?.get(MODULE_ID, "movementMode") === "realistic";

  if (isRealistic) {
    const vx     = sys.resources?.pilot?.velocityX ?? 0;
    const vy     = sys.resources?.pilot?.velocityY ?? 0;
    const thrustPct    = fuelSlider - fuelBurned;
    const carryPct     = sheet._helmState?.carryPct ?? 0;
    const momentumUsed = sys.resources?.pilot?.momentumUsed ?? 0;
    const velMag       = Math.hypot(vx, vy);
    // Hide if confirmed (waiting for GM update) or nothing pending above floor
    if (sheet._helmState?.confirmed || (thrustPct <= 0 && carryPct <= momentumUsed && bearing === 0)) { HelmPreview.hide(); return; }
    const projected = HelmPreview.projectPositionRealistic(token, bearing, thrustPct, speed, vx, vy, carryPct);
    if (!projected) { HelmPreview.hide(); return; }
    HelmPreview.show(token, projected);
    if (velMag > 0 || thrustPct > 0) {
      HelmPreview.updateLineRealistic(bearing, thrustPct, speed, vx, vy, carryPct);
    } else if (HelmPreview._line) {
      HelmPreview._line.clear(); // Rotation-only: no movement line
    }
    return;
  }

  const isFirstCommit = fuelBurned === 0 && !sheet._helmState?.confirmed;
  const thrustPct     = fuelSlider - fuelBurned;
  const driftUnits    = isFirstCommit ? minMove : 0;

  if (thrustPct <= 0) {
    HelmPreview.hide();
    return;
  }

  const projected = HelmPreview.projectPosition(token, bearing, thrustPct, speed, driftUnits);
  if (!projected) { HelmPreview.hide(); return; }
  HelmPreview.show(token, projected);
  HelmPreview.updateLine(bearing, thrustPct, speed, driftUnits);
}
