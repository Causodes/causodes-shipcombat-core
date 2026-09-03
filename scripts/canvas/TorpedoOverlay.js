/**
 * TorpedoOverlay  -  adapts a blast radius to WeaponArcOverlay.
 * Shown on hover over the Detonate button; hidden on mouse leave.
 */

import { WeaponArcOverlay } from "./WeaponArcOverlay.js";

export class TorpedoOverlay {

  static _overlayId = null;

  /**
   * Show a circular overlay centred on a token.
   * @param {Token} token  – the torpedo token
   * @param {number} radiusVU – blast radius in VU (grid squares)
   */
  static show(token, radiusVU) {
    this.hide();
    if (!canvas?.ready || !token) return;
    this._overlayId = `torpedo-blast-${token.id}`;
    WeaponArcOverlay.showStandalone(this._overlayId, token, {
      range:          radiusVU,
      degreeOfFire:   360,
      weaponPosition: "prow",
      resource:       "none",
      overlayColor:   0xff4400,
    }, {
      autoScanRange: radiusVU,
      bandSize:      0,
      rating:        0,
    });
  }

  /** Remove the overlay. */
  static hide() {
    if (this._overlayId) WeaponArcOverlay.hideStandalone(this._overlayId);
    this._overlayId = null;
  }
}
