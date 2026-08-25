/**
 * BattleClarityPopupV1  -  AppV1 equivalent of BattleClarityPopup.
 *
 * Selected automatically by Core's _popupClass() helper when the active adapter
 * sets `useApplicationV1 = true` (e.g. SF2e).
 */
import { CORE_MODULE_ID }
  from "../constants.js";
import { emitToGM }
  from "../socket.js";
import { ShipCombatState }
  from "../state/ShipCombatState.js";
import { getContactDisplayName } from "../targeting/contact-intelligence.js";

// ── Shared ───────────────────────────────────────────────────────────────────
// Lock tier colour palette used by BattleClarityPopupV1 (mirrors Core).
const TIER_COLOUR = {
  0: "rgba(85,85,119,0.5)",
  1: "#ff7733",
  2: "#ff4444",
  3: "#dd44ff",
  4: "#44ccff",
};

function _effectiveTier(token) {
  const own = ShipCombatState.ship?.getActiveTokens?.()?.[0];
  const gs = canvas?.grid?.size;
  if (!own || !gs) return ShipCombatState.getLockTier(token.id);
  const tx = token.x + (token.document.width * gs) / 2;
  const ty = token.y + (token.document.height * gs) / 2;
  const sx = own.x + (own.document.width * gs) / 2;
  const sy = own.y + (own.document.height * gs) / 2;
  return ShipCombatState.getEffectiveLockTier(token.id, Math.hypot(tx - sx, ty - sy) / gs);
}

// ── BattleClarityPopupV1 ─────────────────────────────────────────────────────

export class BattleClarityPopupV1 extends foundry.appv1.api.Application {

  _liveHooks  = null;
  _rerenderFn = null;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "shipcombat-battle-clarity-popup",
      classes:   ["shipcombat-targeting-popup"],
      template:  `modules/${CORE_MODULE_ID}/templates/apps/battle-clarity-popup.hbs`,
      title:     game.i18n.localize("SHIPCOMBAT.Captain.Core.BCTitle"),
      width:     360,
      height:    "auto",
      resizable: false,
    });
  }

  async getData(options = {}) {
    const context = await super.getData(options);

    const data    = ShipCombatState.getData();

    const candidates = canvas.tokens?.placeables?.filter(t => {
      if (!t.actor || !t.visible) return false;
      const disp = t.document.disposition;
      return disp === CONST.TOKEN_DISPOSITIONS.HOSTILE
          || disp === CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    }) ?? [];

    const sortedContactIds = candidates.map(target => target.id).filter(Boolean).sort();
    const recommendedTargetId = data.resources?.sensors?.recommendedTargetId ?? null;
    const priorityTargetId = data.resources?.captain?.priorityTargetId ?? null;
    const targets = candidates.map(t => {
      const lockTier = _effectiveTier(t);
      if (lockTier < 1) return null;
      return {
        tokenId:    t.id,
        name:       getContactDisplayName(data, t.id, {
          currentTier: lockTier,
          realName: t.document.name ?? "Unknown",
          fallbackOrdinal: sortedContactIds.indexOf(t.id) + 1,
        }),
        img:        t.document.texture?.src ?? "icons/svg/mystery-man.svg",
        lockTier,
        bearing:    Math.round(t.document.rotation),
        lockLabel:  `L${lockTier}`,
        lockColour: TIER_COLOUR[lockTier] ?? TIER_COLOUR[0],
        isRecommended: recommendedTargetId === t.id,
        isPriority: priorityTargetId === t.id,
      };
    }).filter(Boolean).sort((a, b) => Number(b.isRecommended) - Number(a.isRecommended) || b.lockTier - a.lockTier);

    return { ...context, targets, noTargets: targets.length === 0 };
  }

  activateListeners($html) {
    super.activateListeners($html);
    const html = $html[0];

    if (!this._liveHooks) {
      const _rerender = foundry.utils.debounce(() => {
        if (this.rendered) this.render();
      }, 100);
      this._liveHooks = [
        Hooks.on("updateActor", _rerender),
        Hooks.on("updateToken", _rerender),
      ];
      this._rerenderFn = _rerender;
    }

    html.querySelectorAll("[data-action='confirmDesignate']").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.preventDefault();
        const tokenId = btn.dataset.tokenId;
        if (!tokenId) return;
        emitToGM("captainCoreAction", { actionId: "battleClarity", tokenId });
        this.close();
      });
    });
  }

  async close(options = {}) {
    if (this._liveHooks) {
      Hooks.off("updateActor", this._rerenderFn);
      Hooks.off("updateToken", this._rerenderFn);
      this._liveHooks  = null;
      this._rerenderFn = null;
    }
    return super.close(options);
  }
}
