/**
 * WeaponArcOverlay – draws firing-arc cones on the canvas for weapon
 * components on the Ordnance Master (gunner) tab.
 *
 * Three concentric zones:
 *   1. Auto-scan range  (0 → ghRange)       – brightest fill
 *   2. Effective range (ghRange → range)    – medium fill
 *   3. Maximum range   (range → 2×range)   – dim fill
 */

import { MODULE_ID } from "../constants.js";
import { THEME, pixi } from "../theme.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

// ── Colour palette ───────────────────────────────────────────────────────────

const COLOURS = {
  ammo:   pixi(THEME.weaponTypes.ammo),
  heat:   pixi(THEME.weaponTypes.heat),
  power:  pixi(THEME.weaponTypes.power),
  none:   pixi(THEME.weaponTypes.none),
};

const DIR_OFFSET = {
  prow:       0,
  dorsal:     0,
  port:      -Math.PI / 2,
  starboard:  Math.PI / 2,
  stern:      Math.PI,
};

const SEGS = 32;

// ── Overlay ──────────────────────────────────────────────────────────────────

export class WeaponArcOverlay {

  /** The actor whose items we draw arcs for. Set by activate(). */
  static _actor = null;

  /** Per-item PIXI state: Map<itemId, { container, graphics }> */
  static _entries = new Map();

  /** Pinned item IDs (survive hover toggle). */
  static _pinned = new Set();

  /** Currently hovered item ID, or null. */
  static _hovered = null;

  /** Whether the gunner tab is currently showing. */
  static _active = false;

  // ── Public API (called from ShipSheet) ──────────────────────────────────

  /**
   * Turn arcs on  -  called when the gunner tab becomes active.
   * @param {Actor} actor  The sheet's own actor (this.actor)
   */
  static activate(actor) {
    this._actor = actor;
    this._active = true;
    this._draw();
  }

  /** Turn arcs off  -  called when leaving the gunner tab.  */
  static deactivate() {
    this._active = false;
    this._clearAll();
  }

  /** Show arc on hover. */
  static showHover(itemId) {
    this._hovered = itemId;
    this._draw();
  }

  /** Hide hovered arc. */
  static hideHover() {
    this._hovered = null;
    this._draw();
  }

  /** Toggle pin. Returns new pinned state. */
  static togglePin(itemId) {
    if (this._pinned.has(itemId)) this._pinned.delete(itemId);
    else this._pinned.add(itemId);
    this._draw();
    return this._pinned.has(itemId);
  }

  /** Query pin state. */
  static isPinned(itemId) {
    return this._pinned.has(itemId);
  }

  /** Full teardown  -  canvas destroyed or module unloaded. */
  static destroyAll() {
    this._clearAll();
    this._pinned.clear();
    this._hovered = null;
    this._actor = null;
    this._active = false;
  }

