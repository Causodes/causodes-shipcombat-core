/**
 * TokenVisibility  -  applies 4-tier visual treatment to enemy tokens on the
 * Foundry canvas based on current Augur lock state.
 *
 * Tier 0 (Contact):  hidden  -  token invisible to players
 * Tier 1 (Pinged):   translucent silhouette (25% alpha) with red outline; no name
 * Tier 2 (Analyzed): alpha 0.55  -  semi-transparent, name shown
 * Tier 3 (Scanned):  alpha 0.80  -  nearly full, name + bars
 * Tier 4 (Locked):   alpha 1.00  -  full visibility
 *
 * Auto-lock: targets within auto-scan range start at Tier 2.
 *
 * Call `refreshTokenVisibility()` whenever lock state changes or tokens move.
 */
import { MODULE_ID } from "../constants.js";
import { isOrdnance } from "../actors/ordnance/ordnance-types.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const TIER_ALPHA = [0, 0, 1.00, 1.00, 1.00]; // tier 0 & 1 handled specially; tier 2+ full opacity

// ── PIXI outline helpers for Tier 1 tokens ──────────────────────────────────

function _applyL1Overlay(token) {
  let g = token.__shipcombatL1Overlay;
  if (!g) {
    g = new PIXI.Graphics();
    token.addChild(g);
    token.__shipcombatL1Overlay = g;
  }
  g.clear();
  const w = token.w ?? (token.document.width  * (canvas.grid?.size ?? 100));
  const h = token.h ?? (token.document.height * (canvas.grid?.size ?? 100));
  g.lineStyle(3, 0xe74c3c, 1.0);
  g.beginFill(0xe74c3c, 0.18);
  g.drawRoundedRect(0, 0, w, h, 6);
  g.endFill();
  // Make the token image semi-transparent beneath the overlay
  if (token.mesh) token.mesh.alpha = 0.25;
  else            token.alpha      = 0.25;
}

function _clearL1Overlay(token) {
  if (token.__shipcombatL1Overlay) {
    token.removeChild(token.__shipcombatL1Overlay);
    token.__shipcombatL1Overlay.destroy();
    token.__shipcombatL1Overlay = null;
  }
}

/** Lazily created outline filter for Lock 1 tokens (V12 fallback, unused in V13). */
let _outlineFilter = null;
function _getOutlineFilter() {
  if (!_outlineFilter) {
    const FilterClass = foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter;
    if (!FilterClass) return null;
    _outlineFilter = FilterClass.create({
      outlineColor: [1.0, 0.27, 0.27, 1.0],  // red to match tier-1 colour
      knockout: false,  // keep interior pixels so fill is visible
      wave: false,
    });
    _outlineFilter.thickness = 1;
    _outlineFilter.animated = false;
  }
  return _outlineFilter;
}

/**
 * Per-token visibility handler.  Called from the patched
 * Token.prototype._refreshVisibility so it runs *after* Foundry's base
 * method has already set `this.visible = this.isVisible`.  This lets us
 * override the result without it being immediately reset.
 *
 * Also called from the refreshToken hook (after ALL render flags are
 * applied) to ensure our overrides survive any post-visibility render
 * pipeline methods (_refreshState, etc.) that might reset alpha/mesh.
 */
export function applyTokenVisibility(token) {
  if (!canvas?.ready) return;

  const ship = ShipCombatState.ship;
  if (!ship) return;

  // ── Own ship: always visible ──
  if (token.document.actor?.id === ship.id) {
    _forceVisible(token);
    return;
  }

  const ownToken = ship.getActiveTokens?.()?.[0];
  if (!ownToken) return;

  // ── Friendly ordnance: always fully visible (Lock 4 equivalent) ──
  const actorType = token.document.actor?.type;
  if (isOrdnance(token.document.actor)) {
    const parentTokenId = SystemAdapter.current.getShipData(token.document.actor)?.parentShipTokenId;
    if (parentTokenId && parentTokenId === ownToken.id) {
      _forceVisible(token);
      return;
    }
  }

  // ── Enemy tokens: tier-based visibility ──
  const actorId = token.document.actor?.id;
  if (!actorId) return;

  const gridSize = canvas.grid.size;
  const cx0 = ownToken.document.x + (ownToken.document.width  * gridSize) / 2;
  const cy0 = ownToken.document.y + (ownToken.document.height * gridSize) / 2;

  const locks   = SystemAdapter.current.getShipData(ship)?.resources?.sensors?.locks ?? [];
  const sensor  = ShipCombatState.getSensorStats();
  const ghRange = sensor.autoScanRange ?? 0;

  // Distance in grid squares
  const cW = token.document.width  * gridSize;
  const cH = token.document.height * gridSize;
  const tx = token.document.x + cW / 2;
  const ty = token.document.y + cH / 2;
  const distSq = Math.sqrt((tx - cx0) ** 2 + (ty - cy0) ** 2) / gridSize;

  const explicitLock = locks.find(l => l.targetTokenId === token.id);
  const explicitTier = explicitLock?.tier ?? 0;
  const autoTier     = (ghRange > 0 && distSq <= ghRange) ? 2 : 0;
  const tier         = Math.max(explicitTier, autoTier);

  const outlineFilter = _getOutlineFilter();

  if (tier === 0) {
    token.visible = game.user.isGM;
    _clearOutlineFilter(token, outlineFilter);
    _clearL1Overlay(token);
    if (token.mesh)  token.mesh.alpha = game.user.isGM ? 0.35 : 0;
    else             token.alpha      = game.user.isGM ? 0.35 : 0;
    if (token.nameplate) token.nameplate.visible = false;
    if (token.bars)      token.bars.visible = false;
    return;
  }

  token.visible = true;

  // Tier 1+: clear any overlay, show token art at full alpha
  _clearOutlineFilter(token, outlineFilter);
  _clearL1Overlay(token);
  if (tier === 1) {
    if (token.mesh) token.mesh.alpha = 1.0;
    else            token.alpha = 1.0;
  } else {
    const alpha = TIER_ALPHA[Math.min(tier, 4)];
    if (token.mesh)  token.mesh.alpha = alpha;
    else             token.alpha = alpha;
  }

  if (token.nameplate) token.nameplate.visible = tier >= 2;
  if (token.bars) token.bars.visible = tier >= 3;
}

