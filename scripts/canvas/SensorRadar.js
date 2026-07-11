/**
 * SensorRadar  -  2D radar renderer for the Sensors (Augur) role.
 *
 * Renders a top-down radar view on an HTML <canvas> inside the ship sheet:
 *  - Own ship at centre (heading up), concentric range rings
 *  - Blips for every visible non-friendly token, coloured by lock tier
 *  - Contact naming based on the module setting + lock tier
 *  - Click-to-select: opens a context popup with available lock/utility actions
 *
 * Lifecycle: call `SensorRadar.attach(sheet, sensorsCtx)` from `_onRender`.
 * Foundry hooks (updateToken, etc.) trigger lightweight `repaint()` without
 * a full sheet re-render, so the radar stays current when tokens move.
 */
import { MODULE_ID, CORE_MODULE_ID, LOCK_DECAY_ROUNDS, hullDisplay } from "../constants.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { emitToGM } from "../socket.js";
import { refreshTokenVisibility } from "./TokenVisibility.js";
import { SENSORS_ACTIONS } from "../roles/sensors.js";
import { isOrdnance as _isOrdnanceActor, ordnanceSubtype as _ordnanceSubtype, actorTypeIsOrdnance, actorTypeIsTorpedo, actorTypeIsStrikeCraft } from "../actors/ordnance/ordnance-types.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

// ── Visual constants ──────────────────────────────────────────────────────

const RADAR_BG        = "#0a0f16";
const BLIP_SELECTED   = "#ffffff";     // Bright white for selected blip
const BLIP_RADIUS     = 6;

// ── Radar colour palette ──────────────────────────────────────────────────
// Defaults: Core green theme.
// System adapters may override via radarPalette() — e.g. SF2e uses blue.
// _pal is refreshed at the start of every full _paint() call.
let _pal = {
  ring:           "rgba(0, 255, 136, 0.22)",
  ringLabel:      "rgba(0, 255, 136, 0.55)",
  ghRing:         "rgba(0, 255, 136, 0.28)",
  crosshair:      "rgba(0, 255, 136, 0.10)",
  heading:        "rgba(0, 255, 136, 0.35)",
  friendly:       "#00ff88",
  friendlyOrd:    "#00ff88",
  sweepHighlight: "#00ff88",
  sweep:          "rgba(0, 255, 136, 0.35)",
  sweepTrail:     "rgba(0, 255, 136, 0.08)",
  sweepGlow:      "rgba(0, 255, 136, 0.6)",
  trailStop1:     "rgba(0, 255, 136, 0.03)",
  trailStop2:     "rgba(0, 255, 136, 0.08)",
  trailStop3:     "rgba(0, 255, 136, 0.18)",
  outerRim:       "rgba(0, 255, 136, 0.35)",
};
const SWEEP_SPEED     = 0.7;   // radians per second (~9 s per full rotation)
const EDGE_PAD        = 0.15;

// ── Lock tier visual config ───────────────────────────────────────────────

const TIER_COLOUR = {
  0: "#666666",  // Contact  -  grey
  1: "#ff4444",  // Active Ping  -  red
  2: "#e67e22",  // Breach Analysis  -  orange
  3: "#22ccbb",  // Deep Scan  -  teal
  4: "#cc44cc",  // Targeting Solution  -  magenta
};

const TIER_LABEL = {
  0: "Contact",
  1: "Pinged",
  2: "Analyzed",
  3: "Scanned",
  4: "Locked",
};

const TIER_TOOLTIP = {
  1: "Reveals target name and bearing",
  2: "Reveals void shield strength (bars only)",
  3: "Reveals shields, armour, hull status, and weapon loadout",
  4: "Full targeting solution  -  enables guided fire",
};

// ── Effect visual config (for utility / core effects) ─────────────────────

const EFFECT_VIS = {
  interferencePat:    { abbr: "IP", col: "#aa88ff" },
  targetingJamming:   { abbr: "TJ", col: "#ff6644" },
  lockHarmonics:      { abbr: "LH", col: "#44aaff" },
  sensorOvercharge:   { abbr: "SO", col: "#ffaa00" },
  combatTelemetry:    { abbr: "CT", col: "#66ff66" },
  signalInversion:    { abbr: "SI", col: "#cc44ff" },
  rangeAmplifier:     { abbr: "RA", col: "#22ccbb" },
};

// ── Greek alphabet for contact designation ────────────────────────────────

const GREEK = "αβγδεζηθικλμνξοπρστυφχψω";

// ── Module state ──────────────────────────────────────────────────────────

let _selectedTokenId  = null;
let _blips            = [];
let _activeSheet      = null;
let _activeSensorsCtx = null;
let _hooksRegistered  = false;
let _repaintPending   = false;
let _sweepAngle       = 0;         // current sweep arm angle (radians)
let _lastFrameTime    = 0;         // for delta-time animation
let _animFrameId      = null;      // rAF handle for continuous sweep
let _displayedBlips   = new Map(); // tokenId -> blip snapshot (position frozen until swept)
let _prevSweepAngle   = 0;         // previous frame's sweep angle for gate detection
let _trueBearing      = false;     // false = relative (heading-up), true = north-up
let _radarScale       = 0;         // user-set scale in grid squares (0 = auto)
let _popOutWindow     = null;      // SensorPopOut instance
let _popOutCanvas     = null;      // <canvas> element inside the pop-out window
let _highlightWeapon  = null;      // weapon item to highlight cone on radar (from popup hover)
let _pinnedWeapons    = [];        // pinned weapon cone overlays [{tokenId, position, range, extRange, arc}]
let _showScanRange    = false;     // whether to show the min scan range circle
let _targetScanRange  = 0;        // target ship's auto scan range (shown when H&A drawer open)

// ── Public API ────────────────────────────────────────────────────────────

export class SensorRadar {

  static get selectedTokenId() { return _selectedTokenId; }
  static set selectedTokenId(v) { _selectedTokenId = v; }

  /**
   * Main entry point  -  call from ShipSheet._onRender().
   * Paints the radar canvas and wires the click handler.
   */
  static attach(sheet, sensorsCtx) {
    _activeSheet      = sheet;
    _activeSensorsCtx = sensorsCtx;
    _registerHooks();

    const _root = sheet.element?.querySelector ? sheet.element : sheet.element?.[0];
    const el = _root?.querySelector?.("canvas[data-sensor-radar]");
    if (!el) return;

    _paint(el, sheet);
    _wireClick(el);
    _startSweepLoop(el, sheet);

    // Keep radar section collapsed while pop-out is open
    if (_popOutWindow && _popOutCanvas) {
      _collapseRadarSection(sheet, true);
    }
  }

  /**
   * Lightweight repaint  -  redraws the canvas without re-rendering the sheet.
   * Called by Foundry hooks when tokens move/appear/disappear.
   * Does NOT restart the animation loop  -  that runs continuously.
   */
  static repaint() {
    // The sweep loop handles continuous repainting.
    // External callers (hooks) just need to ensure the next frame picks up changes.
    // No explicit paint needed  -  the loop will repaint within ~16ms.
  }

  static clearSelection() {
    _selectedTokenId = null;
    _blips = [];
    _pinnedWeapons = [];
    _dismissPopup();
  }

  static toggleBearing() {
    _trueBearing = !_trueBearing;
  }

  static get isTrueBearing() { return _trueBearing; }

  static getSelectedBlip() {
    if (!_selectedTokenId) return null;
    return _blips.find(b => b.tokenId === _selectedTokenId) ?? null;
  }

  /** User-set radar scale (in grid squares). 0 = auto. */
  static get radarScale() { return _radarScale; }
  static set radarScale(v) { _radarScale = Math.max(0, v); }

  /**
   * Pop out the radar into a separate floating window.
   * The window contains a second <canvas> driven by the same paint loop.
   */
  static popOut(sheet) {
    if (_popOutWindow && !_popOutWindow._element?.length === 0) {
      // Already open  -  just bring to front
      _popOutWindow.bringToTop();
      return;
    }
    _popOutWindow = new SensorPopOut(sheet);
    _popOutWindow.render(true);

    // Collapse the radar section on the main sheet
    _collapseRadarSection(sheet, true);
  }

  static get popOutCanvas() { return _popOutCanvas; }
  static set popOutCanvas(v) { _popOutCanvas = v; }
  static get popOutWindow() { return _popOutWindow; }
  static set popOutWindow(v) { _popOutWindow = v; }
}

// ── Paint ─────────────────────────────────────────────────────────────────

