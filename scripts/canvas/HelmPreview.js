import { THEME, pixi } from "../theme.js";

/**
 * HelmPreview – draws a semi-transparent ghost of the ship token at the
 * projected position on the canvas, connected by a curved arc.
 *
 * Movement uses a FIXED-RADIUS circular arc:
 *  - Radius R = (speed × gridSize) / |bearingRad|   -  constant for a given bearing
 *  - Arc length = (thrustPct / 100) × speed × gridSize   -  scales with power
 *  - Total heading change = (thrustPct / 100) × bearingDeg   -  grows with both
 *  - More power → further along the same curve, not a tighter turn
 *
 * Usage:
 *   HelmPreview.show(token, { x, y, rotation })
 *   HelmPreview.hide()
 *   HelmPreview.projectPosition(token, bearingDeg, thrustPct, speed)
 *   HelmPreview.updateLine(bearingDeg, thrustPct, speed)
 */
export class HelmPreview {

  static _container = null;
  static _sprite    = null;
  static _token     = null;
  static _line      = null;

  /** Number of polyline segments used to approximate the arc. */
  static ARC_SEGMENTS = 48;

  /**
   * Calculate where the ship ends up after committing `thrustPct`% of its
   * maximum power, curving at a radius determined solely by `bearingDeg`.
   * An optional `minMoveGridUnits` drift is always applied straight-ahead first
   * (the mandatory minimum movement every turn).
   *
   * @param {Token}  token             – the ship token on the canvas
   * @param {number} bearingDeg        – bearing in degrees (±). Defines turn radius.
   * @param {number} thrustPct         – additional thrust this move (0–100)
   * @param {number} speed             – ship speed stat (VU at 100% thrust)
   * @param {number} minMoveGridUnits  – mandatory straight-ahead drift in grid squares
   * @returns {{ x, y, rotation }}
   */
  static projectPosition(token, bearingDeg, thrustPct, speed, minMoveGridUnits = 0) {
    if (!token) return null;

    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const tokenW = token.document.width  * gridSize;
    const tokenH = token.document.height * gridSize;

    const bearingRad = bearingDeg * (Math.PI / 180);
    // Slider represents total movement: thrustPct% of (speed + minMove) VU.
    const totalDist = (thrustPct / 100) * (speed + minMoveGridUnits) * gridSize;

    if (totalDist <= 0) {
      return { x: cx0 - tokenW / 2, y: cy0 - tokenH / 2, rotation: token.document.rotation };
    }

    return this._arcEndpoint(cx0, cy0, h0, bearingRad, totalDist, speed + minMoveGridUnits, gridSize, token);
  }

  /**
   * Return an array of screen {x, y} centre-points along the full path for the
   * preview line: first the straight drift (minMoveGridUnits), then the arc.
   */
  static projectPath(token, bearingDeg, thrustPct, speed, segments = this.ARC_SEGMENTS, minMoveGridUnits = 0) {
    if (!token) return [];

    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const bearingRad = bearingDeg * (Math.PI / 180);
    // Slider represents total movement: thrustPct% of (speed + minMove) VU.
    const totalDist = (thrustPct / 100) * (speed + minMoveGridUnits) * gridSize;
    const maxDist   = (speed + minMoveGridUnits) * gridSize;

    const pts = [{ x: cx0, y: cy0 }];
    if (totalDist <= 0) return pts;

    for (let i = 1; i <= segments; i++) {
      const t   = i / segments;
      const arc = t * totalDist;
      if (Math.abs(bearingRad) < 0.001) {
        pts.push({ x: cx0 + arc * Math.cos(h0), y: cy0 + arc * Math.sin(h0) });
      } else {
        const dRad = (arc / maxDist) * bearingRad;
        pts.push({
          x: cx0 + (maxDist / bearingRad) * (Math.sin(h0 + dRad) - Math.sin(h0)),
          y: cy0 + (maxDist / bearingRad) * (-Math.cos(h0 + dRad) + Math.cos(h0)),
        });
      }
    }
    return pts;
  }