/**
 * Force a token to be fully visible  -  own ship + friendly ordnance.
 * Sets every property that Foundry's render pipeline might hide.
 */
function _forceVisible(token) {
  token.visible = true;
  token.alpha = 1;
  if (token.mesh) {
    token.mesh.alpha = 1;
    token.mesh.visible = true;
  }
}

export function refreshTokenVisibility() {
  if (!canvas?.ready) return;

  const ship = ShipCombatState.ship;
  if (!ship) return;

  const ownToken = ship.getActiveTokens?.()?.[0];
  if (!ownToken) return;

  const gridSize = canvas.grid.size;
  const cx0 = ownToken.document.x + (ownToken.document.width  * gridSize) / 2;
  const cy0 = ownToken.document.y + (ownToken.document.height * gridSize) / 2;

  const locks   = SystemAdapter.current.getShipData(ship)?.resources?.sensors?.locks ?? [];
  const sensor  = ShipCombatState.getSensorStats();
  const ghRange = sensor.autoScanRange ?? 0;

  const outlineFilter = _getOutlineFilter();

  for (const token of canvas.tokens.placeables) {
    if (token.document.actor?.id === ship.id) {
      // Own ship: always visible to crew (Observer+) regardless of hidden flag
      _forceVisible(token);
      continue;
    }

    // Friendly ordnance: always fully visible (Lock 4 equivalent)
    const actorType = token.document.actor?.type;
    if (isOrdnance(token.document.actor)) {
      const parentTokenId = SystemAdapter.current.getShipData(token.document.actor)?.parentShipTokenId;
      if (parentTokenId && parentTokenId === ownToken.id) {
        _forceVisible(token);
        continue;
      }
    }

    const actorId = token.document.actor?.id;
    if (!actorId) continue;

    // Distance in grid squares
    const cW = token.document.width  * gridSize;
    const cH = token.document.height * gridSize;
    const tx = token.document.x + cW / 2;
    const ty = token.document.y + cH / 2;
    const distSq = Math.sqrt((tx - cx0) ** 2 + (ty - cy0) ** 2) / gridSize;

    // Effective lock tier
    const explicitLock = locks.find(l => l.targetTokenId === token.id);
    const explicitTier = explicitLock?.tier ?? 0;
    const autoTier     = (ghRange > 0 && distSq <= ghRange) ? 2 : 0;
    const tier         = Math.max(explicitTier, autoTier);

    // ── Tier 0: fully hidden ──────────────────────────────────────
    // NPC ship tokens are created hidden by default (prototypeToken.hidden).
    // At tier 0 the token stays invisible to players.  GMs still see it via
    // Foundry's standard hidden-token translucency.
    if (tier === 0) {
      token.visible = game.user.isGM;
      _clearOutlineFilter(token, outlineFilter);
      _clearL1Overlay(token);
      if (token.mesh)  token.mesh.alpha = game.user.isGM ? 0.35 : 0;
      else             token.alpha      = game.user.isGM ? 0.35 : 0;
      if (token.nameplate) token.nameplate.visible = false;
      if (token.bars)      token.bars.visible = false;
      continue;
    }

    // Ensure visible for tier >= 1
    token.visible = true;

    // ── Tier 1+: clear overlays, show token art at full alpha ───
    _clearOutlineFilter(token, outlineFilter);
    _clearL1Overlay(token);
    if (tier === 1) {
      if (token.mesh) token.mesh.alpha = 1.0;
      else            token.alpha = 1.0;
    } else {
      // Tier 2-4: normal alpha
      const alpha = TIER_ALPHA[Math.min(tier, 4)];
      if (token.mesh)  token.mesh.alpha = alpha;
      else             token.alpha = alpha;
    }

    // Nameplate: visible at tier >= 2
    if (token.nameplate) token.nameplate.visible = tier >= 2;

    // Resource bars: visible at tier >= 3
    if (token.bars) token.bars.visible = tier >= 3;
  }
}

/**
 * Remove the outline filter from a token if present.
 */
function _clearOutlineFilter(token, outlineFilter) {
  if (!outlineFilter) return;
  const target = token.mesh ?? token;
  const filters = target.filters;
  if (filters && filters.includes(outlineFilter)) {
    target.filters = filters.filter(f => f !== outlineFilter);
  }
}
