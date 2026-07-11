/**
 * StrikeCraftArcOverlay  -  draws the attack-arc cone for a strike craft token.
 *
 * Shown when the "Attack" button is hovered in the strike craft sheet.
 *
 * Three concentric zones (matching WeaponArcOverlay semantics):
 *   1. Auto-scan range  (0 → autoScanRange)          – brightest fill
 *   2. Effective range  (autoScanRange → payloadRadius) – medium fill
 *   3. Extended bands   (payloadRadius → max decay)   – fading fill per band
 *
 * Arc angle is read from sys.payloadAngle (default 120°), centred on the
 * token's forward heading.
 */

import { THEME, pixi } from "../theme.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const SEGS = 32;
const COL  = pixi(THEME.roles.ordnance);   // orange  -  ordnance role colour

export class StrikeCraftArcOverlay {

  static _container = null;

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Draw the overlay for the given actor's first active token.
   * @param {Actor} actor  The strike craft actor.
   */
  static show(actor) {
    this.hide();
    if (!canvas?.ready || !actor) return;

    const tokens = actor.getActiveTokens?.() ?? [];
    if (!tokens.length) return;
    const tok = tokens[0];

    const gs  = canvas.grid.size;
    const cx  = tok.x + (tok.document.width  * gs) / 2;
    const cy  = tok.y + (tok.document.height * gs) / 2;

    // Forward heading (same convention as WeaponArcOverlay "prow")
    const h0 = (tok.document.rotation + 90) * (Math.PI / 180);

    const sys      = SystemAdapter.current.getShipData(actor);
    const arcDeg   = sys.payloadAngle   ?? 120;
    const radius   = sys.payloadRadius  ?? 0;
    const autoScan = sys.autoScanRange  ?? 0;
    const band     = sys.sensorBandSize ?? 0;
    const rating   = sys.sensorRating   ?? 0;

    if (radius <= 0) return;   // nothing to draw

    const half = (arcDeg / 2) * (Math.PI / 180);
    const a0   = h0 - half;
    const a1   = h0 + half;

    const rGH  = Math.min(autoScan, radius) * gs;
    const rEff = radius * gs;
    const maxBands = (band > 0 && rating > 0) ? Math.floor(rating / 10) : 0;

    // ── Build PIXI objects ─────────────────────────────────────────────────
    const container = new PIXI.Container();
    container.name  = "shipcombat-sc-arc";
    container.eventMode = "none";
    canvas.tokens.addChild(container);

    const g = new PIXI.Graphics();
    container.addChild(g);

    // Zone 1: auto-scan range (innermost, brightest)
    if (rGH > 0) {
      g.beginFill(COL, 0.35);
      g.lineStyle(1.5, COL, 0.7);
      g.drawPolygon(_fan(cx, cy, 0, rGH, a0, a1));
      g.endFill();
    }

    // Zone 2: effective range
    if (rEff > rGH) {
      g.beginFill(COL, 0.18);
      g.lineStyle(1.5, COL, 0.5);
      g.drawPolygon(rGH > 0
        ? _band(cx, cy, rGH, rEff, a0, a1)
        : _fan(cx, cy, 0, rEff, a0, a1));
      g.endFill();
    }

    // Zone 3: extended decay bands (fading)
    for (let b = 0; b < maxBands; b++) {
      const innerR = rEff + b * band * gs;
      const outerR = rEff + (b + 1) * band * gs;
      const fillA  = Math.max(0.12 * (1 - b / maxBands), 0.02);
      const lineA  = Math.max(0.35 * (1 - b / maxBands), 0.08);
      g.beginFill(COL, fillA);
      g.lineStyle(1, COL, lineA);
      g.drawPolygon(_band(cx, cy, innerR, outerR, a0, a1));
      g.endFill();
    }

    // Outer outline
    const totalMaxR = maxBands > 0 ? rEff + maxBands * band * gs : rEff;
    g.lineStyle(1.5, COL, 0.45);
    g.beginFill(0, 0);
    g.drawPolygon(_fan(cx, cy, 0, totalMaxR, a0, a1));
    g.endFill();
    g.lineStyle(0);

    this._container = container;
  }

  /** Remove the overlay from the canvas. */
  static hide() {
    if (this._container && !this._container.destroyed) {
      this._container.destroy({ children: true });
    }
    this._container = null;
  }

  /** Alias for hide()  -  called from the canvasTearDown hook. */
  static destroyAll() {
    this.hide();
  }
}

// ── Polygon helpers ──────────────────────────────────────────────────────────

function _fan(cx, cy, _innerR, outerR, a0, a1) {
  const pts = [cx, cy];
  for (let i = 0; i <= SEGS; i++) {
    const a = a0 + (a1 - a0) * (i / SEGS);
    pts.push(cx + outerR * Math.cos(a), cy + outerR * Math.sin(a));
  }
  pts.push(cx, cy);
  return pts;
}

function _band(cx, cy, innerR, outerR, a0, a1) {
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
