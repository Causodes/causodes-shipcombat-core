import { MODULE_ID } from "../constants.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { THEME, pixi } from "../theme.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

/**
 * Returns true if the current user should see numeric shield labels on
 * the given ship's token overlay.
 *
 * Rules:
 *  – GMs always see labels.
 *  – Any player who owns the ship actor sees labels (it's their ship).
 *  – Any player assigned the "sensors" (Augur) role sees labels on all ships.
 *  – Everyone else only sees the arc shapes, not the numbers.
 */
function _canSeeShieldValues(ship) {
  if (game.user.isGM) return true;
  // Own ship: user has owner-level permission
  if (ship.testUserPermission(game.user, "OWNER")) return true;
  // Augur role on this ship
  const myRole = ShipCombatState.getRoleForUser(game.user.id);
  return myRole === "sensors";
}

/**
 * ShieldArcOverlay – draws four void-shield arc segments around the ship token
 * on the canvas, one per sector (bow / port / stern / starboard).
 *
 * Each segment is a filled ring band whose radial extent is proportional to
 * the sector's current shield value relative to the zone-threshold cap.
 * Colors: purple (full) → blue (mid) → amber (low) → dim background (zero).
 *
 * The overlay is rebuilt by refresh():
 *   – on canvasReady
 *   – on updateActor (ship type)
 *   – on updateToken  (ship token moved / rotated)
 * It is torn down by destroyAll() on canvasTearDown.
 *
 * Rotation convention: mirrors HelmPreview._tokenBasis exactly.
 *   h0 = (token.document.rotation − 90) × π/180
 *   → h0 = −π/2 when rotation = 0 (token faces north / up-screen)
 *   → bow   at h0 + 0
 *   → starboard at h0 + π/2
 *   → stern at h0 + π
 *   → port  at h0 − π/2
 */
export class ShieldArcOverlay {

  /** Map<tokenId, { container: PIXI.Container, graphics: PIXI.Graphics, texts: {...} }> */
  static _overlays = new Map();

  // ── Public API ────────────────────────────────────────────────────────────

  /** Rebuild overlays for every active ship token on the current canvas. */
  static refresh() {
    if (!canvas?.ready) return;

    const ship = ShipCombatState.ship;
    if (!ship) { this.destroyAll(); return; }

    // Own ship tokens
    const ownTokens = ship.getActiveTokens?.() ?? [];
    const activeIds = new Set(ownTokens.map(t => t.id));

    // Enemy ship tokens eligible for shield overlay (Lock >= 2)
    const enemyTokens = this._getLockedEnemyTokens(ship);
    for (const et of enemyTokens) activeIds.add(et.token.id);

    // Remove stale entries (token no longer on canvas or lock dropped)
    for (const [id] of this._overlays) {
      if (!activeIds.has(id)) this._destroyToken(id);
    }

    // Draw own ship overlays (always show full numeric labels)
    const zoneThresholds = ShipCombatState.getShieldStats().zoneThresholds;
    const showShields = _canSeeShieldValues(ship);
    for (const token of ownTokens) {
      this._drawForToken(token, SystemAdapter.current.getShipData(ship), zoneThresholds, showShields, 4);
    }

    // Draw enemy ship overlays (shields revealed at Lock 2+)
    for (const { token, actor, tier } of enemyTokens) {
      const enemySys = SystemAdapter.current.getShipData(actor) ?? {};
      const enemyZT  = this._getZoneThresholds(actor);
      this._drawForToken(token, enemySys, enemyZT, true, tier);
    }
  }

  /**
   * Get enemy ship tokens whose Augur lock tier >= 2.
   * @returns {{ token: Token, actor: Actor, tier: number }[]}
   */
  static _getLockedEnemyTokens(ship) {
    if (!canvas?.tokens) return [];
    const locks   = SystemAdapter.current.getShipData(ship)?.resources?.sensors?.locks ?? [];
    const sensor  = ShipCombatState.getSensorStats();
    const ghRange = sensor.autoScanRange ?? 0;

    const ownToken = ship.getActiveTokens?.()?.[0];
    if (!ownToken) return [];
    const gridSize = canvas.grid.size;
    const cx0 = ownToken.document.x + (ownToken.document.width  * gridSize) / 2;
    const cy0 = ownToken.document.y + (ownToken.document.height * gridSize) / 2;

    const result = [];
    for (const token of canvas.tokens.placeables) {
      const actorId = token.document.actor?.id;
      if (!actorId || actorId === ship.id) continue;
      const actor = token.document.actor;
      if (!SystemAdapter.current.getShipData(actor)?.shields) continue; // Only draw on actors that have shield data

      // Compute effective lock tier
      const explicitLock = locks.find(l => l.targetTokenId === token.id);
      const explicitTier = explicitLock?.tier ?? 0;
      const cW = token.document.width * gridSize;
      const cH = token.document.height * gridSize;
      const tx = token.document.x + cW / 2;
      const ty = token.document.y + cH / 2;
      const distSq = Math.sqrt((tx - cx0) ** 2 + (ty - cy0) ** 2) / gridSize;
      const autoTier = (ghRange > 0 && distSq <= ghRange) ? 2 : 0;
      const tier = Math.max(explicitTier, autoTier);

      if (tier >= 2) result.push({ token, actor, tier });
    }
    return result;
  }