  // ── Public rendering API ─────────────────────────────────────────────────

  static show(token, { x, y, rotation }) {
    this._token = token;
    this.hide();

    if (!canvas?.stage || !token?.mesh) return;

    this._container = new PIXI.Container();
    this._container.name = "shipcombat-helm-ghost";
    canvas.tokens.addChild(this._container);

    const texture = token.mesh?.texture;
    if (!texture) return;

    this._sprite = new PIXI.Sprite(texture);
    this._sprite.anchor.set(0.5, 0.5);

    const gridSize = canvas.grid.size;
    this._sprite.width  = token.document.width  * gridSize;
    this._sprite.height = token.document.height * gridSize;
    this._sprite.alpha  = 0.4;
    this._sprite.tint   = pixi(THEME.overlay.helmGhost);

    this._setPosition(x, y, rotation);
    this._container.addChild(this._sprite);

    this._line = new PIXI.Graphics();
    this._line.name = "shipcombat-helm-line";
    this._container.addChild(this._line);
  }

  static update({ x, y, rotation }) {
    if (!this._sprite || !this._token) return;
    this._setPosition(x, y, rotation);
  }

  static hide() {
    if (this._container) {
      this._container.destroy({ children: true });
      this._container = null;
      this._sprite    = null;
      this._line      = null;
    }
  }

  /**
   * Compute waypoints for animating the token along its arc path.
   * Returns an array of {x, y, rotation} document-coordinate points, not
   * including the starting position.  Use with token.document.move().
   *
   * @param {Token}  token
   * @param {number} bearingDeg
   * @param {number} thrustPct         – additional thrust (0–100)
   * @param {number} speed             – ship speed stat
   * @param {number} minMoveGridUnits  – mandatory drift in grid squares
   * @param {number} steps             – number of animation waypoints (default 12)
   */
  static projectWaypoints(token, bearingDeg, thrustPct, speed, minMoveGridUnits = 0) {
    if (!token) return [];
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const bearingRad = bearingDeg * (Math.PI / 180);
    // Slider represents total movement: thrustPct% of (speed + minMove) VU.
    const totalDist = (thrustPct / 100) * (speed + minMoveGridUnits) * gridSize;
    if (totalDist <= 0) return [];

    // One waypoint per grid unit of travel for smooth per-square animation
    const steps = Math.max(1, Math.round(totalDist / gridSize));
    const waypoints = [];
    for (let i = 1; i <= steps; i++) {
      const arcLen = (i / steps) * totalDist;
      waypoints.push(this._arcEndpoint(cx0, cy0, h0, bearingRad, arcLen, speed + minMoveGridUnits, gridSize, token));
    }
    return waypoints;
  }