function _paint(el, sheet) {
  const ship  = sheet.actor;
  const token = ship?.getActiveTokens?.()?.[0];
  if (!token || !canvas?.ready) return;

  const rect = el.parentElement.getBoundingClientRect();
  const side = Math.floor(Math.min(rect.width, rect.height));
  if (side < 40) return;
  el.width  = side;
  el.height = side;

  const ctx = el.getContext("2d");
  if (!ctx) return;

  // Refresh colour palette from system adapter (supports per-system theming)
  Object.assign(_pal, SystemAdapter.current.radarPalette?.() ?? {});

  const gridSize = canvas.grid.size;
  const sensor   = ShipCombatState.getSensorStats();
  const maxBands = (sensor.bandSize > 0 && sensor.rating > 0)
    ? Math.floor(sensor.rating / 10) : 0;

  const weapons = ship.items.filter(
    i => i.type === `${MODULE_ID}.component` && i.system.slot === "weapon"
  );
  const longestRange = weapons.reduce(
    (mx, w) => Math.max(mx, Number(w.system.range) || 0), 0
  );

  const maxDetectionSq = longestRange + maxBands * (sensor.bandSize || 1);
  const ghRange        = sensor.autoScanRange ?? 0;
  const maxRange       = sensor.maxRange ?? 0;

  // Own ship position & heading
  const tokenW  = token.document.width  * gridSize;
  const tokenH  = token.document.height * gridSize;
  const cx0     = token.document.x + tokenW / 2;
  const cy0     = token.document.y + tokenH / 2;
  const heading = (token.document.rotation + 90) * (Math.PI / 180);

  // Discover other tokens (include hidden tokens  -  visibility is managed by
  // TokenVisibility based on lock tier; the radar must always see all contacts)
  const candidates = canvas.tokens.placeables.filter(
    t => t.document.actor?.id !== ship.id
  );

  // Build a set of own-ship token IDs so we can recognise friendly ordnance
  const ownTokenIds = new Set(
    (ship.getActiveTokens?.() ?? []).map(t => t.id)
  );

  const locks = SystemAdapter.current.getShipData(ship).resources?.sensors?.locks ?? [];

  const rawBlips = [];
  for (const c of candidates) {
    const cW = c.document.width  * gridSize;
    const cH = c.document.height * gridSize;
    const tx = c.document.x + cW / 2;
    const ty = c.document.y + cH / 2;
    const dx = tx - cx0;
    const dy = ty - cy0;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const distSq = distPx / gridSize;
    const angle    = Math.atan2(dy, dx);
    const relAngle = angle - heading;
    const tokenId  = c.id;

    // Check if this is friendly ordnance (torpedo / strike craft launched by us)
    const actorType = c.document.actor?.type ?? "";
    const isOrdnance = _isOrdnanceActor(c.document.actor);
    const parentTokenId = SystemAdapter.current.getShipData(c.document.actor)?.parentShipTokenId ?? "";
    const friendly = isOrdnance && ownTokenIds.has(parentTokenId);

    // Effective lock tier (explicit + auto-lock within guaranteed range)
    // Friendly ordnance is always fully identified (tier 4)
    let lockTier;
    if (friendly) {
      lockTier = 4;
    } else {
      const explicitLock = locks.find(l => l.targetTokenId === tokenId);
      const explicitTier = explicitLock?.tier ?? 0;
      const autoTier     = (ghRange > 0 && distSq <= ghRange) ? 2 : 0;
      lockTier = Math.max(explicitTier, autoTier);
    }

    rawBlips.push({
      tokenId,
      realName:   c.document.name ?? "?",
      name:       friendly ? (c.document.name ?? "?") : _contactName(tokenId, lockTier, candidates),
      distSq,
      relAngle,
      absAngle:   angle,
      lockTier,
      friendly,
      actorType:  actorType,
      actorSubtype: _ordnanceSubtype(c.document.actor),
      decayRounds: friendly ? 0 : (locks.find(l => l.targetTokenId === tokenId)?.decayRounds ?? 0),
      selected:   c.id === _selectedTokenId,
      // Target heading: relative for REL radar, absolute for TRUE radar.
      // Both stored so the rendering code can pick the right one.
      targetHeadingRel: (c.document.rotation + 90) * (Math.PI / 180) - heading - Math.PI / 2,
      targetHeadingAbs: (c.document.rotation + 90) * (Math.PI / 180),
    });
  }

  // ── Sweep-gated position updates ───────────────────────────────
  // Blips only update their on-screen position when the sweep arm
  // passes over their angle, like a real phosphor radar display.
  let sweepGating = false;
  try { sweepGating = game.settings.get(MODULE_ID, "sweepGatedPositions"); } catch { /* not ready */ }
  {  // eslint-disable-line
    const TWO_PI   = Math.PI * 2;
    const prevNorm = ((_prevSweepAngle % TWO_PI) + TWO_PI) % TWO_PI;
    const currNorm = ((_sweepAngle     % TWO_PI) + TWO_PI) % TWO_PI;

    for (const b of rawBlips) {
      // Use absolute angle (+π/2 to match sweep coordinate system) in TRUE mode
      const sweepRef = _trueBearing ? (b.absAngle + Math.PI / 2) : b.relAngle;
      const bNorm = ((sweepRef % TWO_PI) + TWO_PI) % TWO_PI;
      const swept = sweepGating ? _wasSwept(prevNorm, currNorm, bNorm) : true;

      if (swept) {
        // Full update  -  position + metadata
        _displayedBlips.set(b.tokenId, { ...b });
      } else if (_displayedBlips.has(b.tokenId)) {
        // Metadata-only update  -  keep frozen position
        const d = _displayedBlips.get(b.tokenId);
        d.lockTier            = b.lockTier;
        d.name                = b.name;
        d.realName            = b.realName;
        d.actorType           = b.actorType;
        d.actorSubtype        = b.actorSubtype;
        d.selected            = (b.tokenId === _selectedTokenId);
        d.decayRounds         = b.decayRounds;
        d.targetHeadingRel    = b.targetHeadingRel;
        d.targetHeadingAbs    = b.targetHeadingAbs;
      } else {
        // Brand-new blip  -  show immediately
        _displayedBlips.set(b.tokenId, { ...b });
      }
    }

    // Remove blips for tokens that no longer exist
    const liveIds = new Set(rawBlips.map(b => b.tokenId));
    for (const id of _displayedBlips.keys()) {
      if (!liveIds.has(id)) _displayedBlips.delete(id);
    }
    _prevSweepAngle = _sweepAngle;
  }

  const maxRawSq    = rawBlips.reduce((m, b) => Math.max(m, b.distSq), 0);
  const maxDispSq   = [..._displayedBlips.values()].reduce((m, b) => Math.max(m, b.distSq), 0);
  const maxBlipSq   = Math.max(maxRawSq, maxDispSq);

  // Scope radius: user-set scale overrides auto-calculation
  let scopeRadius;
  if (_radarScale > 0) {
    scopeRadius = _radarScale * (1 + EDGE_PAD);
  } else if (maxRange > 0) {
    scopeRadius = maxRange * (1 + EDGE_PAD);
  } else {
    scopeRadius = Math.max(maxDetectionSq, maxBlipSq, 5) * (1 + EDGE_PAD);
  }
  const pxPerSq     = (side / 2) / scopeRadius;

  // Effects data
  const effects = SystemAdapter.current.getShipData(ship).resources?.sensors?.effects ?? [];

  // ── Background ────────────────────────────────────────────────────

  ctx.clearRect(0, 0, side, side);
  ctx.fillStyle = RADAR_BG;
  ctx.fillRect(0, 0, side, side);
  const half = side / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half - 1, 0, Math.PI * 2);
  ctx.clip();

  // Crosshairs
  ctx.strokeStyle = _pal.crosshair;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(half, 0); ctx.lineTo(half, side);
  ctx.moveTo(0, half); ctx.lineTo(side, half);
  ctx.stroke();

  // Heading line (subtle forward bearing indicator)
  ctx.strokeStyle = _pal.heading;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 6]);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(half, half);
  if (_trueBearing) {
    // TRUE mode: draw heading line in the ship's actual compass direction
    const hx = half + half * Math.cos(heading);
    const hy = half + half * Math.sin(heading);
    ctx.lineTo(hx, hy);
  } else {
    // REL mode: heading is always straight up
    ctx.lineTo(half, 0);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // ── Range rings ───────────────────────────────────────────────────

  if (maxRange > 0) {
    _drawRing(ctx, half, half, maxRange * pxPerSq, "rgba(255, 68, 68, 0.25)", 1.5);
  }

  if (ghRange > 0) {
    _drawRing(ctx, half, half, ghRange * pxPerSq, _pal.ghRing, 1.5);
    _drawRingLabel(ctx, half, ghRange * pxPerSq, `${ghRange}`, _pal.friendly);

    // Filled min scan range zone when Hull & Armament drawer is open (L3+)
    if (_showScanRange) {
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = _pal.friendly;
      ctx.beginPath();
      ctx.arc(half, half, ghRange * pxPerSq, 0, Math.PI * 2);
      ctx.fill();
      // Brighter ring to emphasize
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = _pal.friendly;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(half, half, ghRange * pxPerSq, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  const uniqueRanges = [...new Set(weapons.map(w => Number(w.system.range) || 0))]
    .filter(r => r > 0).sort((a, b) => a - b);
  for (const r of uniqueRanges) {
    _drawRing(ctx, half, half, r * pxPerSq, _pal.ring, 1);
    _drawRingLabel(ctx, half, r * pxPerSq, `${r}`, _pal.ringLabel);
  }

  if (maxBands > 0 && sensor.bandSize > 0 && longestRange > 0) {
    for (let b = 1; b <= maxBands; b++) {
      const rSq = longestRange + b * sensor.bandSize;
      _drawRing(ctx, half, half, rSq * pxPerSq, _pal.ring, 0.5);
    }
  }

  // ── Bearing tick marks (every 30°) ─────────────────────────────────
  {
    const edgeR  = half - 2;
    const tickIn = edgeR - 8;          // inner end of tick
    const labelR = edgeR - 16;         // label centre distance
    const bearingOffset = 0; // North is always at top in both modes

    ctx.strokeStyle = _pal.ringLabel;
    ctx.lineWidth   = 1;
    ctx.fillStyle   = _pal.ringLabel;
    ctx.font        = "9px monospace";
    ctx.textAlign   = "center";
    ctx.textBaseline = "middle";

    for (let deg = 0; deg < 360; deg += 30) {
      const rad   = (deg * Math.PI / 180) - Math.PI / 2 - bearingOffset;
      const ox    = Math.cos(rad);
      const oy    = Math.sin(rad);
      const isMajor = deg % 90 === 0;
      const inner = isMajor ? tickIn - 4 : tickIn;

      ctx.beginPath();
      ctx.moveTo(half + ox * inner, half + oy * inner);
      ctx.lineTo(half + ox * edgeR, half + oy * edgeR);
      ctx.stroke();

      // Label  -  cardinals at 90° intervals, degrees at 30° intervals
      const cardinals = { 0: "N", 90: "E", 180: "S", 270: "W" };
      if (isMajor) {
        ctx.font = "bold 9px monospace";
        ctx.fillText(cardinals[deg], half + ox * labelR, half + oy * labelR);
      } else {
        ctx.font = "8px monospace";
        ctx.fillText(`${deg}`, half + ox * labelR, half + oy * labelR);
      }
    }
  }

  // ── Animated sweep arm ─────────────────────────────────────────────
  // Draws a bright radial line at _sweepAngle with a wide trailing glow.
  {
    const armAngle = _sweepAngle - Math.PI / 2; // offset so 0 = top
    const armLen   = half;

    // Wide trailing arc (~80°) with conic gradient mapped to the arc fraction
    const trailArc = 1.4;  // ~80° trailing sweep
    const arcFrac  = trailArc / (Math.PI * 2); // ≈0.223 of the full circle
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(armAngle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, armLen, -trailArc, 0);
    ctx.closePath();
    const trailGrad = ctx.createConicGradient(-trailArc, 0, 0);
    trailGrad.addColorStop(0, "transparent");
    trailGrad.addColorStop(arcFrac * 0.25, _pal.trailStop1);
    trailGrad.addColorStop(arcFrac * 0.5,  _pal.trailStop2);
    trailGrad.addColorStop(arcFrac * 0.75, _pal.trailStop3);
    trailGrad.addColorStop(arcFrac,        _pal.sweep);
    // Hard cut-off beyond the visible arc to prevent ghost bleed
    trailGrad.addColorStop(Math.min(arcFrac + 0.001, 1), "transparent");
    ctx.fillStyle = trailGrad;
    ctx.fill();
    ctx.restore();

    // Bright sweep line with glow
    ctx.save();
    ctx.shadowColor = _pal.sweepGlow;
    ctx.shadowBlur  = 6;
    ctx.strokeStyle = _pal.sweep;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(half, half);
    const ex = half + armLen * Math.cos(armAngle);
    const ey = half + armLen * Math.sin(armAngle);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
  }

  // ── Blips ─────────────────────────────────────────────────────────

  _blips = [];
  for (const b of _displayedBlips.values()) {
    // REL mode: heading-up (relAngle - π/2).  TRUE mode: north-up (absAngle).
    const radarAngle = _trueBearing ? b.absAngle : (b.relAngle - Math.PI / 2);
    const r  = b.distSq * pxPerSq;
    const bx = half + r * Math.cos(radarAngle);
    const by = half + r * Math.sin(radarAngle);

    const isSelected = b.selected;
    const isOrd = actorTypeIsOrdnance(b.actorType);
    const tierCol = b.friendly ? (isOrd ? _pal.friendlyOrd : _pal.friendly) : (TIER_COLOUR[b.lockTier] ?? TIER_COLOUR[0]);

    // Sweep proximity  -  blip colour shifts toward green when the sweep arm
    // passes, then decays back to the original tier colour over ~2 seconds.
    const sweepRef      = _trueBearing ? (b.absAngle + Math.PI / 2) : b.relAngle;
    const blipAngleNorm = ((sweepRef % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const sweepNorm     = ((_sweepAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let sweepDelta      = (sweepNorm - blipAngleNorm + Math.PI * 2) % (Math.PI * 2);
    // sweepBoost: 1 at sweep arm, decays to 0 over ~2s worth of angular distance
    const DECAY_ARC     = SWEEP_SPEED * 2.0;  // radians the arm covers in 2 seconds
    const sweepBoost    = sweepDelta < DECAY_ARC ? (1 - sweepDelta / DECAY_ARC) : 0;
    const col = isSelected ? BLIP_SELECTED : _lerpColour(tierCol, _pal.sweepHighlight, sweepBoost * 0.7);

    // Constant brightness  -  no dimming/blinking
    ctx.globalAlpha = isSelected ? 1.0 : 0.85;
    ctx.shadowColor = col;
    ctx.shadowBlur  = isSelected ? 14 : (4 + sweepBoost * 18);

    ctx.fillStyle = col;
    const rad = BLIP_RADIUS;

    if (b.lockTier >= 2) {
      const arrowHeading = _trueBearing ? b.targetHeadingAbs : b.targetHeadingRel;
      const isTorpedo = actorTypeIsTorpedo(b.actorType, b.actorSubtype);
      const isCraft   = actorTypeIsStrikeCraft(b.actorType, b.actorSubtype);
      if (isTorpedo) {
        _drawTorpedoBlip(ctx, bx, by, rad, arrowHeading);
      } else if (isCraft) {
        _drawCraftBlip(ctx, bx, by, rad, arrowHeading);
      } else {
        _drawArrowBlip(ctx, bx, by, rad, arrowHeading);
      }
    } else {
      // Simple circle for tier 0-1
      ctx.beginPath();
      ctx.arc(bx, by, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Lock tier ring (concentric indicator)
    if (b.lockTier > 0) {
      // Tier 1 (Active Ping): filled halo  -  translucent red ring fill + stroke
      if (b.lockTier === 1) {
        ctx.fillStyle   = TIER_COLOUR[1]; // "#ff4444"
        ctx.globalAlpha = 0.20;
        ctx.beginPath();
        ctx.arc(bx, by, BLIP_RADIUS + 5, 0, Math.PI * 2, false); // outer CW
        ctx.arc(bx, by, rad,              0, Math.PI * 2, true);  // inner CCW  -  creates donut
        ctx.fill();
      }
      ctx.strokeStyle = tierCol;
      ctx.lineWidth   = 1;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(bx, by, BLIP_RADIUS + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Name label (contact designation or real name per tier)
    ctx.fillStyle = col;
    ctx.font      = `${isSelected ? "bold " : ""}10px monospace`;
    ctx.textAlign = "center";
    const label   = b.name.length > 14 ? b.name.slice(0, 13) + "\u2026" : b.name;
    ctx.fillText(label, bx, by - BLIP_RADIUS - 4);

    // Effect badges (utility/core effects only)
    const blipEffects = effects.filter(e => e.targetTokenId === b.tokenId);
    if (blipEffects.length) {
      _drawEffectBadges(ctx, bx, by, blipEffects);
    }

    _blips.push({ ...b, canvasX: bx, canvasY: by });
  }

  // ── Weapon cone highlight (from popup hover) ─────────────────────────
  if (_highlightWeapon) {
    const hBlip = _blips.find(b => b.tokenId === _highlightWeapon.tokenId);
    if (hBlip) {
      const wRange = _highlightWeapon.range * pxPerSq;
      const wExtRange = (_highlightWeapon.extRange || _highlightWeapon.range) * pxPerSq;
      // Weapon position offset relative to target heading
      const POS_ANGLE_OFFSET = { prow: 0, dorsal: 0, port: -Math.PI / 2, starboard: Math.PI / 2 };
      const posOffset = POS_ANGLE_OFFSET[_highlightWeapon.position] ?? 0;
      // In TRUE mode use absolute heading; in REL mode use relative heading
      const targetHeading = _trueBearing ? hBlip.targetHeadingAbs : hBlip.targetHeadingRel;
      const coneCenter = targetHeading + posOffset;
      const halfArc = (_highlightWeapon.arc * Math.PI / 180) / 2;

      ctx.save();

      // Draw extended-range band first (behind base cone) if it exists
      if (wExtRange > wRange) {
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = "#ff4444";
        ctx.beginPath();
        ctx.arc(hBlip.canvasX, hBlip.canvasY, wExtRange, coneCenter - halfArc, coneCenter + halfArc);
        ctx.arc(hBlip.canvasX, hBlip.canvasY, wRange, coneCenter + halfArc, coneCenter - halfArc, true);
        ctx.closePath();
        ctx.fill();

        // Dashed border for extended range
        ctx.globalAlpha = 0.30;
        ctx.strokeStyle = "#ff4444";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(hBlip.canvasX, hBlip.canvasY, wExtRange, coneCenter - halfArc, coneCenter + halfArc);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Base weapon range cone (solid)
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = "#ff4444";
      ctx.beginPath();
      ctx.moveTo(hBlip.canvasX, hBlip.canvasY);
      ctx.arc(hBlip.canvasX, hBlip.canvasY, wRange, coneCenter - halfArc, coneCenter + halfArc);
      ctx.closePath();
      ctx.fill();

      // Cone border
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = "#ff4444";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hBlip.canvasX, hBlip.canvasY);
      ctx.arc(hBlip.canvasX, hBlip.canvasY, wRange, coneCenter - halfArc, coneCenter + halfArc);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Pinned weapon arc overlays ───────────────────────────────────────────
  if (_pinnedWeapons.length > 0) {
    const POS_ANGLE_OFFSET = { prow: 0, dorsal: 0, port: -Math.PI / 2, starboard: Math.PI / 2 };
    // Prune pins whose lock has dropped below 3
    for (let i = _pinnedWeapons.length - 1; i >= 0; i--) {
      const pw = _pinnedWeapons[i];
      const pwBlip = _blips.find(b => b.tokenId === pw.tokenId);
      if (!pwBlip || (pwBlip.lockTier ?? 0) < 3) {
        _pinnedWeapons.splice(i, 1);
        continue;
      }
    }
    for (const pw of _pinnedWeapons) {
      const pwBlip = _blips.find(b => b.tokenId === pw.tokenId);
      if (!pwBlip) continue;
      const pwRange    = pw.range * pxPerSq;
      const pwExtRange = (pw.extRange || pw.range) * pxPerSq;
      const posOff     = POS_ANGLE_OFFSET[pw.position] ?? 0;
      const tgtHdg     = _trueBearing ? pwBlip.targetHeadingAbs : pwBlip.targetHeadingRel;
      const center     = tgtHdg + posOff;
      const halfArc    = (pw.arc * Math.PI / 180) / 2;

      ctx.save();
      // Extended band (dashed)
      if (pwExtRange > pwRange) {
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = "#ff4444";
        ctx.beginPath();
        ctx.arc(pwBlip.canvasX, pwBlip.canvasY, pwExtRange, center - halfArc, center + halfArc);
        ctx.arc(pwBlip.canvasX, pwBlip.canvasY, pwRange, center + halfArc, center - halfArc, true);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = "#ff4444";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(pwBlip.canvasX, pwBlip.canvasY, pwExtRange, center - halfArc, center + halfArc);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Base cone
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#ff4444";
      ctx.beginPath();
      ctx.moveTo(pwBlip.canvasX, pwBlip.canvasY);
      ctx.arc(pwBlip.canvasX, pwBlip.canvasY, pwRange, center - halfArc, center + halfArc);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#ff4444";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pwBlip.canvasX, pwBlip.canvasY);
      ctx.arc(pwBlip.canvasX, pwBlip.canvasY, pwRange, center - halfArc, center + halfArc);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Target auto-scan range circle (shown when H&A drawer open at L3+) ──
  if (_showScanRange && _targetScanRange > 0 && _selectedTokenId) {
    const selBlip = _blips.find(b => b.tokenId === _selectedTokenId);
    if (selBlip) {
      const tgtScanPx = _targetScanRange * pxPerSq;
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = "#ff4444";
      ctx.beginPath();
      ctx.arc(selBlip.canvasX, selBlip.canvasY, tgtScanPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = "#ff6644";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(selBlip.canvasX, selBlip.canvasY, tgtScanPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // Own ship marker
  ctx.fillStyle   = _pal.friendly;
  ctx.shadowColor = _pal.friendly;
  ctx.shadowBlur  = 8;
  if (_trueBearing) {
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(heading + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(-5, 4);
    ctx.lineTo(5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.moveTo(half, half - 7);
    ctx.lineTo(half - 5, half + 4);
    ctx.lineTo(half + 5, half + 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  ctx.restore();

  // Outer rim
  ctx.strokeStyle = _pal.outerRim;
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.arc(half, half, half - 1, 0, Math.PI * 2);
  ctx.stroke();


  // Update canvas token visibility based on lock state
  refreshTokenVisibility();
}

// ── Arrow blip (directional heading indicator) ────────────────────────────

/** Draw a small triangular "arrow" blip pointing in the target's heading direction. */
function _drawArrowBlip(ctx, cx, cy, r, angle) {
  const tipLen  = r * 1.6;   // tip extends forward from centre
  const baseW   = r * 1.0;   // half-width of back edge
  const tailLen = r * 0.8;   // tail extends backward from centre

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(tipLen, 0);                 // nose
  ctx.lineTo(-tailLen, -baseW);          // back-left
  ctx.lineTo(-tailLen * 0.4, 0);         // inner notch
  ctx.lineTo(-tailLen, baseW);           // back-right
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Draw a narrow diamond blip for identified torpedo contacts  -  smaller than ships. */
function _drawTorpedoBlip(ctx, cx, cy, r, angle) {
  const dotR   = r * 0.55;    // small leading dot
  const tailLen = r * 1.8;    // trailing exhaust line

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // Trailing exhaust tail
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha *= 0.4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-tailLen, 0);
  ctx.stroke();
  ctx.globalAlpha /= 0.4; // restore

  // Leading dot (warhead)
  ctx.beginPath();
  ctx.arc(0, 0, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Draw a swept-wing blip for identified strike craft contacts. */
function _drawCraftBlip(ctx, cx, cy, r, angle) {
  const tipLen = r * 1.4;
  const wingW  = r * 1.4;
  const tailLen = r * 0.6;
  const bodyW  = r * 0.3;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(tipLen, 0);             // nose
  ctx.lineTo(0, -wingW);             // left wingtip
  ctx.lineTo(-tailLen * 0.3, -bodyW); // left body
  ctx.lineTo(-tailLen, 0);           // tail
  ctx.lineTo(-tailLen * 0.3, bodyW); // right body
  ctx.lineTo(0, wingW);              // right wingtip
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── Effect badges ─────────────────────────────────────────────────────────

function _drawEffectBadges(ctx, cx, cy, effects) {
  const totalW  = effects.length * 16;
  let startX    = cx - totalW / 2;
  const badgeY  = cy + BLIP_RADIUS + 16;

  for (const e of effects) {
    const vis = EFFECT_VIS[e.actionId] ?? { abbr: "??", col: "#888" };
    const px  = startX;
    startX += 16;

    // Background pill
    ctx.globalAlpha = 0.85;
    ctx.fillStyle   = vis.col;
    _roundRect(ctx, px, badgeY - 5, 14, 11, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Abbreviation
    ctx.fillStyle = "#000";
    ctx.font      = "bold 7px monospace";
    ctx.textAlign = "center";
    ctx.fillText(vis.abbr, px + 7, badgeY + 3);

    // Duration exponent  -  rendered inside the badge (upper-right corner)
    if (e.roundsRemaining > 1) {
      ctx.fillStyle = "#000";
      ctx.font      = "bold 5px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`${e.roundsRemaining}`, px + 13, badgeY - 1);
    }
  }
}

// ── Popup management ──────────────────────────────────────────────────────

let _popupEl = null;
let _outsideHandler = null;

function _showPopup(blip, canvasEl) {
  _dismissPopup();

  const wrap = canvasEl.parentElement;
  if (!wrap) return;
  const ctx = _activeSensorsCtx ?? {};
  const effects = SystemAdapter.current.getShipData(_activeSheet?.actor)?.resources?.sensors?.effects ?? [];
  const blipEffects = effects.filter(e => e.targetTokenId === blip.tokenId);

  const popup = document.createElement("div");
  popup.className = "shipcombat-radar-popup";

  // Position: favour the side of the radar with more room
  const side = canvasEl.width;
  const popupW = 220;
  let left = Math.max(8, Math.min(blip.canvasX - popupW / 2, side - popupW - 8));
  const above = blip.canvasY > side * 0.55;

  popup.style.left   = `${left}px`;
  popup.style.width  = `${popupW}px`;
  if (above) {
    popup.style.bottom = `${side - blip.canvasY + 16}px`;
  } else {
    popup.style.top = `${blip.canvasY + 16}px`;
  }

  popup.innerHTML = _buildPopupHTML(blip, ctx, blipEffects);
  wrap.style.position = "relative";
  wrap.appendChild(popup);
  _popupEl = popup;

  // Wire close button
  popup.querySelector("[data-dismiss-popup]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    _selectedTokenId = null;
    _dismissPopup();
    SensorRadar.repaint();
  });

  // Wire action buttons  -  lock upgrades, utility, core actions
  // In the pop-out, Foundry's data-action delegation doesn't reach the sheet,
  // so we manually invoke the sensor action handlers with the sheet as context.
  popup.querySelectorAll("[data-radar-action]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      const sheet = _activeSheet;
      if (!sheet) return;
      const actionName = btn.dataset.action;
      const handler = SENSORS_ACTIONS[actionName];
      if (handler) {
        handler.call(sheet, ev, btn);
        // Refresh the popup after a short delay to reflect new state
        setTimeout(() => {
          if (_selectedTokenId) {
            const selBlip = _blips.find(b => b.tokenId === _selectedTokenId);
            if (selBlip) {
              _showPopup(selBlip, canvasEl);
            }
          }
        }, 300);
      }
    });
  });

  // Close on outside click
  _outsideHandler = (ev) => {
    if (_popupEl && !_popupEl.contains(ev.target) && ev.target !== canvasEl) {
      _selectedTokenId = null;
      _dismissPopup();
      SensorRadar.repaint();
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", _outsideHandler), 0);

  // Wire weapon cone hover (Lock ≥ 3 only  -  that's when Hull & Armament drawer is visible)
  popup.querySelectorAll(".shipcombat-rpop-wep-entry[data-wep-pos]").forEach(entry => {
    entry.addEventListener("mouseenter", () => {
      _highlightWeapon = {
        tokenId:  blip.tokenId,
        position: entry.dataset.wepPos,
        range:    Number(entry.dataset.wepRange) || 0,
        extRange: Number(entry.dataset.wepExtRange) || 0,
        arc:      Number(entry.dataset.wepArc) || 90,
      };
    });
    entry.addEventListener("mouseleave", () => {
      _highlightWeapon = null;
    });
  });

  // Wire weapon arc pin toggles
  popup.querySelectorAll(".shipcombat-rpop-pin-arc[data-pin-wep]").forEach(btn => {
    const entry = btn.closest(".shipcombat-rpop-wep-entry");
    if (!entry) return;
    const pinKey = btn.dataset.pinWep;
    const tokenId = blip.tokenId;
    const fullKey = `${tokenId}::${pinKey}`;

    // Restore active state from existing pins
    if (_pinnedWeapons.some(p => p._key === fullKey)) {
      btn.classList.add("shipcombat-pin-active");
    }

    btn.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const idx = _pinnedWeapons.findIndex(p => p._key === fullKey);
      if (idx >= 0) {
        _pinnedWeapons.splice(idx, 1);
        btn.classList.remove("shipcombat-pin-active");
      } else {
        _pinnedWeapons.push({
          _key:     fullKey,
          tokenId,
          position: entry.dataset.wepPos,
          range:    Number(entry.dataset.wepRange) || 0,
          extRange: Number(entry.dataset.wepExtRange) || 0,
          arc:      Number(entry.dataset.wepArc) || 90,
        });
        btn.classList.add("shipcombat-pin-active");
      }
    });
  });

  // Track Hull & Armament drawer open state for min scan range circle
  const armDrawer = popup.querySelector(".shipcombat-rpop-armament-drawer");
  if (armDrawer) {
    // Compute the target's auto scan range
    const targetActor = canvas.tokens.get(blip.tokenId)?.document?.actor;
    const targetSensor = targetActor ? ShipCombatState.getSensorStats(targetActor) : null;
    const tgtScanR = targetSensor?.autoScanRange ?? 0;
    armDrawer.addEventListener("toggle", () => {
      _showScanRange = armDrawer.open;
      _targetScanRange = armDrawer.open ? tgtScanR : 0;
    });
  }
}

function _buildPopupHTML(blip, ctx, blipEffects) {
  const loc = (k) => game.i18n.localize(k);
  const tier = blip.lockTier ?? 0;
  const isBlipOrd = actorTypeIsOrdnance(blip.actorType);
  const tierCol = blip.friendly ? (isBlipOrd ? _pal.friendlyOrd : _pal.friendly) : (TIER_COLOUR[tier] ?? TIER_COLOUR[0]);

  // Friendly ordnance gets its own dedicated popup
  const isTorpedo = actorTypeIsTorpedo(blip.actorType, blip.actorSubtype);
  const isCraft   = actorTypeIsStrikeCraft(blip.actorType, blip.actorSubtype);
  if (blip.friendly && (isTorpedo || isCraft)) {
    return _buildFriendlyOrdnancePopupHTML(blip, isTorpedo, ctx);
  }

  let h = "";

  // Header
  h += `<div class="shipcombat-rpop-header">`;
  h += `<span class="shipcombat-rpop-name">${_esc(blip.name)}</span>`;
  h += `<button class="shipcombat-rpop-close" data-dismiss-popup><i class="fa-solid fa-xmark"></i></button>`;
  h += `</div>`;

  // Lock tier status
  const tierTip = TIER_TOOLTIP[tier] ?? "";
  h += `<div class="shipcombat-rpop-lock" style="color:${tierCol}" title="${_esc(tierTip)}">`;
  h += `<i class="fa-solid fa-crosshairs"></i> `;
  h += `Lock ${tier}  -  ${TIER_LABEL[tier] ?? "Unknown"}`;
  if (blip.decayRounds > 0) h += ` <span class="shipcombat-rpop-decay">(${blip.decayRounds} rnd)</span>`;
  h += `</div>`;

  // Bearing (tier 1+)
  if (tier >= 1) {
    const bearingDeg = Math.round((((blip.relAngle * 180 / Math.PI) % 360) + 360) % 360);
    h += `<div class="shipcombat-rpop-bearing"><i class="fa-solid fa-compass"></i> Bearing: ${bearingDeg.toString().padStart(3, '0')}°</div>`;
  }

  // Active effects (utility/core only)
  if (blipEffects.length > 0) {
    h += `<div class="shipcombat-rpop-fx">`;
    for (const e of blipEffects) {
      const vis = EFFECT_VIS[e.actionId] ?? { abbr: "??", col: "#888" };
      const lbl = loc(`SHIPCOMBAT.Sensors.${_capitalize(e.actionId)}`) || e.actionId;
      h += `<span class="shipcombat-rpop-pip" style="background:${vis.col}" title="${_esc(lbl)}">${vis.abbr}`;
      if (e.roundsRemaining > 1) h += `<sup>${e.roundsRemaining}</sup>`;
      h += `</span>`;
    }
    h += `</div>`;
  }

  // ── Ship intel section (tier-gated) ─────────────────────────────
  h += _buildIntelHTML(blip, tier);

  // Status notices
  if (ctx.coreUsed) {
    h += `<div class="shipcombat-rpop-notice"><i class="fa-solid fa-lock"></i> ${loc("SHIPCOMBAT.Sensors.CoreActionUsed")}</div>`;
  }

  // ── Lock-upgrade actions (contextual based on current tier) ─────
  const lockActions = ctx.lockActions ?? [];
  const availableLockActions = lockActions.filter(a => a.setsTier > tier && tier >= a.requiresTier);

  if (availableLockActions.length > 0) {
    for (const a of availableLockActions) {
      const dis = a.canAfford ? "" : "disabled";
      const tierCol = TIER_COLOUR[a.setsTier] ?? TIER_COLOUR[0];
      const lockTip = a.descLocalized ?? (TIER_TOOLTIP[a.setsTier] ?? "");
      h += `<button class="shipcombat-rpop-btn shipcombat-rpop-btn--lock" style="border-color:${tierCol}" data-action="sensorAction" data-action-id="${a.id}" `;
      h += `data-target-token-id="${blip.tokenId}" data-radar-action title="${_esc(lockTip)}" ${dis}>`;
      h += `<i class="fa-solid fa-crosshairs" style="color:${tierCol}"></i> ${a.labelLocalized}`;
      h += `<span class="shipcombat-rpop-cost">${a.cost}</span>`;
      h += `<span class="shipcombat-rpop-tier-badge" style="color:${tierCol}">→ L${a.setsTier}</span></button>`;
    }
  }

  // ── Utility actions ──
  // Hostile torpedoes: only Designate Torpedo (+ lock upgrades above)
  // All others: hidden at tier 0; toolbar-only excluded
  const TOOLBAR_ACTION_IDS = ["lockHarmonics", "rangeAmplifier", "combatTelemetry"];
  const isHostileTorpedo = isTorpedo && !blip.friendly;
  const utilityActions = ctx.utilityActions ?? [];
  const visibleUtils = utilityActions.filter(a => {
    if (TOOLBAR_ACTION_IDS.includes(a.id)) return false;
    if (a.id === "designateTorpedo") return isTorpedo; // only on torpedo blips
    if (isHostileTorpedo) return false;               // hostile torps only get designate
    return tier >= 1;
  });
  if (visibleUtils.length > 0) {
    h += `<div class="shipcombat-rpop-divider"></div>`;
    for (const a of visibleUtils) {
      const dis = a.canAfford ? "" : "disabled";
      const tip = _esc(a.descLocalized ?? '');
      h += `<button class="shipcombat-rpop-btn" data-action="sensorAction" data-action-id="${a.id}" `;
      h += `data-target-token-id="${blip.tokenId}" `;
      h += `data-duration="${a.duration ?? 1}" data-radar-action title="${tip}" ${dis}>`;
      h += `<i class="fa-solid fa-satellite-dish"></i> ${a.labelLocalized}`;
      h += `<span class="shipcombat-rpop-cost">${a.cost}</span></button>`;
    }
  }

  // ── Core actions (always shown; disabled without core or at tier 0; hidden on hostile torpedoes) ──
  if (!isHostileTorpedo) {
    const coreActions = ctx.coreActions ?? [];
    const visibleCores = coreActions.filter(a => !TOOLBAR_ACTION_IDS.includes(a.id));
    if (visibleCores.length > 0) {
      h += `<div class="shipcombat-rpop-divider"></div>`;
      for (const a of visibleCores) {
        const hasCore = ctx.hasCoreAssigned;
        const dis = (hasCore && a.canAfford && tier >= 1) ? "" : "disabled";
        const tip = !hasCore ? "Requires assigned Power Core"
          : tier < 1 ? "Requires Lock 1"
          : _esc(a.descLocalized ?? '');
        h += `<button class="shipcombat-rpop-btn shipcombat-rpop-btn--core" data-action="sensorCoreAction" data-action-id="${a.id}" `;
        if (a.targeted) h += `data-target-token-id="${blip.tokenId}" `;
        h += `data-duration="${a.duration ?? 1}" data-radar-action title="${tip}" ${dis}>`;
        h += `<i class="fa-solid fa-bolt"></i> ${a.labelLocalized}`;
        if (a.cost) h += `<span class="shipcombat-rpop-cost">${a.cost}</span>`;
        h += `</button>`;
      }
    }
  }

  return h;
}

// ── Friendly ordnance popup builder ───────────────────────────────────────

function _buildFriendlyOrdnancePopupHTML(blip, isTorpedo, ctx) {
  const actor = canvas.tokens.get(blip.tokenId)?.document?.actor;
  const sys = SystemAdapter.current.getShipData(actor) ?? {};
  let h = "";

  // Header
  h += `<div class="shipcombat-rpop-header">`;
  h += `<span class="shipcombat-rpop-name" style="color:${_pal.friendlyOrd}">${_esc(blip.name)}</span>`;
  h += `<button class="shipcombat-rpop-close" data-dismiss-popup><i class="fa-solid fa-xmark"></i></button>`;
  h += `</div>`;

  // Type label
  const typeLabel = isTorpedo ? "Torpedo" : "Strike Craft";
  h += `<div class="shipcombat-rpop-lock" style="color:${_pal.friendlyOrd}">`;
  h += `<i class="fa-solid ${isTorpedo ? "fa-burst" : "fa-jet-fighter"}"></i> `;
  h += `${typeLabel}  -  Friendly`;
  h += `</div>`;

  if (isTorpedo) {
    // Torpedo-specific stats
    const hull = sys.hull ?? {};
    const _hullDisp = hullDisplay(hull.value, hull.max);
    const hullPct = _hullDisp.pct;
    const hullLabel = _hullDisp.isDamageTaken ? "Hull Damage" : "Hull Integrity";
    const hullVal = _hullDisp.displayValue;
    const fuel = sys.fuel ?? {};
    const fuelPct = fuel.max > 0 ? Math.round((fuel.value / fuel.max) * 100) : 0;
    const speed = sys.movement?.speed ?? 0;

    h += `<div class="shipcombat-rpop-intel">`;

    // Hull bar
    h += `<div class="shipcombat-rpop-hull-row">`;
    h += `<span class="shipcombat-rpop-hull-lbl">${hullLabel}</span>`;
    h += `<span class="shipcombat-rpop-hull-bar"><span class="shipcombat-rpop-hull-fill" style="width:${hullPct}%"></span></span>`;
    h += `<span class="shipcombat-rpop-hull-val">${hullVal}/${hull.max ?? 0}</span>`;
    h += `</div>`;

    // Fuel bar
    h += `<div class="shipcombat-rpop-hull-row">`;
    h += `<span class="shipcombat-rpop-hull-lbl">Fuel</span>`;
    h += `<span class="shipcombat-rpop-hull-bar"><span class="shipcombat-rpop-hull-fill" style="width:${fuelPct}%;background:${fuelPct < 25 ? "#ff4444" : "#ffaa00"}"></span></span>`;
    h += `<span class="shipcombat-rpop-hull-val">${fuel.value ?? 0}/${fuel.max ?? 0}</span>`;
    h += `</div>`;

    // Stats row
    h += `<div class="shipcombat-rpop-torp-stats">`;
    h += `<span class="shipcombat-rpop-torp-stat"><i class="fa-solid fa-gauge-high"></i> Spd ${speed}</span>`;
    h += `<span class="shipcombat-rpop-torp-stat"><i class="fa-solid fa-explosion"></i> Dmg ${sys.payloadDamage ?? 0}</span>`;
    if (sys.payloadRadius > 0) {
      h += `<span class="shipcombat-rpop-torp-stat"><i class="fa-solid fa-circle-radiation"></i> Rad ${sys.payloadRadius}</span>`;
    }
    h += `</div>`;

    // Traits
    const traitParts = [];
    if (sys.traits?.rend > 0) traitParts.push(`Rend ${sys.traits.rend}`);
    if (sys.traits?.armourPenetration > 0) traitParts.push(`AP ${sys.traits.armourPenetration}`);
    if (sys.traits?.shieldBurn > 0) traitParts.push(`Shield Burn ${sys.traits.shieldBurn}`);
    if (sys.traits?.shieldBypass) traitParts.push("Shield Bypass");
    if (traitParts.length > 0) {
      h += `<div class="shipcombat-rpop-torp-traits">`;
      for (const t of traitParts) {
        h += `<span class="shipcombat-rpop-torp-trait">${_esc(t)}</span>`;
      }
      h += `</div>`;
    }

    // Range / distance
    h += `<div class="shipcombat-rpop-torp-range">`;
    h += `<i class="fa-solid fa-ruler"></i> ${Math.round(blip.distSq * 10) / 10} ${game.i18n.localize("SHIPCOMBAT.Label.VoidUnits")}`;
    h += `</div>`;

    h += `</div>`;
  } else {
    // Strike craft  -  simpler
    const hull = sys.hull ?? {};
    const _hullDisp2 = hullDisplay(hull.value, hull.max);
    const hullPct = _hullDisp2.pct;
    const hullLabel2 = _hullDisp2.isDamageTaken ? "Hull Damage" : "Hull Integrity";
    const hullVal2 = _hullDisp2.displayValue;

    h += `<div class="shipcombat-rpop-intel">`;
    h += `<div class="shipcombat-rpop-hull-row">`;
    h += `<span class="shipcombat-rpop-hull-lbl">${hullLabel2}</span>`;
    h += `<span class="shipcombat-rpop-hull-bar"><span class="shipcombat-rpop-hull-fill" style="width:${hullPct}%"></span></span>`;
    h += `<span class="shipcombat-rpop-hull-val">${hullVal2}/${hull.max ?? 0}</span>`;
    h += `</div>`;

    h += `<div class="shipcombat-rpop-torp-range">`;
    h += `<i class="fa-solid fa-ruler"></i> ${Math.round(blip.distSq * 10) / 10} ${game.i18n.localize("SHIPCOMBAT.Label.VoidUnits")}`;
    h += `</div>`;
    h += `</div>`;
  }

  // Designate Torpedo action for friendly torpedoes (boost allied speed)
  if (isTorpedo) {
    const designateAction = (ctx.utilityActions ?? []).find(a => a.id === "designateTorpedo");
    if (designateAction) {
      const dis = designateAction.canAfford ? "" : "disabled";
      h += `<div class="shipcombat-rpop-divider"></div>`;
      h += `<button class="shipcombat-rpop-btn" data-action="sensorAction" data-action-id="designateTorpedo" `;
      h += `data-target-token-id="${blip.tokenId}" `;
      h += `data-radar-action title="${_esc(designateAction.descLocalized ?? '')}" ${dis}>`;
      h += `<i class="fa-solid fa-gauge-high"></i> Designate Torpedo`;
      h += `<span class="shipcombat-rpop-cost">${designateAction.cost}</span></button>`;
    }
  }

  return h;
}

function _dismissPopup() {
  if (_popupEl) {
    _popupEl.remove();
    _popupEl = null;
  }
  if (_outsideHandler) {
    document.removeEventListener("pointerdown", _outsideHandler);
    _outsideHandler = null;
  }
  _dismissOwnShipPopup();
  _highlightWeapon = null;
  _showScanRange = false;
  _targetScanRange = 0;
}

// ── Ship intel builder (tier-gated) ───────────────────────────────────────

const SECTOR_IDS    = ["bow", "stern", "port", "starboard"];
const SECTOR_LABELS = { bow: "Bow", stern: "Stern", port: "Port", starboard: "Stbd" };

/**
 * Build compact HTML for the tier-gated ship intel section in the radar popup.
 * Shields/armour and hull/weapons are behind collapsible drawers.
 *   Tier 2:  "Void Shields" drawer (opacity bars only  -  no numeric values)
 *   Tier 3+: "Void Shields" drawer (actual numeric values + armour)
 *   Tier 3+: "Hull & Armament" drawer (hull bar, fires, weapon loadout)
 */
function _buildIntelHTML(blip, tier) {
  if (tier < 2) return "";

  const actor = canvas.tokens.get(blip.tokenId)?.document?.actor;
  if (!actor) return "";
  const sys = SystemAdapter.current.getShipData(actor) ?? {};

  let h = `<div class="shipcombat-rpop-intel">`;

  // ── Drawer 1: Void Shields (tier 2+) ──────────────────────────
  const shields = sys.shields ?? {};
  const armour  = sys.armour ?? {};
  const shieldStats = sys.shieldStats ?? {};
  const maxPerSector = shieldStats.zoneThresholds ?? {};

  h += `<details class="shipcombat-rpop-drawer">`;
  h += `<summary class="shipcombat-rpop-drawer-hd"><i class="fa-solid fa-shield-halved"></i> Shields</summary>`;
  h += `<div class="shipcombat-rpop-drawer-body">`;
  h += `<div class="shipcombat-rpop-sectors">`;
  for (const s of SECTOR_IDS) {
    const lbl = SECTOR_LABELS[s];
    const sv  = shields[s] ?? 0;
    const zt  = maxPerSector[s] || 8;
    const pct = Math.min(100, Math.round((sv / zt) * 100));
    h += `<span class="shipcombat-rpop-sec">`;
    h += `<span class="shipcombat-rpop-sec-lbl">${lbl}</span>`;
    if (tier >= 3) {
      // Tier 3+: show actual numeric shield value
      h += `<span class="shipcombat-rpop-sec-sh" title="Shields">${sv}</span>`;
      const av = armour[s] ?? 0;
      h += `<span class="shipcombat-rpop-sec-ar" title="Armour">${av}</span>`;
    } else {
      // Tier 2: opacity bar only  -  no numbers
      h += `<span class="shipcombat-rpop-sec-bar" title="Shield strength"><span class="shipcombat-rpop-sec-bar-fill" style="width:${pct}%;opacity:${pct > 0 ? 1 : 0.2}"></span></span>`;
    }
    h += `</span>`;
  }
  h += `</div></div></details>`;

  // ── Drawer 2: Hull & Armament (tier 3+) ───────────────────────
  if (tier >= 3) {
    h += `<details class="shipcombat-rpop-drawer shipcombat-rpop-armament-drawer">`;
    h += `<summary class="shipcombat-rpop-drawer-hd"><i class="fa-solid fa-crosshairs"></i> Hull &amp; Armament</summary>`;
    h += `<div class="shipcombat-rpop-drawer-body shipcombat-rpop-armament-scroll">`;

    const hull    = sys.hull ?? {};
    const _hullDisp3 = hullDisplay(hull.value, hull.max);
    const hullPct = _hullDisp3.pct;
    const hullLabel3 = "Hit Points";
    const hullVal3 = _hullDisp3.displayValue;
    const fires   = sys.internalFire ?? 0;

    h += `<div class="shipcombat-rpop-hull-row">`;
    h += `<span class="shipcombat-rpop-hull-lbl">${hullLabel3}</span>`;
    h += `<span class="shipcombat-rpop-hull-bar"><span class="shipcombat-rpop-hull-fill" style="width:${hullPct}%"></span></span>`;
    h += `<span class="shipcombat-rpop-hull-val">${hullVal3}/${hull.max ?? 0}</span>`;
    if (fires > 0) {
      h += `<span class="shipcombat-rpop-fires"><i class="fa-solid fa-fire"></i>${fires}</span>`;
    }
    h += `</div>`;

    // AC (d20 systems only, e.g. SF2e) — shown at tier 3+
    const _displayAC = SystemAdapter.current.getTargetAC(actor);
    if (_displayAC !== null) {
      h += `<div class="shipcombat-rpop-hull-row">`;
      h += `<span class="shipcombat-rpop-hull-lbl">AC</span>`;
      h += `<span class="shipcombat-rpop-hull-val" style="margin-left:auto">${_displayAC}</span>`;
      h += `</div>`;
    }

    // Weapons grouped by 4 position sections
    const weapons = actor.items?.filter?.(
      i => i.type === `${MODULE_ID}.component` && i.system?.slot === "weapon"
    ) ?? [];
    // Compute target's sensor extended range (bands beyond weapon base range)
    const targetSensor = ShipCombatState.getSensorStats(actor);
    const tgtBandSize  = targetSensor.bandSize ?? 0;
    const tgtMaxBands  = (tgtBandSize > 0 && targetSensor.rating > 0)
      ? Math.floor(targetSensor.rating / 10) : 0;

    if (weapons.length > 0) {
      const POS_LABELS = { prow: "Prow", dorsal: "Dorsal", port: "Port", starboard: "Starboard" };
      const POS_ICONS = { prow: "fa-angles-up", dorsal: "fa-layer-group", port: "fa-angles-left", starboard: "fa-angles-right" };
      const posMap = {};
      for (const w of weapons) {
        const pos = w.system.weaponPosition ?? "prow";
        const bay = w.system.weaponBay ?? pos;
        const key = (pos === "flank") ? bay : pos;
        if (!posMap[key]) posMap[key] = [];
        const baseRange = Number(w.system.range) || 0;
        const extRange  = tgtMaxBands > 0 ? baseRange + tgtMaxBands * tgtBandSize : baseRange;
        posMap[key].push({ name: w.name, range: baseRange, extRange, position: key, arc: Number(w.system.degreeOfFire) || 90 });
      }
      for (const [pos, weps] of Object.entries(posMap)) {
        const label = POS_LABELS[pos] ?? _capitalize(pos);
        const icon  = POS_ICONS[pos] ?? "fa-crosshairs";
        // Group duplicates by name
        const grouped = {};
        for (const w of weps) {
          const k = w.name;
          if (!grouped[k]) grouped[k] = { ...w, count: 0 };
          grouped[k].count++;
        }
        h += `<div class="shipcombat-rpop-wep-section">`;
        h += `<div class="shipcombat-rpop-wep-section-hd"><i class="fa-solid ${icon}"></i> ${_esc(label)}</div>`;
        for (const w of Object.values(grouped)) {
          const pinKey = `${w.position}::${w.name}`;
          h += `<div class="shipcombat-rpop-wep-entry" data-wep-pos="${w.position}" data-wep-range="${w.range}" data-wep-ext-range="${w.extRange}" data-wep-arc="${w.arc}" data-wep-pin-key="${_esc(pinKey)}">`;
          h += `<span class="shipcombat-rpop-wep-name">${_esc(w.name)}`;
          if (w.count > 1) h += ` <span class="shipcombat-rpop-wep-count">\u00d7${w.count}</span>`;
          h += `</span>`;
          h += `<a class="shipcombat-rpop-pin-arc" data-pin-wep="${_esc(pinKey)}" title="Pin arc overlay"><i class="fa-solid fa-thumbtack"></i></a>`;
          h += `</div>`;
        }
        h += `</div>`;
      }
    }

    h += `</div></details>`;
  }

  // ── Drawer 3: Conditions (tier 4+, NPC ships only) ────────────────────────
  if (tier >= 4 && blip.actorType === `${MODULE_ID}.npcShip`) {
    const rawConds = sys.conditions ?? {};
    const CRIT_LOCS = ["hull", "engines", "manoeuvring", "coreSystems", "weaponsSensors"];
    const condList = CRIT_LOCS
      .map(locId => ({ locId, condTier: rawConds[locId]?.tier ?? null }))
      .filter(c => c.condTier);
    h += `<details class="shipcombat-rpop-drawer">`;
    h += `<summary class="shipcombat-rpop-drawer-hd"><i class="fa-solid fa-triangle-exclamation"></i> Conditions</summary>`;
    h += `<div class="shipcombat-rpop-drawer-body">`;
    if (condList.length > 0) {
      for (const c of condList) {
        const locLabel   = game.i18n.localize(`SHIPCOMBAT.Crit.Location.${c.locId}`);
        const condEffect = game.i18n.localize(`SHIPCOMBAT.Crit.Effect.${c.locId}.${c.condTier}`);
        h += `<div class="shipcombat-rpop-wep-entry shipcombat-crit-tier--${c.condTier}" title="${_esc(condEffect)}">`;        h += `<span class="shipcombat-rpop-wep-name">${_esc(locLabel)}</span>`;
        h += `<span class="shipcombat-rpop-cond-tier">${_capitalize(c.condTier)}</span>`;
        h += `</div>`;
      }
    } else {
      h += `<div class="shipcombat-rpop-wep-entry"><span class="shipcombat-rpop-wep-name" style="opacity:0.6">No active conditions</span></div>`;
    }
    h += `</div></details>`;
  }

  // ── Drawer 4: Defenses / IWR (tier 4+) ────────────────────────────────
  if (tier >= 4) {
    const iwr = SystemAdapter.current.getIWR(actor);
    if (iwr && (iwr.immunities.length || iwr.weaknesses.length || iwr.resistances.length)) {
      h += `<details class="shipcombat-rpop-drawer">`;
      h += `<summary class="shipcombat-rpop-drawer-hd"><i class="fa-solid fa-shield-halved"></i> Defenses</summary>`;
      h += `<div class="shipcombat-rpop-drawer-body">`;

      if (iwr.immunities.length) {
        h += `<div class="shipcombat-rpop-wep-section">`;
        h += `<div class="shipcombat-rpop-wep-section-hd"><i class="fa-solid fa-ban"></i> Immune</div>`;
        for (const imm of iwr.immunities) {
          h += `<div class="shipcombat-rpop-wep-entry"><span class="shipcombat-rpop-wep-name">${_esc(String(imm))}</span></div>`;
        }
        h += `</div>`;
      }

      if (iwr.weaknesses.length) {
        h += `<div class="shipcombat-rpop-wep-section">`;
        h += `<div class="shipcombat-rpop-wep-section-hd"><i class="fa-solid fa-arrow-up"></i> Weakness</div>`;
        for (const w of iwr.weaknesses) {
          h += `<div class="shipcombat-rpop-wep-entry">`;
          h += `<span class="shipcombat-rpop-wep-name">${_esc(String(w.type))}</span>`;
          h += `<span class="shipcombat-rpop-wep-count">+${w.value}</span>`;
          h += `</div>`;
        }
        h += `</div>`;
      }

      if (iwr.resistances.length) {
        h += `<div class="shipcombat-rpop-wep-section">`;
        h += `<div class="shipcombat-rpop-wep-section-hd"><i class="fa-solid fa-arrow-down"></i> Resistance</div>`;
        for (const r of iwr.resistances) {
          h += `<div class="shipcombat-rpop-wep-entry">`;
          h += `<span class="shipcombat-rpop-wep-name">${_esc(String(r.type))}</span>`;
          h += `<span class="shipcombat-rpop-wep-count">${r.value}</span>`;
          h += `</div>`;
        }
        h += `</div>`;
      }

      h += `</div></details>`;
    }
  }

  h += `</div>`;
  return h;
}

// ── Own-ship popup (global non-targeted actions) ──────────────────────────

let _ownShipPopupEl = null;

function _showOwnShipPopup(canvasEl) {
  _dismissOwnShipPopup();

  const wrap = canvasEl.parentElement;
  if (!wrap) return;
  const ctx = _activeSensorsCtx ?? {};
  const side = canvasEl.width;
  const half = side / 2;

  const popup = document.createElement("div");
  popup.className = "shipcombat-radar-popup shipcombat-radar-own-popup";
  popup.style.left  = `${Math.max(8, half - 110)}px`;
  popup.style.width = "220px";
  popup.style.top   = `${half + 16}px`;

  popup.innerHTML = _buildOwnShipPopupHTML(ctx);
  wrap.style.position = "relative";
  wrap.appendChild(popup);
  _ownShipPopupEl = popup;

  popup.querySelector("[data-dismiss-popup]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    _dismissOwnShipPopup();
  });

  popup.querySelectorAll("[data-radar-action]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      const sheet = _activeSheet;
      if (!sheet) return;
      const handler = SENSORS_ACTIONS[btn.dataset.action];
      if (handler) {
        handler.call(sheet, ev, btn);
        setTimeout(() => {
          _dismissOwnShipPopup();
          _showOwnShipPopup(canvasEl);
        }, 300);
      }
    });
  });
}

function _dismissOwnShipPopup() {
  if (_ownShipPopupEl) {
    _ownShipPopupEl.remove();
    _ownShipPopupEl = null;
  }
}

function _buildOwnShipPopupHTML(ctx) {
  const TOOLBAR_DEFS = [
    { id: "lockHarmonics",  action: "sensorAction",     icon: "fa-solid fa-link",             label: "Lock Harmonics" },
    { id: "rangeAmplifier", action: "sensorAction",     icon: "fa-solid fa-tower-broadcast",  label: "Range Amplifier" },
    { id: "combatTelemetry", action: "sensorCoreAction", icon: "fa-solid fa-bullseye",         label: "Combat Telemetry" },
  ];

  const utilityActions = ctx.utilityActions ?? [];
  const coreActions    = ctx.coreActions ?? [];
  const hasCoreAssigned = ctx.hasCoreAssigned ?? false;
  const shipName = _activeSheet?.actor?.name ?? "Your Ship";

  let h = `<div class="shipcombat-rpop-header">`;
  h += `<span class="shipcombat-rpop-name" style="color:#7ec8e3">${_esc(shipName)}</span>`;
  h += `<button class="shipcombat-rpop-close" data-dismiss-popup><i class="fa-solid fa-xmark"></i></button>`;
  h += `</div>`;
  h += `<div class="shipcombat-rpop-lock" style="color:#7ec8e3">Global Actions</div>`;
  h += `<div class="shipcombat-rpop-divider"></div>`;

  for (const def of TOOLBAR_DEFS) {
    const entry = def.action === "sensorCoreAction"
      ? coreActions.find(a => a.id === def.id)
      : utilityActions.find(a => a.id === def.id);
    if (!entry) continue;
    const dis = entry.canAfford ? "" : "disabled";
    const tip = !hasCoreAssigned && def.action === "sensorCoreAction"
      ? "Requires assigned Power Core"
      : _esc(entry.descLocalized ?? '');
    h += `<button class="shipcombat-rpop-btn${def.id === "combatTelemetry" ? " shipcombat-rpop-btn--core" : ""}" `;
    h += `data-action="${def.action}" data-action-id="${def.id}" `;
    h += `data-radar-action title="${tip}" ${dis}>`;
    h += `<i class="${def.icon}"></i> ${_esc(entry.labelLocalized)}`;
    h += `<span class="shipcombat-rpop-cost">${entry.cost ?? entry.ap ?? 0}</span></button>`;
  }

  return h;
}

// ── Click handler ─────────────────────────────────────────────────────────

function _wireClick(el) {
  if (el._sensorClickBound) return;
  el.addEventListener("click", _onClick);
  el._sensorClickBound = true;
}

function _onClick(ev) {
  const canvasEl = ev.currentTarget;
  const rect = canvasEl.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;

  // Own-ship center click (within 10px of radar center)
  const half = canvasEl.width / 2;
  const ownDist = Math.sqrt((mx - half) ** 2 + (my - half) ** 2);
  if (ownDist <= 10) {
    _selectedTokenId = null;
    _dismissPopup();
    if (_ownShipPopupEl) {
      _dismissOwnShipPopup();
    } else {
      _showOwnShipPopup(canvasEl);
    }
    SensorRadar.repaint();
    return;
  }

  _dismissOwnShipPopup();

  let closest = null;
  let closestDist = Infinity;
  for (const b of _blips) {
    const d = Math.sqrt((b.canvasX - mx) ** 2 + (b.canvasY - my) ** 2);
    if (d < closestDist) { closestDist = d; closest = b; }
  }

  if (closest && closestDist <= 24) {
    if (closest.tokenId === _selectedTokenId) {
      _selectedTokenId = null;
      _dismissPopup();
    } else {
      _selectedTokenId = closest.tokenId;
      _showPopup(closest, canvasEl);
    }
  } else {
    _selectedTokenId = null;
    _dismissPopup();
  }

  SensorRadar.repaint();
}

// ── Foundry hooks (canvas-level updates) ──────────────────────────────────

function _registerHooks() {
  if (_hooksRegistered) return;
  _hooksRegistered = true;
  Hooks.on("updateToken",  _scheduleRepaint);
  Hooks.on("createToken",  _scheduleRepaint);
  Hooks.on("deleteToken",  _scheduleRepaint);
  Hooks.on("refreshToken", _scheduleRepaint);
}

function _scheduleRepaint() {
  // The continuous sweep loop handles repainting every frame.
  // Hook-triggered repaints are automatically covered.
}

// ── Animated sweep loop ───────────────────────────────────────────────────

function _startSweepLoop(el, sheet) {
  // Cancel any previous loop (e.g. from a re-render)
  if (_animFrameId) cancelAnimationFrame(_animFrameId);
  _lastFrameTime = performance.now();

  function _loop(now) {
    if (!_activeSheet) { _animFrameId = null; return; }

    // If the canvas was replaced by a re-render, find the new one
    let canvas = el;
    if (!canvas.isConnected) {
      const _loopRoot = _activeSheet.element?.querySelector ? _activeSheet.element : _activeSheet.element?.[0];
      canvas = _loopRoot?.querySelector?.("canvas[data-sensor-radar]");
      if (!canvas) { _animFrameId = requestAnimationFrame(_loop); return; }
      el = canvas;           // update closure reference
      _wireClick(canvas);    // re-bind click on new element
    }

    const dt = (now - _lastFrameTime) / 1000;
    _lastFrameTime = now;
    _sweepAngle = (_sweepAngle + SWEEP_SPEED * dt) % (Math.PI * 2);

    _paint(canvas, _activeSheet);

    // Also paint the pop-out canvas if it exists
    if (_popOutCanvas && _popOutCanvas.isConnected) {
      _paint(_popOutCanvas, _activeSheet);
    }

    _animFrameId = requestAnimationFrame(_loop);
  }

  _animFrameId = requestAnimationFrame(_loop);
}

// ── Contact naming ────────────────────────────────────────────────────────

/**
 * Return the display name for a blip based on lock tier and module setting.
 *   Tier 0-1 (Contact/Ping): designation only (no real name)
 *   Tier 2: same designation (Breach Analysis reveals shields, not name)
 *   Tier 3+: real ship name
 */
function _contactName(tokenId, lockTier, candidates) {
  if (lockTier >= 3) {
    // Deep Scan  -  show actual name
    const tok = candidates.find(c => c.id === tokenId);
    return tok?.document?.name ?? "?";
  }

  // Assign a stable index based on sorted token IDs
  const sortedIds = candidates.map(c => c.id).filter(Boolean).sort();
  const idx = sortedIds.indexOf(tokenId);

  let mode;
  try { mode = game.settings.get(MODULE_ID, "contactDesignation"); }
  catch { mode = "naval-greek"; }

  const useGreek = mode.includes("greek") || mode === "naval-greek";
  const suffix   = useGreek
    ? (GREEK[idx % GREEK.length] ?? String(idx + 1))
    : String(idx + 1);

  if (mode.startsWith("naval")) {
    // Naval mode: Bogey (tier 0), Bandit (tier 1+)
    return lockTier >= 1 ? `Bandit-${suffix}` : `Bogey-${suffix}`;
  }
  return `Contact-${suffix}`;
}

// ── Sweep gate detection ──────────────────────────────────────────────────

/** True if blipNorm lies in the arc the sweep arm covered this frame. */
function _wasSwept(prevNorm, currNorm, blipNorm) {
  if (currNorm >= prevNorm) {
    return blipNorm >= prevNorm && blipNorm <= currNorm;
  }
  // Wrapped past 2π
  return blipNorm >= prevNorm || blipNorm <= currNorm;
}

// ── Drawing helpers ───────────────────────────────────────────────────────

function _drawRing(ctx, cx, cy, r, colour, lineWidth = 1) {
  ctx.strokeStyle = colour;
  ctx.lineWidth   = lineWidth;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function _drawRingLabel(ctx, half, r, text, colour) {
  ctx.fillStyle = colour;
  ctx.font      = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(text, half + 4, half - r + 11);
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _esc(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

function _capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Parse a CSS hex colour (#rrggbb) into [r, g, b]. */
function _hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linearly interpolate between two hex colours. t=0 → colA, t=1 → colB. */
function _lerpColour(colA, colB, t) {
  const a = _hexToRgb(colA);
  const b = _hexToRgb(colB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

/** Collapse or expand the Sensor Radar section on the main sheet. */
function _collapseRadarSection(sheet, collapsed) {
  const _colRoot = sheet?.element?.querySelector ? sheet.element : sheet?.element?.[0];
  const section = _colRoot?.querySelector?.(".shipcombat-radar-section");
  if (!section) return;
  const content = section.querySelector(".list-content");
  if (!content) return;
  if (collapsed) {
    content.style.display = "none";
    section.classList.add("shipcombat-radar-collapsed");
  } else {
    content.style.display = "";
    section.classList.remove("shipcombat-radar-collapsed");
  }
}

// ── Pop-out Radar Window ──────────────────────────────────────────────────

class SensorPopOut extends Application {
  constructor(sheet) {
    super({});
    this._sheet = sheet;
  }

  async getData(options = {}) {
    return {};
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "shipcombat-sensor-popout",
      title:     game.i18n.localize("SHIPCOMBAT.Sensors.SensorRadar"),
      template:  `modules/${CORE_MODULE_ID}/templates/actor/partials/sensors-radar-popout.hbs`,
      width:     620,
      height:    660,
      resizable: true,
      classes:   ["shipcombat-popout-radar"],
    });
  }

  /** Enforce square *content area* on resize, compensating for the window header. */
  setPosition(pos = {}) {
    if (pos.width != null || pos.height != null) {
      const el = this.element?.[0];
      // Measure the header height (Foundry Application V1 header bar)
      const header = el?.querySelector?.(".window-header");
      const headerH = header ? header.offsetHeight : 30;
      // Measure the bottom toolbar
      const toolbar = el?.querySelector?.(".shipcombat-popout-toolbar-bottom");
      const toolbarH = toolbar ? toolbar.offsetHeight : 24;
      const chrome = headerH + toolbarH;

      const prev = el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 620, h: 660 };
      let w = pos.width ?? prev.w;
      let h = pos.height ?? prev.h;
      // Determine which dimension the user dragged
      const dw = Math.abs(w - prev.w);
      const dh = Math.abs(h - prev.h);
      if (dw >= dh) {
        // Width changed  -  set height = width + chrome
        pos.width  = w;
        pos.height = w + chrome;
      } else {
        // Height changed  -  set width = height - chrome
        pos.width  = Math.max(200, h - chrome);
        pos.height = h;
      }
    }
    return super.setPosition(pos);
  }

  activateListeners(html) {
    super.activateListeners(html);
    const canvas = html.find("canvas[data-sensor-radar-popout]")[0];
    if (canvas) {
      _popOutCanvas = canvas;
      _wireClick(canvas);

      // Scroll-wheel zoom on the pop-out canvas
      canvas.addEventListener("wheel", ev => {
        ev.preventDefault();
        const maxR = _activeSensorsCtx?.maxScanRange || 30;
        const step = ev.deltaY < 0 ? -1 : 1;
        const cur = _radarScale || maxR;
        SensorRadar.radarScale = Math.max(5, Math.min(cur + step, maxR));
        this._syncZoomUI();
      }, { passive: false });
    }

    // Initialize slider max and current values
    const maxR = _activeSensorsCtx?.maxScanRange || 30;
    const slider = html.find(".shipcombat-popout-zoom")[0];
    if (slider) {
      slider.max = maxR;
      slider.value = _radarScale || maxR;
      slider.addEventListener("input", ev => {
        const val = Math.max(5, Number(ev.target.value) || 5);
        SensorRadar.radarScale = val;
        this._syncZoomUI();
      });
    }
    const label = html.find(".shipcombat-popout-zoom-label")[0];
    if (label) label.textContent = String(_radarScale || maxR);

    // Bearing toggle label
    const bearingLabel = html.find(".shipcombat-popout-bearing-label")[0];
    const bearingBtn   = html.find(".shipcombat-popout-bearing-btn")[0];
    if (bearingLabel) bearingLabel.textContent = _trueBearing ? "TRUE" : "REL";
    if (bearingBtn && _trueBearing) bearingBtn.classList.add("active");

    // Bearing toggle action
    html.find("[data-popout-action='toggleBearing']").on("click", () => {
      SensorRadar.toggleBearing();
      const lbl = html.find(".shipcombat-popout-bearing-label")[0];
      const btn = html.find(".shipcombat-popout-bearing-btn")[0];
      if (lbl) lbl.textContent = _trueBearing ? "TRUE" : "REL";
      if (btn) btn.classList.toggle("active", _trueBearing);
      // Also sync the main sheet's bearing button if open
      if (_activeSheet?.element) {
        _activeSheet.render();
      }
    });

    this._html = html;
  }

  /** Sync the zoom slider/label to current _radarScale. */
  _syncZoomUI() {
    if (!this._html) return;
    const slider = this._html.find(".shipcombat-popout-zoom")[0];
    const label  = this._html.find(".shipcombat-popout-zoom-label")[0];
    if (slider) slider.value = _radarScale;
    if (label) label.textContent = String(_radarScale);
  }

  close(options) {
    _popOutCanvas = null;
    _popOutWindow = null;
    // Expand the radar section on the main sheet
    _collapseRadarSection(this._sheet, false);
    return super.close(options);
  }
}