  /**
   * Compute zone thresholds for an enemy ship from its shield component.
   */
  static _getZoneThresholds(actor) {
    const shieldComp = actor.items?.find?.(
      i => i.type === `${MODULE_ID}.component` && i.system?.slot === "shields"
    );
    if (!shieldComp) {
      // Fall back to default thresholds based on shield values
      const shields = SystemAdapter.current.getShipData(actor)?.shields ?? {};
      const fallbackZT = Math.max(
        shields.bow ?? 0, shields.stern ?? 0,
        shields.port ?? 0, shields.starboard ?? 0, 8
      );
      return { bow: fallbackZT, stern: fallbackZT, port: fallbackZT, starboard: fallbackZT };
    }
    const zt = shieldComp.system?.zoneThresholds ?? {};
    return {
      bow:       zt.bow ?? 8,
      stern:     zt.stern ?? 8,
      port:      zt.port ?? 8,
      starboard: zt.starboard ?? 8,
    };
  }

  /**
   * Redraw just one token's overlay using its live PIXI position.
   * Called from the refreshToken hook (fires every frame during animation/drag).
   * @param {Token} token – the PlaceableObject (not the document)
   */
  static _redrawToken(token) {
    if (!canvas?.ready) return;
    const ship = ShipCombatState.ship;
    if (!ship) return;

    const actorId = token.document.actor?.id;
    if (!actorId) return;

    if (actorId === ship.id) {
      // Own ship  -  always redraw with full labels
      const zoneThresholds = ShipCombatState.getShieldStats().zoneThresholds;
      const showShields = _canSeeShieldValues(ship);
      this._drawForToken(token, SystemAdapter.current.getShipData(ship), zoneThresholds, showShields, 4);
      // Update enemy overlay visibility using the live (dragged) own-ship position.
      this._updateEnemyOverlayVisibility(token);
    } else if (this._overlays.has(token.id)) {
      // Enemy token  -  only redraw if we have an existing overlay (Lock >= 2)
      const actor = token.document.actor;
      if (!SystemAdapter.current.getShipData(actor)?.shields) return;
      const enemyZT = this._getZoneThresholds(actor);
      // Compute effective lock tier for this specific enemy
      const locks   = SystemAdapter.current.getShipData(ship)?.resources?.sensors?.locks ?? [];
      const sensor  = ShipCombatState.getSensorStats();
      const ghRange = sensor.autoScanRange ?? 0;
      const ownToken = ship.getActiveTokens?.()?.[0];
      let tier = 2;
      if (ownToken) {
        const gridSize = canvas.grid.size;
        // Use live PIXI position (token.x) so this stays accurate during drag/animation.
        const cx0 = ownToken.x + (ownToken.document.width  * gridSize) / 2;
        const cy0 = ownToken.y + (ownToken.document.height * gridSize) / 2;
        const cW = token.document.width * gridSize;
        const tx = token.document.x + cW / 2;
        const ty = token.document.y + (token.document.height * gridSize) / 2;
        const dist = Math.sqrt((tx - cx0) ** 2 + (ty - cy0) ** 2) / gridSize;
        const explicitLock = locks.find(l => l.targetTokenId === token.id);
        const explicitTier = explicitLock?.tier ?? 0;
        const autoTier = (ghRange > 0 && dist <= ghRange) ? 2 : 0;
        tier = Math.max(explicitTier, autoTier);
      }
      if (tier < 2) {
        this._destroyToken(token.id);
        return;
      }
      this._drawForToken(token, SystemAdapter.current.getShipData(actor), enemyZT, true, tier);
    }
  }

