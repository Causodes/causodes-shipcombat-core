import { ShipCombatState } from "../state/ShipCombatState.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { THEME, pixi } from "../theme.js";
import { getContactDisplayName } from "../targeting/contact-intelligence.js";

const LOCK_TIER_COLOUR = Object.freeze({
  0: 0x666666,
  1: 0xff4444,
  2: 0xe67e22,
  3: 0x22ccbb,
  4: 0xcc44cc,
});

function _labelText(fontSize) {
  const text = new PIXI.Text("", {
    fontFamily: "Arial, sans-serif",
    fontSize,
    fontWeight: "bold",
    fill: 0xffffff,
    stroke: 0x000000,
    strokeThickness: 3,
    align: "center",
  });
  text.anchor.set(0, 0.5);
  text.resolution = Math.max(2, Math.ceil((window.devicePixelRatio ?? 1) * 2));
  return text;
}

function _effectiveLockTier(token) {
  const ownToken = ShipCombatState.ship?.getActiveTokens?.()?.[0];
  const gs = canvas?.grid?.size;
  if (!ownToken || !gs) return ShipCombatState.getLockTier(token.id);

  const tx = token.x + (token.document.width * gs) / 2;
  const ty = token.y + (token.document.height * gs) / 2;
  const sx = ownToken.x + (ownToken.document.width * gs) / 2;
  const sy = ownToken.y + (ownToken.document.height * gs) / 2;
  return ShipCombatState.getEffectiveLockTier(token.id, Math.hypot(tx - sx, ty - sy) / gs);
}

function _canSeeCrewTargeting(ship) {
  if (game.user?.isGM) return true;
  const data = SystemAdapter.current.getShipData(ship) ?? {};
  if (data.roles?.[game.user?.id]) return true;
  return !!ship?.testUserPermission?.(game.user, "OBSERVER");
}

/** Crew-only canvas markers for Sensors recommendations and Battle Clarity. */
export class TargetDesignationOverlay {
  static _overlays = new Map();

  static refresh() {
    if (!canvas?.ready || !canvas.tokens) return;
    const ship = ShipCombatState.ship;
    if (!ship || !_canSeeCrewTargeting(ship)) {
      this.destroyAll();
      return;
    }

    const data = SystemAdapter.current.getShipData(ship) ?? {};
    const recommendedId = data.resources?.sensors?.recommendedTargetId ?? null;
    const priorityId = data.resources?.captain?.priorityTargetId ?? null;
    const activeIds = new Set([recommendedId, priorityId].filter(Boolean));

    for (const [tokenId] of this._overlays) {
      if (!activeIds.has(tokenId)) this._destroyToken(tokenId);
    }

    for (const tokenId of activeIds) {
      const token = canvas.tokens.get(tokenId);
      // Never let a crew marker reveal a token hidden by current lock quality.
      if (!token || token.visible === false) {
        this._destroyToken(tokenId);
        continue;
      }
      this._drawToken(token, data, {
        recommended: recommendedId === tokenId,
        priority: priorityId === tokenId,
      });
    }
  }

  static onRefreshToken(token) {
    if (!this._overlays.has(token?.id)) return;
    this.refresh();
  }

  static destroyAll() {
    for (const [tokenId] of this._overlays) this._destroyToken(tokenId);
  }

  static _destroyToken(tokenId) {
    const entry = this._overlays.get(tokenId);
    if (!entry) return;
    entry.container.destroy({ children: true });
    this._overlays.delete(tokenId);
  }

