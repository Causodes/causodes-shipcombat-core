/**
 * Overview page actions – end combat, advance round, full reset, hull adjustment.
 */
import { emitToGM } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

async function _onEndShipTurn() { emitToGM("endShipTurn", { shipActorId: this.actor.id }); }

async function _onAdvanceRound() { emitToGM("advanceRound", { shipActorId: this.actor.id }); }

async function _onEndCombat() {
  const ok = await foundry.applications.api.DialogV2.confirm({
    window:  { title: game.i18n.localize("SHIPCOMBAT.Dialog.EndCombat") },
    content: `<p>${game.i18n.localize("SHIPCOMBAT.Dialog.EndCombatBody")}</p>`,
  });
  if (ok) emitToGM("endCombat", {});
}

async function _onFullReset() {
  const ok = await foundry.applications.api.DialogV2.confirm({
    window:  { title: game.i18n.localize("SHIPCOMBAT.Dialog.FullReset") },
    content: `<p>${game.i18n.localize("SHIPCOMBAT.Dialog.FullResetBody")}</p>`,
  });
  if (ok) emitToGM("fullReset", { shipActorId: this.actor.id });
}

async function _onAdjustHull(event, target) {
  const delta   = Number(target.dataset.delta ?? 0);
  const sys     = SystemAdapter.current.getShipData(this.actor);
  const current = sys.hull?.value ?? 0;
  const max     = sys.hull?.max   ?? 0;
  const next    = Math.max(0, Math.min(max, current + delta));
  await emitToGM("updateResource", { roleId: "hull", key: "value", value: next, shipActorId: this.actor.id });
}

export const OVERVIEW_ACTIONS = {
  endShipTurn:  _onEndShipTurn,
  advanceRound: _onAdvanceRound,
  endCombat:    _onEndCombat,
  fullReset:    _onFullReset,
  adjustHull:   _onAdjustHull,
};