  /**
   * Update the `container.visible` flag on every enemy overlay using the live
   * position of the own-ship token.  Called each frame from the own-ship branch
   * of `_redrawToken` so that autoscan visibility responds during drag/animation
   * without waiting for a committed `updateToken` event.
   * @param {Token} ownToken – the own ship's live PIXI token object
   */
  static _updateEnemyOverlayVisibility(ownToken) {
    const ship = ShipCombatState.ship;
    if (!ship) return;
    const locks   = SystemAdapter.current.getShipData(ship)?.resources?.sensors?.locks ?? [];
    const sensor  = ShipCombatState.getSensorStats();
    const ghRange = sensor.autoScanRange ?? 0;
    const gridSize = canvas.grid.size;
    const cx0 = ownToken.x + (ownToken.document.width  * gridSize) / 2;
    const cy0 = ownToken.y + (ownToken.document.height * gridSize) / 2;

    for (const [tokenId, entry] of this._overlays) {
      const enemyToken = canvas.tokens.placeables.find(t => t.id === tokenId);
      if (!enemyToken) continue;
      if (enemyToken.document.actor?.id === ship.id) continue; // skip own ship
      const cW = enemyToken.document.width  * gridSize;
      const tx = enemyToken.x + cW / 2;
      const ty = enemyToken.y + (enemyToken.document.height * gridSize) / 2;
      const dist = Math.sqrt((tx - cx0) ** 2 + (ty - cy0) ** 2) / gridSize;
      const explicitLock = locks.find(l => l.targetTokenId === tokenId);
      const explicitTier = explicitLock?.tier ?? 0;
      const autoTier = (ghRange > 0 && dist <= ghRange) ? 2 : 0;
      entry.container.visible = Math.max(explicitTier, autoTier) >= 2;
    }
  }

