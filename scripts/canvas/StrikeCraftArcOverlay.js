/**
 * StrikeCraftArcOverlay  -  adapts strike-craft weapons to WeaponArcOverlay.
 *
 * Shown when the "Attack" button is hovered in the strike craft sheet.
 *
 * The actor's attack range, angle, and sensors are presented as a synthetic
 * weapon descriptor so player ships, NPC ships, and strike craft share one
 * drawing and refresh flow.
 */

import { THEME, pixi } from "../theme.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { WeaponArcOverlay } from "./WeaponArcOverlay.js";

export class StrikeCraftArcOverlay {

  static _overlayId = null;

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
    const sys = SystemAdapter.current.getShipData(actor);
    this._overlayId = `strike-craft-${actor.id}`;
    WeaponArcOverlay.showStandalone(this._overlayId, tokens[0], {
      range:          sys.autoScanRange ?? 0,
      degreeOfFire:   sys.payloadAngle ?? 120,
      weaponPosition: "prow",
      resource:       "none",
      overlayColor:   pixi(THEME.roles.ordnance),
    }, {
      autoScanRange: sys.autoScanRange ?? 0,
      bandSize:      sys.sensorBandSize ?? 0,
      rating:        sys.sensorRating ?? 0,
    });
  }

  /** Remove the overlay from the canvas. */
  static hide() {
    if (this._overlayId) WeaponArcOverlay.hideStandalone(this._overlayId);
    this._overlayId = null;
  }

  /** Alias for hide()  -  called from the canvasTearDown hook. */
  static destroyAll() {
    this.hide();
  }
}
