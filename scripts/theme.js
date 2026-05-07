/**
 * theme.js  –  Single source of truth for every colour used in the Ship Combat module.
 *
 * All colours are stored as RGBA component arrays [r, g, b, a] (0-255 for rgb, 0-1 for a).
 * Helper functions convert these to any format needed: CSS rgba(), hex, PIXI 0xRRGGBB, etc.
 *
 * USAGE:
 *   import { THEME, cssRgba, pixi, hex } from "./theme.js";
 *   el.style.color = cssRgba(THEME.roles.captain);          // "rgba(201,162,39,1)"
 *   const col      = pixi(THEME.weaponTypes.macroCannon);   // 0xff4444
 *   const hexStr   = hex(THEME.roles.engineer);             // "#c0392b"
 */

// ── Format helpers ────────────────────────────────────────────────────────────

/** [r,g,b,a] → "rgba(r,g,b,a)" */
export function cssRgba([r, g, b, a = 1]) {
  return `rgba(${r},${g},${b},${a})`;
}

/** [r,g,b,a?] → 0xRRGGBB  (alpha ignored, for PIXI) */
export function pixi([r, g, b]) {
  return (r << 16) | (g << 8) | b;
}

/** [r,g,b,a?] → "#rrggbb" */
export function hex([r, g, b]) {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Derive a new colour from an existing one with a different alpha. */
export function withAlpha([r, g, b], a) {
  return [r, g, b, a];
}

// ── Heat-gradient interpolation ───────────────────────────────────────────────

const _HEAT_STOPS = [
  [0,   0x27, 0xae, 0x60],   // green
  [20,  0x90, 0xc9, 0x3c],   // lime
  [55,  0xf3, 0x9c, 0x12],   // orange
  [100, 0xc0, 0x39, 0x2b],   // red
];

/**
 * Interpolate the heat gradient for a 0–100 percentage.
 * Returns a CSS  `rgb(r,g,b)` string.
 */
export function heatColor(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (let i = 0; i < _HEAT_STOPS.length - 1; i++) {
    const [p0, r0, g0, b0] = _HEAT_STOPS[i];
    const [p1, r1, g1, b1] = _HEAT_STOPS[i + 1];
    if (p <= p1) {
      const t = (p - p0) / (p1 - p0);
      return `rgb(${Math.round(r0 + t*(r1-r0))},${Math.round(g0 + t*(g1-g0))},${Math.round(b0 + t*(b1-b0))})`;
    }
  }
  const last = _HEAT_STOPS[_HEAT_STOPS.length - 1];
  return `rgb(${last[1]},${last[2]},${last[3]})`;
}

// ── Master palette ────────────────────────────────────────────────────────────

export const THEME = Object.freeze({

  // ── Bridge-role accent colours ──────────────────────────────────────────
  roles: {
    captain:   [201, 162,  39, 1],   // #c9a227  – gold
    engineer: [192,  57,  43, 1],   // #c0392b  – dark red
    pilot:     [ 41, 128, 185, 1],   // #2980b9  – blue
    sensors:   [ 39, 174,  96, 1],   // #27ae60  – green
    gunner:    [231,  76,  60, 1],   // #e74c3c  – bright red
    ordnance:  [  0, 255, 136, 1],   // #00ff88  – IM bright green
  },

  // ── Weapon-type colours (PIXI overlays & CSS) ──────────────────────────
  weaponTypes: {
    ammo:   [230, 126,  34, 1],  // #e67e22 – orange  (ready rounds / macro cannons)
    heat:   [231,  76,  60, 1],  // #e74c3c – red     (plasma weapons / heat)
    power:  [ 41, 128, 185, 1],  // #2980b9 – blue    (lance batteries / aux power)
    none:   [255, 170,  68, 1],  // #ffaa44 – amber   (generic / no resource)
  },

  // ── Targeting / Zone colours ────────────────────────────────────────────
  zones: {
    zone1: [ 68, 255, 136, 1],  // #44ff88 – auto-scan / lock-on
    zone2: [241, 196,  15, 1],  // #f1c40f – effective range
    zone3: [231,  76,  60, 1],  // #e74c3c – extended range
  },

  // ── Shield / helm overlay ──────────────────────────────────────────────
  overlay: {
    shieldGreen:  [  0, 255, 136, 1],  // 0x00ff88
    shieldBlue:   [ 68, 170, 255, 1],  // 0x44aaff
    helmGhost:    [  0, 255, 136, 1],  // 0x00ff88
    attackVector: [255,  68,  68, 1],  // 0xff4444
    helmRam:      [255,  48,  48, 1],  // 0xff3030 – ram-course preview (red)
  },

  // ── Weapon-trait tag borders & text ─────────────────────────────────────
  traits: {
    shieldBypass:      [126, 200, 227, 1],  // #7ec8e3
    unlimitedRof:      [241, 196,  15, 1],  // #f1c40f
    shieldBurn:        [231,  76,  60, 1],  // #e74c3c
    rend:              [230, 126,  34, 1],  // #e67e22
    armourPenetration: [ 26, 188, 156, 1],  // #1abc9c
    devastating:       [255, 215,   0, 1],  // #ffd700
    unreliable:        [149, 165, 166, 1],  // #95a5a6
    overcharge:        [255, 102,  68, 1],  // #ff6644
  },

  // ── UI accent colours (resource bars, pips, badges) ────────────────────
  ui: {
    corePip:       [126, 200, 227, 1],  // #7ec8e3  – sky-blue data/core pips
    stagedCore:    [230, 126,  34, 1],  // #e67e22  – orange staged cores
    assignedCore:  [224,  64,  64, 1],  // #e04040  – red assigned cores
    shieldCore:    [  0, 255, 136, 1],  // #00ff88  – green shield cores
    powerAvail:    [ 39, 174,  96, 1],  // #27ae60  – power-bar available
    powerCommit:   [192,  57,  43, 1],  // #c0392b  – power-bar committed
    bearingSlider: [243, 156,  18, 1],  // #f39c12  – amber bearing slider
    macroCost:     [232, 163,  58, 1],  // #e8a33a  – gold macro tier accent
    plasmaDmg:     [255, 102,  68, 1],  // #ff6644  – plasma damage/heat
    plasmaRemain:  [255, 136, 102, 1],  // #ff8866  – plasma remaining
    lanceCharge:   [ 68, 255, 136, 1],  // #44ff88  – lance charge/damage
    scanPipActive: [ 74, 255, 232, 1],  // #4affe8  – active scan pips
    fireResult:    [231,  76,  60, 1],  // #e74c3c  – fire failure outcome
    shieldCompass: [155,  89, 182, 1],  // #9b59b6  – shield compass purple
    warning:       [243, 156,  18, 1],  // #f39c12  – misconfigured warning
    textLight:     [221, 221, 221, 1],  // #ddd     – targeting popup text
  },

  // ── Base palette ────────────────────────────────────────────────────────
  base: {
    white:  [255, 255, 255, 1],
    black:  [  0,   0,   0, 1],
    bg1:    [ 26,  26,  26, 1],  // #1a1a1a
    bg2:    [ 38,  38,  38, 1],  // #262626
    bg3:    [ 51,  51,  51, 1],  // #333
    bgRole: [ 21,  62,  65, 1],  // rgb(21,62,65)
    bgPopup:[ 18,  42,  44, 1],  // rgb(18,42,44)
  },
});