  /** Remove every overlay  -  call on canvasTearDown. */
  static destroyAll() {
    for (const [id] of this._overlays) this._destroyToken(id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  static _destroyToken(tokenId) {
    const entry = this._overlays.get(tokenId);
    if (entry?.container) entry.container.destroy({ children: true });
    this._overlays.delete(tokenId);
  }

  static _drawForToken(token, sys, zoneThresholds, showShields = true, tier = 4) {
    if (!canvas?.tokens) return;

    const IMPMAL_GREEN  = pixi(THEME.overlay.shieldGreen);
    const IMPMAL_BLUE   = pixi(THEME.overlay.shieldBlue);

    // ── Get-or-create PIXI container ────────────────────────────────────────
    let entry = this._overlays.get(token.id);
    if (!entry) {
      const container = new PIXI.Container();
      container.name  = "shipcombat-shield-arc";
      canvas.tokens.addChild(container);

      const graphics  = new PIXI.Graphics();
      container.addChild(graphics);

      // Bow arrow is a separate child so it always renders above the arc graphics.
      const bowMarker = new PIXI.Graphics();
      container.addChild(bowMarker);

      const texts = {};
      for (const arcId of ["bow", "port", "stern", "starboard"]) {
        // Light labels inside the band with a crisp stroke outline for readability
        const t = new PIXI.Text("", {
          fontFamily:      "Arial, sans-serif",
          fontSize:        11,
          fontWeight:      "bold",
          fill:            0xffffff,
          stroke:          0x003300,
          strokeThickness: 3,
          align:           "center",
        });
        // Render the text texture at a high pixel density so it stays sharp
        // when the user zooms in — the world-unit size is unchanged.
        t.resolution = Math.max(4, Math.ceil((window.devicePixelRatio ?? 1) * 4));
        t.anchor.set(0.5, 0.5);
        container.addChild(t);
        texts[arcId] = t;
      }

      entry = { container, graphics, bowMarker, texts };
      this._overlays.set(token.id, entry);
    }
    // Ensure the container is visible — it may have been hidden during a drag
    // by _updateEnemyOverlayVisibility before refresh() had a chance to run.
    entry.container.visible = true;

    // ── Geometry ─────────────────────────────────────────────────────────────
    const { graphics, texts } = entry;
    const bowMarker = entry.bowMarker ?? null;
    graphics.clear();
    bowMarker?.clear();

    const gridSize  = canvas.grid.size;
    const tokenW    = token.document.width  * gridSize;
    const tokenH    = token.document.height * gridSize;
    // Live PIXI position so the overlay tracks drag and animation each frame.
    const cx        = token.x + tokenW / 2;
    const cy        = token.y + tokenH / 2;

    const h0 = (token.document.rotation - 90) * (Math.PI / 180);

    const tokenRadius = Math.sqrt((tokenW / 2) ** 2 + (tokenH / 2) ** 2);
    const gap         = Math.max(4,  gridSize * 0.06);
    const innerR      = tokenRadius + gap;
    const bandWidth   = Math.max(8,  gridSize * 0.14);
    const outerR      = innerR + bandWidth;
    // Labels at radial midpoint  -  inside the band, away from the bow arrow.
    const midR        = (innerR + outerR) / 2;

    // HALF_SPAN ≈ 40.95° (< 45°) → no overlap between adjacent arcs.
    const HALF_SPAN = (Math.PI / 4) * 0.91;
    const SEGMENTS  = 22;

    const ARCS = [
      { id: "bow",       offset:  0           },
      { id: "starboard", offset:  Math.PI / 2 },
      { id: "stern",     offset:  Math.PI     },
      { id: "port",      offset: -Math.PI / 2 },
    ];

    const shields = sys.shields ?? {};

    for (const arc of ARCS) {
      const val       = Math.max(0, shields[arc.id] ?? 0);
      const zt        = (zoneThresholds?.[arc.id] ?? 8) || 1;
      const over      = val > zt;
      const arcColor  = over ? IMPMAL_BLUE : IMPMAL_GREEN;
      const pct       = Math.min(1, val / zt);
      const centerAng = h0 + arc.offset;
      const startAng  = centerAng - HALF_SPAN;
      const endAng    = centerAng + HALF_SPAN;

      // Fill: opacity scales with shield level (0 = transparent, 1 = solid).
      if (pct > 0 || over) {
        graphics.beginFill(arcColor, 0.18 + Math.min(1, pct) * 0.60);
        graphics.lineStyle(0);
        graphics.drawPolygon(_arcBandPoints(cx, cy, innerR, outerR, startAng, endAng, SEGMENTS));
        graphics.endFill();
      }

      // Outline: always visible; bright when shielded, dim when empty.
      graphics.lineStyle(1.5, arcColor, (pct > 0 || over) ? 0.85 : 0.22);
      graphics.beginFill(0, 0);
      graphics.drawPolygon(_arcBandPoints(cx, cy, innerR, outerR, startAng, endAng, SEGMENTS));
      graphics.endFill();
      graphics.lineStyle(0);

      // Numeric label inside the band at mid-radius (Lock 3+ only).
      // At Lock 2, the arc band opacity already conveys shield strength
      // (matching the Augur popup's bar-only treatment), so we hide text.
      const txt = texts[arc.id];
      txt.x       = cx + midR * Math.cos(centerAng);
      txt.y       = cy + midR * Math.sin(centerAng);
      if (tier >= 3) {
        txt.text       = String(val);
        txt.style.fill = 0xffffff;
        txt.visible = true;
      } else {
        txt.text    = "";
        txt.visible = false;
      }
    }

    // ── Bow direction arrow ───────────────────────────────────────────────────
    // Sits past the outer rim of the bow arc. Labels are now inside the band so
    // there is no spatial conflict between the arrow and the "bow" number.
    if (bowMarker) {
      const bowVal  = Math.max(0, shields.bow ?? 0);
      const bowZt   = (zoneThresholds?.bow ?? 8) || 1;
      const bowColor = bowVal > bowZt ? IMPMAL_BLUE : IMPMAL_GREEN;
      const arrowGap = Math.max(3,  gridSize * 0.03);
      const arrowH   = Math.max(9,  gridSize * 0.13);
      const arrowW   = Math.max(5,  gridSize * 0.08);
      const noseR    = outerR + arrowGap + arrowH;
      const baseR    = outerR + arrowGap;
      const perpX    = Math.cos(h0 + Math.PI / 2);
      const perpY    = Math.sin(h0 + Math.PI / 2);

      const noseX = cx + noseR * Math.cos(h0);
      const noseY = cy + noseR * Math.sin(h0);
      const b1x   = cx + baseR * Math.cos(h0) + (arrowW / 2) * perpX;
      const b1y   = cy + baseR * Math.sin(h0) + (arrowW / 2) * perpY;
      const b2x   = cx + baseR * Math.cos(h0) - (arrowW / 2) * perpX;
      const b2y   = cy + baseR * Math.sin(h0) - (arrowW / 2) * perpY;

      // For unauthorised users the arrow is always neutral green (no shield
      // info leaked). For authorised users it tracks bow overcharge state.
      bowMarker.beginFill(showShields ? bowColor : IMPMAL_GREEN, 0.92);
      bowMarker.lineStyle(0);
      bowMarker.drawPolygon([noseX, noseY, b1x, b1y, b2x, b2y]);
      bowMarker.endFill();
    }
  }
}

// ── PIXI polygon helpers ──────────────────────────────────────────────────────

/**
 * Build a PIXI-compatible flat point array [x0,y0, x1,y1, …] that traces a
 * filled ring band from startAngle to endAngle between innerR and outerR.
 * Draws inner edge CW then outer edge CCW so the filled region is the band.
 *
 * Uses polygon approximation to avoid PIXI.Graphics.arc() API differences
 * between PIXI v7 and v8.
 */
function _arcBandPoints(cx, cy, innerR, outerR, startAngle, endAngle, segments) {
  const pts = [];

  // Inner arc: startAngle → endAngle (CW)
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (endAngle - startAngle) * (i / segments);
    pts.push(cx + innerR * Math.cos(a), cy + innerR * Math.sin(a));
  }

  // Outer arc: endAngle → startAngle (CCW, traces back)
  for (let i = segments; i >= 0; i--) {
    const a = startAngle + (endAngle - startAngle) * (i / segments);
    pts.push(cx + outerR * Math.cos(a), cy + outerR * Math.sin(a));
  }

  return pts;
}


