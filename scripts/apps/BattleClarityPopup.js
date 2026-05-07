/**
 * BattleClarityPopup  -  Battle Clarity core action target picker.
 *
 * Lists all visible enemy/neutral tokens.  Only ships with Lock 1+ can be
 * designated; Lock 0 targets are shown but greyed out.
 */
import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { emitToGM }  from "../socket.js";
import { ShipCombatState } from "../state/ShipCombatState.js";

// Lock tier palette (matches SensorRadar TIER_COLOUR)
const TIER_COLOUR = {
  0: "rgba(85,85,119,0.5)",
  1: "#ff7733",
  2: "#ff4444",
  3: "#dd44ff",
  4: "#44ccff",
};

export class BattleClarityPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  static DEFAULT_OPTIONS = {
    id: "shipcombat-battle-clarity-popup",
    classes: ["shipcombat-targeting-popup"],
    tag: "div",
    window: {
      title: "SHIPCOMBAT.Captain.Core.BCTitle",
      resizable: false,
    },
    position: { width: 360, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/battle-clarity-popup.hbs` },
  };

  static ACTIONS = {
    confirmDesignate: BattleClarityPopup._onConfirmDesignate,
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    // Sensor lock data from combat state
    const data  = ShipCombatState.getData();
    const locks = data?.resources?.sensors?.locks ?? [];
    const lockMap = new Map(locks.map(l => [l.targetTokenId, l.tier ?? 0]));

    // Gather enemy / neutral tokens visible on the scene
    const candidates = canvas.tokens?.placeables?.filter(t => {
      if (!t.actor || !t.visible) return false;
      const disp = t.document.disposition;
      return disp === CONST.TOKEN_DISPOSITIONS.HOSTILE
          || disp === CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    }) ?? [];

    const targets = candidates.map(t => {
      const lockTier     = lockMap.get(t.id) ?? 0;
      if (lockTier < 1) return null;   // Lock 0 targets not shown
      return {
        tokenId:      t.id,
        name:         t.document.name ?? "Unknown",
        img:          t.document.texture?.src ?? "icons/svg/mystery-man.svg",
        lockTier,
        bearing:      Math.round(t.document.rotation),
        lockLabel:    `L${lockTier}`,
        lockColour:   TIER_COLOUR[lockTier] ?? TIER_COLOUR[0],
      };
    }).filter(Boolean).sort((a, b) => b.lockTier - a.lockTier);

    return {
      ...context,
      targets,
      noTargets: targets.length === 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // ── Live lock-tier refresh ─────────────────────────────────────────────
    // Re-render when the ship actor updates (lock tiers stored in system data)
    // or when tokens move (changes distances / visibility).
    if (!this._liveHooks) {
      const _rerender = foundry.utils.debounce(() => {
        if (this.rendered) this.render();
      }, 100);
      this._liveHooks = [
        Hooks.on("updateActor",  _rerender),
        Hooks.on("updateToken",  _rerender),
      ];
      this._rerenderFn = _rerender;
    }
  }

  _onClose(options) {
    if (this._liveHooks) {
      Hooks.off("updateActor", this._rerenderFn);
      Hooks.off("updateToken", this._rerenderFn);
      this._liveHooks = null;
      this._rerenderFn = null;
    }
    super._onClose?.(options);
  }

  static async _onConfirmDesignate(event, element) {
    const tokenId = element.dataset.tokenId;
    if (!tokenId) return;
    emitToGM("captainCoreAction", { actionId: "battleClarity", tokenId });
    this.close();
  }
}
