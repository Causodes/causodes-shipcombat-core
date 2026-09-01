/**
 * BattleClarityPopup  -  Priority Target core action target picker.
 *
 * Lists all visible enemy/neutral tokens.  Only ships with Lock 1+ can be
 * designated; Lock 0 targets are shown but greyed out.
 */
import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { emitToGM }  from "../socket.js";
import { ShipCombatState } from "../state/ShipCombatState.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";
import { getContactDisplayName, isTargetableContactToken } from "../targeting/contact-intelligence.js";

// Lock tier palette (matches SensorRadar TIER_COLOUR)
const TIER_COLOUR = {
  0: "rgba(85,85,119,0.5)",
  1: "#ff7733",
  2: "#ff4444",
  3: "#dd44ff",
  4: "#44ccff",
};

function _effectiveTier(token, state) {
  const own = state.ship?.getActiveTokens?.()?.[0];
  const gs = canvas?.grid?.size;
  if (!own || !gs) return state.getLockTier(token.id);
  const tx = token.x + (token.document.width * gs) / 2;
  const ty = token.y + (token.document.height * gs) / 2;
  const sx = own.x + (own.document.width * gs) / 2;
  const sy = own.y + (own.document.height * gs) / 2;
  return state.getEffectiveLockTier(token.id, Math.hypot(tx - sx, ty - sy) / gs);
}

export class BattleClarityPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  constructor({ shipActor = null } = {}, options = {}) {
    super(options);
    this.shipActor = shipActor;
  }

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
    const state = ShipCombatState.forShip(this.shipActor);
    const data  = state.getData();

    // Gather enemy / neutral tokens visible on the scene
    const candidates = canvas.tokens?.placeables?.filter(
      token => isTargetableContactToken(token, this.shipActor),
    ) ?? [];

    const sortedContactIds = candidates.map(target => target.id).filter(Boolean).sort();
    const recommendedTargetId = data.resources?.sensors?.recommendedTargetId ?? null;
    const priorityTargetId = data.resources?.captain?.priorityTargetId ?? null;
    const targets = candidates.map(t => {
      const lockTier     = _effectiveTier(t, state);
      if (lockTier < 1) return null;   // Lock 0 targets not shown
      return {
        tokenId:      t.id,
        name:         getContactDisplayName(data, t.id, {
          currentTier: lockTier,
          realName: t.document.name ?? "Unknown",
          fallbackOrdinal: sortedContactIds.indexOf(t.id) + 1,
        }),
        img:          t.document.texture?.src ?? "icons/svg/mystery-man.svg",
        lockTier,
        bearing:      Math.round(t.document.rotation),
        lockLabel:    `L${lockTier}`,
        lockColour:   TIER_COLOUR[lockTier] ?? TIER_COLOUR[0],
        isRecommended: recommendedTargetId === t.id,
        isPriority: priorityTargetId === t.id,
      };
    }).filter(Boolean).sort((a, b) => Number(b.isRecommended) - Number(a.isRecommended) || b.lockTier - a.lockTier);

    return {
      ...context,
      targets,
      noTargets: targets.length === 0,
      markerPalette: SystemAdapter.current.targetMarkerPalette(),
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
    emitToGM("captainCoreAction", { actionId: "battleClarity", tokenId, shipActorId: this.shipActor?.id });
    this.close();
  }
}