  /**
   * Compute waypoints for animating a lateral strafe movement.
   * Returns an array of {x, y, rotation} document-coordinate points.
   *
   * @param {Token}  token
   * @param {number} dir    +1 = starboard, -1 = port
   * @param {number} dist   grid squares to slide
   * @param {number} steps  number of animation waypoints (default 6)
   */
  static projectStrafeWaypoints(token, dir, dist) {
    if (!token || dist === 0) return [];
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const tokenW = token.document.width  * gridSize;
    const tokenH = token.document.height * gridSize;
    const perpAngle = h0 + dir * (Math.PI / 2);
    const totalDist = dist * gridSize;
    // One waypoint per grid unit
    const steps = Math.max(1, dist);
    const waypoints = [];
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * totalDist;
      waypoints.push({
        x: Math.round(cx0 + d * Math.cos(perpAngle) - tokenW / 2),
        y: Math.round(cy0 + d * Math.sin(perpAngle) - tokenH / 2),
        rotation: token.document.rotation,
      });
    }
    return waypoints;
  }

  /**
   * Project a retrograde (backward) position.
   * dist: grid squares to move directly aft (opposite of current heading).
   */
  static projectRetrograde(token, dist) {
    if (!token || dist <= 0) return null;
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const tokenW = token.document.width  * gridSize;
    const tokenH = token.document.height * gridSize;
    // Backward = opposite heading direction
    const backAngle = h0 + Math.PI;
    const newCx = cx0 + dist * gridSize * Math.cos(backAngle);
    const newCy = cy0 + dist * gridSize * Math.sin(backAngle);
    return {
      x: newCx - tokenW / 2,
      y: newCy - tokenH / 2,
      rotation: token.document.rotation,
    };
  }

  /**
   * Compute waypoints for animating a retrograde (backward) movement.
   * One waypoint per grid unit of travel.
   */
  static projectRetrogradeWaypoints(token, dist) {
    if (!token || dist <= 0) return [];
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const tokenW = token.document.width  * gridSize;
    const tokenH = token.document.height * gridSize;
    const backAngle = h0 + Math.PI;
    const steps = Math.max(1, dist);
    const waypoints = [];
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * dist * gridSize;
      waypoints.push({
        x: Math.round(cx0 + d * Math.cos(backAngle) - tokenW / 2),
        y: Math.round(cy0 + d * Math.sin(backAngle) - tokenH / 2),
        rotation: token.document.rotation,
      });
    }
    return waypoints;
  }

  /**
   * Project a lateral strafe position.
   * dir: +1 = starboard (right of heading), -1 = port (left of heading)
   * dist: grid squares to slide
   */
  static projectStrafe(token, dir, dist) {
    if (!token) return null;
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const tokenW = token.document.width  * gridSize;
    const tokenH = token.document.height * gridSize;
    // Perpendicular to heading: heading h0 points forward, so +90° = starboard
    const perpAngle = h0 + dir * (Math.PI / 2);
    const slideDist = dist * gridSize;
    const newCx = cx0 + slideDist * Math.cos(perpAngle);
    const newCy = cy0 + slideDist * Math.sin(perpAngle);
    return {
      x: newCx - tokenW / 2,
      y: newCy - tokenH / 2,
      rotation: token.document.rotation,
    };
  }

  /** Show strafe ghost and a dashed lateral line. */
  static showStrafe(token, dir, dist) {
    const projected = this.projectStrafe(token, dir, dist);
    if (!projected) return;
    this.show(token, projected);

    // Draw the lateral line over the existing line graphics
    if (!this._line || !this._token) return;
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const perpAngle = h0 + dir * (Math.PI / 2);
    const slideDist = dist * gridSize;
    this._line.clear();
    this._line.lineStyle(2, pixi(THEME.overlay.helmGhost), 0.6);
    this._line.moveTo(cx0, cy0);
    this._line.lineTo(cx0 + slideDist * Math.cos(perpAngle), cy0 + slideDist * Math.sin(perpAngle));
  }

  /** Show retrograde ghost and a dashed sternward line. */
  static showRetrograde(token, dist) {
    const projected = this.projectRetrograde(token, dist);
    if (!projected) return;
    this.show(token, projected);

    if (!this._line || !this._token) return;
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const backAngle = h0 + Math.PI;
    const backDist = dist * gridSize;
    this._line.clear();
    this._line.lineStyle(2, pixi(THEME.overlay.helmGhost), 0.6);
    this._line.moveTo(cx0, cy0);
    this._line.lineTo(cx0 + backDist * Math.cos(backAngle), cy0 + backDist * Math.sin(backAngle));
  }

  /**
   * Redraw the full preview line (drift + arc).
   *
   * @param {number} bearingDeg        – current bearing
   * @param {number} thrustPct         – additional thrust (0–100)
   * @param {number} speed             – ship speed stat
   * @param {number} minMoveGridUnits  – mandatory drift in grid squares
   */
  static updateLine(bearingDeg, thrustPct, speed, minMoveGridUnits = 0) {
    if (!this._line || !this._token) return;

    const points = this.projectPath(this._token, bearingDeg, thrustPct, speed, this.ARC_SEGMENTS, minMoveGridUnits);
    if (points.length < 2) return;

    this._line.clear();
    this._line.lineStyle(2, pixi(THEME.overlay.helmGhost), 0.6);
    this._line.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this._line.lineTo(points[i].x, points[i].y);
    }
  }

  /**
   * Project the final position of a Flip and Burn maneuver:
   * the ship first rotates 180° in place, then moves sternward (backward along
   * its ORIGINAL heading) at the given distance in grid units.
   *
   * @param {Token}  token           – the ship token
   * @param {number} halfSpeedUnits  – distance in grid units (= 50% of effective speed)
   */
  static projectFlipAndBurn(token, halfSpeedUnits) {
    if (!token || halfSpeedUnits <= 0) return null;
    const { cx0, cy0, h0, gridSize, tokenW, tokenH } = this._tokenBasis(token);
    // Translate along the ORIGINAL heading (h0): the ship decelerates along its
    // old trajectory while now facing backward (h0+π).
    const dist = halfSpeedUnits * gridSize;
    const newCx = cx0 + dist * Math.cos(h0);
    const newCy = cy0 + dist * Math.sin(h0);
    return {
      x:        newCx - tokenW / 2,
      y:        newCy - tokenH / 2,
      rotation: token.document.rotation + 180,
    };
  }

  /**
   * Waypoints for a Flip and Burn: rotate in place first, then step backward.
   * @param {Token}  token
   * @param {number} halfSpeedUnits
   */
  static projectFlipAndBurnWaypoints(token, halfSpeedUnits) {
    if (!token || halfSpeedUnits <= 0) return [];
    const { cx0, cy0, h0, gridSize, tokenW, tokenH } = this._tokenBasis(token);
    const flippedRotation = token.document.rotation + 180;
    const waypoints = [];
    // First waypoint: spin in place (same x/y, rotation +180°)
    waypoints.push({
      x:        Math.round(token.document.x),
      y:        Math.round(token.document.y),
      rotation: flippedRotation,
    });
    // Then step along old heading (h0), one waypoint per grid unit
    const steps = Math.max(1, halfSpeedUnits);
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * halfSpeedUnits * gridSize;
      waypoints.push({
        x:        Math.round(cx0 + d * Math.cos(h0) - tokenW / 2),
        y:        Math.round(cy0 + d * Math.sin(h0) - tokenH / 2),
        rotation: flippedRotation,
      });
    }
    return waypoints;
  }

  /**
   * Show the Flip and Burn ghost: rotated 180°, moved sternward.
   * Draws a straight line from current position to the final position.
   */
  static showFlipAndBurn(token, halfSpeedUnits) {
    const projected = this.projectFlipAndBurn(token, halfSpeedUnits);
    if (!projected) return;
    this.show(token, projected);
    if (!this._line || !this._token) return;
    const { cx0, cy0, h0, gridSize } = this._tokenBasis(token);
    const dist = halfSpeedUnits * gridSize;
    this._line.clear();
    this._line.lineStyle(2, pixi(THEME.overlay.helmGhost), 0.6);
    this._line.moveTo(cx0, cy0);
    this._line.lineTo(cx0 + dist * Math.cos(h0), cy0 + dist * Math.sin(h0));
  }

  // ── Ram ──────────────────────────────────────────────────────────────────

  /**
   * Determine whether the ship can arc to a target canvas centre point.
   *
   * Uses closed-form arc geometry (O(1), no iteration).
   *
   * The arc model (from _arcEndpoint) is a fixed-radius circular arc where
   * the pilot's bearing input sets the turn radius and the thrust sets the arc
   * length.  Given a chord vector (dx, dy) from ship centre to target centre,
   * the required arc parameters are derived analytically.
   *
   * Math:
   *   φ = 2(θ_target − h0)           — total heading change; normalised to (−π, π]
   *   arcLength = d · φ / (2·sin(φ/2))  — chord–arc relationship (→ d when φ→0)
   *   bearingRad = φ · maxDist / arcLength — pilot bearing input
   *
   * @param {object} shipBasis          – { cx0, cy0, h0, gridSize } from _tokenBasis()
   * @param {number} targetCx           – target centre x (canvas pixels)
   * @param {number} targetCy           – target centre y (canvas pixels)
   * @param {number} effSpeed           – effective speed stat (VU)
   * @param {number} maxBearingDeg      – max bearing magnitude (mano × 15°, unbounded)
   * @param {number} powerRemaining     – uncommitted power budget (0–powerMax %)
   * @param {number} powerMax           – full power-bar max (usually 100)
   * @param {number} minMoveGridUnits   – mandatory drift in grid squares
   * @returns {{ bearingDeg: number, thrustPct: number } | null}
   */
  static canReach(shipBasis, targetCx, targetCy, effSpeed, maxBearingDeg, powerRemaining, powerMax, minMoveGridUnits) {
    const { cx0, cy0, h0, gridSize } = shipBasis;
    const maxDist      = effSpeed * gridSize;            // pixels at 100% of powerMax
    const minDistPx    = minMoveGridUnits * gridSize;    // min-move floor in pixels
    const totalMaxDist = maxDist + minDistPx;             // (speed + minMove) × gridSize
    const maxArcPx     = (powerRemaining / 100) * totalMaxDist;

    const dx = targetCx - cx0;
    const dy = targetCy - cy0;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d < 1) return null;  // trivially on top

    // Half the total heading change, normalised to (−π, π]
    let halfPhi = Math.atan2(dy, dx) - h0;
    halfPhi = ((halfPhi + Math.PI) % (2 * Math.PI)) - Math.PI;  // → (−π, π]
    const phi = 2 * halfPhi;   // total heading change, ∈ (−2π, 2π]

    // Required arc length: d = arcLength · 2sin(φ/2)/φ  →  arcLength = d·φ/(2·sin(φ/2))
    // Special-case |φ| < ε (straight line) to avoid 0/0.
    // Also guard φ ≈ ±2π (degenerate full-circle — arcLength → ∞).
    let arcLength;
    if (Math.abs(phi) < 1e-6) {
      arcLength = d;
    } else {
      const sinHalf = Math.sin(phi / 2);
      if (Math.abs(sinHalf) < 1e-9) return null;
      arcLength = d * phi / (2 * sinHalf);
    }

    // Arc length must be positive and within fuel budget.
    if (arcLength <= 0) return null;
    if (arcLength < minDistPx - 0.5 || arcLength > maxArcPx + 0.5) return null;

    // Required bearing input (pilot slider).
    const bearingRad = Math.abs(phi) < 1e-6 ? 0 : phi * totalMaxDist / arcLength;
    const bearingDeg = bearingRad * (180 / Math.PI);

    // maxBearingDeg is mano × 15 and is unbounded — no clamp needed, just check.
    if (Math.abs(bearingDeg) > maxBearingDeg + 1e-6) return null;

    // thrustPct = slider value; slider at X% → totalDist = X/100 × totalMaxDist.
    const thrustPct = Math.max(0, arcLength / totalMaxDist * 100);

    return { bearingDeg, thrustPct };
  }

  /**
   * Show a ram-course ghost: same arc preview as normal helm but drawn in red.
   *
   * @param {Token}  token             – the ship token
   * @param {number} bearingDeg        – bearing from canReach()
   * @param {number} thrustPct         – additional thrust % from canReach()
   * @param {number} speed             – effective speed stat
   * @param {number} minMoveGridUnits  – mandatory drift in grid squares
   */
  static showRam(token, bearingDeg, thrustPct, speed, minMoveGridUnits = 0) {
    const projected = this.projectPosition(token, bearingDeg, thrustPct, speed, minMoveGridUnits);
    if (!projected) return;
    this.show(token, projected);

    // Tint the ghost token red
    if (this._sprite) this._sprite.tint = pixi(THEME.overlay.helmRam);

    // Redraw the arc path in red
    if (!this._line || !this._token) return;
    const points = this.projectPath(token, bearingDeg, thrustPct, speed, this.ARC_SEGMENTS, minMoveGridUnits);
    if (points.length < 2) return;
    this._line.clear();
    this._line.lineStyle(3, pixi(THEME.overlay.helmRam), 0.85);
    this._line.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this._line.lineTo(points[i].x, points[i].y);
    }
  }

  // ── Realistic (Newtonian) movement ───────────────────────────────────────

  /**
   * Project where the ship ends up using Newtonian two-segment movement:
   *   1. Drift: translate by (vx, vy) grid squares
   *   2. Thrust: translate by (thrustPct/100 × speed) VU in bearing direction
   *
   * @param {Token}  token
   * @param {number} bearingDeg  – heading change in degrees (±)
   * @param {number} thrustPct   – additional thrust this move (0–powerMax)
   * @param {number} speed       – effective speed stat (VU at 100% thrust)
   * @param {number} vx          – velocity X component in VU
   * @param {number} vy          – velocity Y component in VU
   * @returns {{ x, y, rotation }}
   */
  static projectPositionRealistic(token, bearingDeg, thrustPct, speed, vx, vy, carryPct = 0) {
    if (!token) return null;
    const { cx0, cy0, h0, gridSize, tokenW, tokenH } = this._tokenBasis(token);
    const carry      = carryPct / 100;
    const bearingRad = bearingDeg * (Math.PI / 180);
    const thrustDir  = h0 + bearingRad;
    const thrustMag  = (thrustPct / 100) * speed * gridSize;
    const finalCx    = cx0 + carry * vx * gridSize + thrustMag * Math.cos(thrustDir);
    const finalCy    = cy0 + carry * vy * gridSize + thrustMag * Math.sin(thrustDir);
    const finalRotation = token.document.rotation + bearingDeg;
    return {
      x:        finalCx - tokenW / 2,
      y:        finalCy - tokenH / 2,
      rotation: finalRotation,
    };
  }

  /**
   * Straight-line path for Newtonian movement: the actual trajectory through space
   * is the vector sum (start → final), not the two-segment decomposition.
   * Returns [start, end] centre-points for the preview line.
   */
  static projectPathRealistic(token, bearingDeg, thrustPct, speed, vx, vy, carryPct = 0) {
    if (!token) return [];
    const { cx0, cy0, h0, gridSize, tokenW, tokenH } = this._tokenBasis(token);
    const carry      = carryPct / 100;
    const bearingRad = bearingDeg * (Math.PI / 180);
    const thrustDir  = h0 + bearingRad;
    const thrustMag  = (thrustPct / 100) * speed * gridSize;
    const finalCx    = cx0 + carry * vx * gridSize + thrustMag * Math.cos(thrustDir);
    const finalCy    = cy0 + carry * vy * gridSize + thrustMag * Math.sin(thrustDir);
    return [{ x: cx0, y: cy0 }, { x: finalCx, y: finalCy }];
  }

  /**
   * Animation waypoints for Newtonian movement along the straight-line path
   * (vector sum of drift + thrust).  Rotation interpolates gradually to the
   * final heading over the course of the move.
   */
  static projectWaypointsRealistic(token, bearingDeg, thrustPct, speed, vx, vy, carryPct = 0) {
    if (!token) return [];
    const { cx0, cy0, h0, gridSize, tokenW, tokenH } = this._tokenBasis(token);
    const carry         = carryPct / 100;
    const bearingRad    = bearingDeg * (Math.PI / 180);
    const thrustDir     = h0 + bearingRad;
    const thrustMag     = (thrustPct / 100) * speed * gridSize;
    const finalCx       = cx0 + carry * vx * gridSize + thrustMag * Math.cos(thrustDir);
    const finalCy       = cy0 + carry * vy * gridSize + thrustMag * Math.sin(thrustDir);
    const startRotation = token.document.rotation;
    const finalRotation = startRotation + bearingDeg;
    const totalDist     = Math.hypot(finalCx - cx0, finalCy - cy0);
    if (totalDist < 1) {
      // Pure rotation: single waypoint at same position
      if (bearingDeg !== 0) {
        return [{ x: Math.round(token.document.x), y: Math.round(token.document.y), rotation: finalRotation }];
      }
      return [];
    }
    const steps = Math.max(1, Math.round(totalDist / gridSize));
    const waypoints = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      waypoints.push({
        x:        Math.round(cx0 + (finalCx - cx0) * t - tokenW / 2),
        y:        Math.round(cy0 + (finalCy - cy0) * t - tokenH / 2),
        rotation: startRotation + bearingDeg * t,
      });
    }
    return waypoints;
  }

  /**
   * Redraw the helm preview line using the Newtonian two-segment path.
   */
  static updateLineRealistic(bearingDeg, thrustPct, speed, vx, vy, carryPct = 0) {
    if (!this._line || !this._token) return;
    const points = this.projectPathRealistic(this._token, bearingDeg, thrustPct, speed, vx, vy, carryPct);
    if (points.length < 2) return;
    this._line.clear();
    this._line.lineStyle(2, pixi(THEME.overlay.helmGhost), 0.6);
    this._line.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this._line.lineTo(points[i].x, points[i].y);
    }
  }

  /**
   * Determine whether the ship can reach a target in Realistic mode.
   *
   * Two-step check:
   *   1. Drift_end = start + (vx, vy) × gridSize
   *   2. Thrust vector = target − drift_end; must be ≤ powerRemaining budget
   *      and within the ±maxBearingDeg arc.
   *
   * @returns {{ bearingDeg, thrustPct, isPureDrift } | null}
   */
  static canReachRealistic(shipBasis, targetCx, targetCy, effSpeed, maxBearingDeg, powerRemaining, powerMax, vx, vy, carryPct = 0) {
    const { cx0, cy0, h0, gridSize } = shipBasis;
    const carry     = carryPct / 100;
    const driftEndX = cx0 + carry * vx * gridSize;
    const driftEndY = cy0 + carry * vy * gridSize;
    const Tx = targetCx - driftEndX;
    const Ty = targetCy - driftEndY;
    const tMag = Math.hypot(Tx, Ty);

    // Pure drift ram: target lies right at drift_end
    if (tMag < gridSize * 0.5) {
      return { bearingDeg: 0, thrustPct: 0, isPureDrift: true };
    }

    // Maximum thrust in pixels at remaining power
    const maxThrustPx = (powerRemaining / 100) * effSpeed * gridSize;
    if (tMag > maxThrustPx + 0.5) return null;

    // Required thrust bearing relative to current heading
    const thrustAngle = Math.atan2(Ty, Tx);
    let bearingRad    = thrustAngle - h0;
    // Normalise to (−π, π]
    bearingRad = ((bearingRad + Math.PI) % (2 * Math.PI)) - Math.PI;
    const bearingDeg = bearingRad * (180 / Math.PI);
    if (Math.abs(bearingDeg) > maxBearingDeg + 1e-6) return null;

    // thrustPct on the 0–powerRemaining scale
    const thrustPct = (effSpeed * gridSize > 0) ? (tMag / (effSpeed * gridSize)) * 100 : 0;
    if (thrustPct > powerRemaining + 0.5) return null;

    return { bearingDeg, thrustPct, isPureDrift: false };
  }

  /**
   * Compute the optimal ram rotation in Realistic mode.
   * Picks whichever ±90° candidate from attackAngle is closest to the
   * current heading, then clamps to ±maxBearingDeg.
   *
   * @param {number} h0deg         – current ship Foundry rotation (degrees)
   * @param {number} attackAngle   – math radians, from ramming ship to target
   * @param {number} maxBearingDeg – max bearing magnitude
   * @returns {number}             – Foundry rotation degrees
   */
  static computeRamRotationRealistic(h0deg, attackAngle, maxBearingDeg) {
    const h0    = (h0deg - 90) * (Math.PI / 180);
    const candA = attackAngle + Math.PI / 2;
    const candB = attackAngle - Math.PI / 2;
    const normDiff = (a, b) => {
      const d = ((a - b + Math.PI) % (2 * Math.PI)) - Math.PI;
      return Math.abs(d);
    };
    const targetHeading = normDiff(candA, h0) <= normDiff(candB, h0) ? candA : candB;
    let delta = ((targetHeading - h0 + Math.PI) % (2 * Math.PI)) - Math.PI;
    const maxRad = maxBearingDeg * (Math.PI / 180);
    delta = Math.max(-maxRad, Math.min(maxRad, delta));
    return (h0 + delta) * (180 / Math.PI) + 90;
  }

  /**
   * Show a ram-course ghost for Realistic mode: two-segment path in red.
   */
  static showRamRealistic(token, bearingDeg, thrustPct, speed, vx, vy, carryPct = 0) {
    const projected = this.projectPositionRealistic(token, bearingDeg, thrustPct, speed, vx, vy, carryPct);
    if (!projected) return;
    this.show(token, projected);
    if (this._sprite) this._sprite.tint = pixi(THEME.overlay.helmRam);
    if (!this._line || !this._token) return;
    const points = this.projectPathRealistic(token, bearingDeg, thrustPct, speed, vx, vy, carryPct);
    if (points.length < 2) return;
    this._line.clear();
    this._line.lineStyle(3, pixi(THEME.overlay.helmRam), 0.85);
    this._line.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this._line.lineTo(points[i].x, points[i].y);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  static _tokenBasis(token) {
    const gridSize = canvas.grid.size;
    const tokenW   = token.document.width  * gridSize;
    const tokenH   = token.document.height * gridSize;
    const cx0      = token.document.x + tokenW / 2;
    const cy0      = token.document.y + tokenH / 2;
    // Foundry: rotation 0 = north, CW positive, y-axis down on screen.
    // Converted to math angle: 0 = east, CCW positive with y-down = CW visually.
    const h0 = (token.document.rotation - 90) * (Math.PI / 180);
    return { cx0, cy0, h0, gridSize, tokenW, tokenH };
  }

  static _arcEndpoint(cx0, cy0, h0, bearingRad, arcLength, speed, gridSize, token) {
    const tokenW = token.document.width  * gridSize;
    const tokenH = token.document.height * gridSize;
    // deltaRad = thrustPct/100 × bearingRad  (derived from arcLength and fixed R)
    const maxDist = speed * gridSize;
    const deltaRad = arcLength / maxDist * bearingRad;
    let newCx, newCy;

    if (Math.abs(bearingRad) < 0.001) {
      newCx = cx0 + arcLength * Math.cos(h0);
      newCy = cy0 + arcLength * Math.sin(h0);
    } else {
      newCx = cx0 + (maxDist / bearingRad) * (Math.sin(h0 + deltaRad) - Math.sin(h0));
      newCy = cy0 + (maxDist / bearingRad) * (-Math.cos(h0 + deltaRad) + Math.cos(h0));
    }

    return {
      x:        newCx - tokenW / 2,
      y:        newCy - tokenH / 2,
      rotation: token.document.rotation + deltaRad * (180 / Math.PI),
    };
  }

  static _setPosition(x, y, rotation) {
    if (!this._sprite || !this._token) return;
    const gridSize = canvas.grid.size;
    const tokenW   = this._token.document.width  * gridSize;
    const tokenH   = this._token.document.height * gridSize;
    this._sprite.position.set(x + tokenW / 2, y + tokenH / 2);
    this._sprite.angle = rotation;
  }
}
