/**
 * TorpedoOverlay  -  draws a circular blast radius overlay on the canvas.
 * Shown on hover over the Detonate button; hidden on mouse leave.
 */

const SEGS = 32;

export class TorpedoOverlay {

  static _container = null;

  /**
   * Show a circular overlay centred on a token.
   * @param {Token} token  – the torpedo token
   * @param {number} radiusVU – blast radius in VU (grid squares)
   */
  static show(token, radiusVU) {
    this.hide();
    if (!canvas?.ready || !token) return;

    const gs = canvas.grid.size;
    const cx = token.x + (token.document.width * gs) / 2;
    const cy = token.y + (token.document.height * gs) / 2;
    const radiusPx = radiusVU * gs;

    const container = new PIXI.Container();
    container.name = "shipcombat-torpedo-blast";
    container.eventMode = "none";
    canvas.tokens.addChild(container);

    const g = new PIXI.Graphics();
    container.addChild(g);

    // Outer blast zone (25% damage)
    g.beginFill(0xff4400, 0.08);
    g.lineStyle(2, 0xff4400, 0.5);
    g.drawCircle(cx, cy, radiusPx);
    g.endFill();

    // Inner core (100% damage)  -  25% of radius
    const corePx = radiusPx * 0.25;
    g.beginFill(0xff4400, 0.25);
    g.lineStyle(1.5, 0xff6600, 0.7);
    g.drawCircle(cx, cy, corePx);
    g.endFill();

    // Mid ring (50% damage)  -  50% of radius
    const midPx = radiusPx * 0.5;
    g.lineStyle(1, 0xff5500, 0.3);
    g.drawCircle(cx, cy, midPx);

    // Crosshair
    const chLen = Math.min(radiusPx * 0.15, 20);
    g.lineStyle(1.5, 0xff4400, 0.6);
    g.moveTo(cx - chLen, cy); g.lineTo(cx + chLen, cy);
    g.moveTo(cx, cy - chLen); g.lineTo(cx, cy + chLen);

    this._container = container;
  }

  /** Remove the overlay. */
  static hide() {
    if (this._container && !this._container.destroyed) {
      this._container.destroy({ children: true });
    }
    this._container = null;
  }
}