  static _drawToken(token, data, { recommended, priority }) {
    let entry = this._overlays.get(token.id);
    if (!entry) {
      const container = new PIXI.Container();
      container.name = "shipcombat-target-designation";
      container.eventMode = "none";
      const graphics = new PIXI.Graphics();
      const markText = _labelText(11);
      const separatorText = _labelText(11);
      const clarityText = _labelText(11);
      const nameText = _labelText(12);
      nameText.anchor.set(0.5, 0.5);
      container.addChild(graphics);
      container.addChild(markText, separatorText, clarityText, nameText);
      canvas.tokens.addChild(container);
      entry = { container, graphics, markText, separatorText, clarityText, nameText };
      this._overlays.set(token.id, entry);
    }

    const gs = canvas.grid.size;
    const width = token.document.width * gs;
    const height = token.document.height * gs;
    const cx = token.x + width / 2;
    const cy = token.y + height / 2;
    const tokenRadius = Math.sqrt((width / 2) ** 2 + (height / 2) ** 2);
    // Match ShieldArcOverlay's exact outer geometry, including its bow arrow,
    // then add clearance. Since the heading marker rotates with the token, all
    // four targeting indicators remain outside that maximum radius.
    const shieldOuter = tokenRadius + Math.max(4, gs * 0.06) + Math.max(8, gs * 0.14);
    const headingOuter = shieldOuter + Math.max(3, gs * 0.03) + Math.max(9, gs * 0.13);
    const markerInner = headingOuter + Math.max(5, gs * 0.05);
    let labelOuter = markerInner;
    const graphics = entry.graphics;
    graphics.clear();

    if (recommended) {
      const colour = pixi(THEME.overlay.sensorRecommendation);
      const span = Math.max(12, gs * 0.16);
      const thickness = Math.max(4, gs * 0.045);
      const outer = markerInner + span;
      const innerCoord = markerInner / Math.SQRT2;
      const outerCoord = outer / Math.SQRT2;
      labelOuter = Math.max(labelOuter, outerCoord);

      // High-opacity translucent corner plates, without an outline that could
      // be mistaken for another shield band or mechanical bonus.
      graphics.lineStyle(0);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const points = [
          cx + sx * outerCoord,               cy + sy * innerCoord,
          cx + sx * outerCoord,               cy + sy * outerCoord,
          cx + sx * innerCoord,               cy + sy * outerCoord,
          cx + sx * innerCoord,               cy + sy * (outerCoord - thickness),
          cx + sx * (outerCoord - thickness), cy + sy * (outerCoord - thickness),
          cx + sx * (outerCoord - thickness), cy + sy * innerCoord,
        ];
        graphics.beginFill(colour, 0.68);
        graphics.drawPolygon(points);
        graphics.endFill();
      }
    }

    if (priority) {
      const colour = pixi(THEME.overlay.battleClarity);
      const depth = Math.max(9, gs * 0.12);
      const span = Math.max(7, depth * 0.72);
      const thickness = Math.max(4, gs * 0.045);
      const outer = markerInner + depth;
      labelOuter = Math.max(labelOuter, outer);

      // Four high-opacity translucent inward chevrons remain visually distinct
      // from the informational corner plates without adding a heavy outline.
      const topChevron = [
        [-span, -outer],
        [0, -markerInner],
        [span, -outer],
        [span - thickness, -outer],
        [0, -markerInner - thickness],
        [-span + thickness, -outer],
      ];
      graphics.lineStyle(0);
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const angle = quarter * Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const points = topChevron.flatMap(([x, y]) => [
          cx + x * cos - y * sin,
          cy + x * sin + y * cos,
        ]);
        graphics.beginFill(colour, 0.72);
        graphics.drawPolygon(points);
        graphics.endFill();
      }
    }

    const lockTier = _effectiveLockTier(token);
    const lockColour = LOCK_TIER_COLOUR[lockTier] ?? LOCK_TIER_COLOUR[0];
    const label = getContactDisplayName(data, token.id, {
      currentTier: lockTier,
      realName: token.document.name ?? "Unknown",
    });

    entry.markText.text = recommended ? "MARKED TARGET" : "";
    entry.markText.style.fill = pixi(THEME.overlay.sensorRecommendation);
    entry.markText.visible = recommended;
    entry.separatorText.text = recommended && priority ? " | " : "";
    entry.separatorText.style.fill = lockColour;
    entry.separatorText.visible = recommended && priority;
    entry.clarityText.text = priority ? "BATTLE CLARITY" : "";
    entry.clarityText.style.fill = pixi(THEME.overlay.battleClarity);
    entry.clarityText.visible = priority;
    entry.nameText.text = label;
    entry.nameText.style.fill = lockColour;

    const firstLine = [entry.markText, entry.separatorText, entry.clarityText].filter(text => text.visible);
    const firstLineWidth = firstLine.reduce((total, text) => total + text.width, 0);
    let firstLineX = cx - firstLineWidth / 2;
    const nameY = cy - labelOuter - Math.max(12, gs * 0.11);
    const firstLineY = nameY - Math.max(16, gs * 0.15);
    for (const text of firstLine) {
      text.position.set(firstLineX, firstLineY);
      firstLineX += text.width;
    }
    entry.nameText.position.set(cx, nameY);
    entry.container.visible = true;
  }
}