  /**
   * Called from the refreshToken hook  -  redraws if the moved token
   * belongs to our tracked actor.
   */
  static onRefreshToken(token) {
    if (!this._active || !this._actor) return;
    if (this._pinned.size === 0 && !this._hovered) return;
    if (token.document.actor?.id !== this._actor.id) return;
    this._draw();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  static _clearAll() {
    for (const [id] of this._entries) this._destroy(id);
  }

  static _destroy(id) {
    const e = this._entries.get(id);
    if (e?.container && !e.container.destroyed) e.container.destroy({ children: true });
    this._entries.delete(id);
  }

  /** Determine which item IDs should be visible right now. */
  static _wanted() {
    const ids = new Set(this._pinned);
    if (this._hovered) ids.add(this._hovered);
    return ids;
  }

  /** Main render pass. */
  static _draw() {
    if (!canvas?.ready || !canvas?.tokens) return;
    if (!this._active || !this._actor) { this._clearAll(); return; }

    // Find our actor's token on the current scene
    const tokens = this._actor.getActiveTokens?.() ?? [];
    if (!tokens.length) { this._clearAll(); return; }
    const tok = tokens[0];

    const gs = canvas.grid.size;
    const cx = tok.x + (tok.document.width  * gs) / 2;
    const cy = tok.y + (tok.document.height * gs) / 2;
    const h0 = (tok.document.rotation + 90) * (Math.PI / 180);

    // Look up sensor stats (component items for player ships, flat fields for NPC ships)
    const sensorComp = this._actor.items.find(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "sensor"
    );
    const actorSys = SystemAdapter.current.getShipData(this._actor) ?? {};
    const bandExpanded = !!(actorSys.resources?.gunner?.sensorBandExpanded);
    const rawBandSize  = Math.max(0, Number(sensorComp?.system?.bandSize) || Number(actorSys.sensorBandSize) || 0);
    const sensor = {
      rating:        Math.max(0, Number(sensorComp?.system?.rating) || Number(actorSys.sensorRating) || 0),
      bandSize:      bandExpanded ? rawBandSize * 2 : rawBandSize,
      autoScanRange: Math.max(0, Number(sensorComp?.system?.autoScanRange) || Number(actorSys.autoScanRange) || 0),
    };

    const wanted = this._wanted();

    // Remove stale
    for (const [id] of this._entries) {
      if (!wanted.has(id)) this._destroy(id);
    }

    // Draw each
    for (const id of wanted) {
      const item = this._actor.items.get(id);
      if (!item) { this._destroy(id); continue; }
      this._drawOne(item, cx, cy, h0, gs, sensor);
    }
  }

  /** Draw (or redraw) a single weapon arc with guaranteed, effective, and per-band extended zones. */
  static _drawOne(item, cx, cy, h0, gs, sensor) {
    const s = item.system;
    const range = Number(s.range) || 0;
    const dof   = Number(s.degreeOfFire) || 0;
    if (range <= 0 || dof <= 0) return;

    const pos     = s.weaponPosition ?? "prow";
    const bay     = s.weaponBay ?? "port";
    const sideKey = pos === "flank" ? bay : pos;
    const centre  = h0 + (DIR_OFFSET[sideKey] ?? 0);
    const half    = (dof / 2) * (Math.PI / 180);
    const a0      = centre - half;
    const a1      = centre + half;

    const ghRange    = Math.min(sensor.autoScanRange, range);
    const rGH        = ghRange * gs;
    const rEff       = range * gs;
    const col        = COLOURS[s.resource] ?? 0xffffff;

    // Calculate how many extended bands the sensor can reach beyond weapon range.
    // Delegated to the system adapter so each ruleset can apply its own cap
    // (e.g. WH40K: rating / step; SF2e: fixed 20).
    const bandSize   = sensor.bandSize;
    const maxBands   = (bandSize > 0 && sensor.rating > 0)
      ? SystemAdapter.current.getMaxDecayBands(sensor.rating)
      : 0;

    // Get-or-create PIXI objects
    let entry = this._entries.get(item.id);
    if (!entry || entry.container.destroyed) {
      const container = new PIXI.Container();
      container.name = `shipcombat-warc-${item.id}`;
      container.eventMode = "none";
      canvas.tokens.addChild(container);
      const graphics = new PIXI.Graphics();
      container.addChild(graphics);
      entry = { container, graphics };
      this._entries.set(item.id, entry);
    }

    const g = entry.graphics;
    g.clear();

    // Zone 1: Auto-scan range (innermost, brightest)
    if (rGH > 0) {
      g.beginFill(col, 0.35);
      g.lineStyle(1.5, col, 0.7);
      g.drawPolygon(fan(cx, cy, 0, rGH, a0, a1));
      g.endFill();
    }

    // Zone 2: Effective range
    if (rEff > rGH) {
      g.beginFill(col, 0.18);
      g.lineStyle(1.5, col, 0.5);
      g.drawPolygon(rGH > 0 ? band(cx, cy, rGH, rEff, a0, a1) : fan(cx, cy, 0, rEff, a0, a1));
      g.endFill();
    }

    // Zone 3: Extended range  -  individual bands with fading opacity
    if (maxBands > 0) {
      for (let b = 0; b < maxBands; b++) {
        const innerR = rEff + b * bandSize * gs;
        const outerR = rEff + (b + 1) * bandSize * gs;
        // Fade from 0.12 down to near-transparent over the bands
        const fillAlpha = 0.12 * (1 - b / maxBands);
        const lineAlpha = 0.35 * (1 - b / maxBands);
        g.beginFill(col, Math.max(fillAlpha, 0.02));
        g.lineStyle(1, col, Math.max(lineAlpha, 0.08));
        g.drawPolygon(band(cx, cy, innerR, outerR, a0, a1));
        g.endFill();
      }
    }

    // Full outline (effective + all extended bands)
    const totalMaxR = maxBands > 0 ? rEff + maxBands * bandSize * gs : rEff;
    g.lineStyle(1.5, col, 0.45);
    g.beginFill(0, 0);
    g.drawPolygon(fan(cx, cy, 0, totalMaxR, a0, a1));
    g.endFill();
    g.lineStyle(0);
  }
}

// ── Polygon helpers ──────────────────────────────────────────────────────────

/** Fan from centre to outerR. */
function fan(cx, cy, _innerR, outerR, a0, a1) {
  const pts = [cx, cy];
  for (let i = 0; i <= SEGS; i++) {
    const a = a0 + (a1 - a0) * (i / SEGS);
    pts.push(cx + outerR * Math.cos(a), cy + outerR * Math.sin(a));
  }
  pts.push(cx, cy);
  return pts;
}

/** Annular band between innerR and outerR. */
function band(cx, cy, innerR, outerR, a0, a1) {
  const pts = [];
  for (let i = 0; i <= SEGS; i++) {
    const a = a0 + (a1 - a0) * (i / SEGS);
    pts.push(cx + innerR * Math.cos(a), cy + innerR * Math.sin(a));
  }
  for (let i = SEGS; i >= 0; i--) {
    const a = a0 + (a1 - a0) * (i / SEGS);
    pts.push(cx + outerR * Math.cos(a), cy + outerR * Math.sin(a));
  }
  return pts;
}
