/**
 * Shared action handlers used across multiple bridge-crew roles.
 * Includes captain, engineer, gunner, sensors, and generic resource actions.
 */
import { MODULE_ID } from "../constants.js";
import { emitToGM } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

// ── Item management ─────────────────────────────────────────────────────────

async function _onCreateItem(event, target) {
  if (!this.actor?.isOwner) return;
  const slot = target.dataset.componentSlot;
  if (!slot) return;

  const position = target.dataset.componentPosition;
  const system = { slot };
  if (slot === "weapon" && position) {
    if (position === "port" || position === "starboard") {
      system.weaponPosition = "flank";
      system.weaponBay = position;
    } else {
      system.weaponPosition = position;
    }
  }

  await this.actor.createEmbeddedDocuments("Item", [{
    type: `${MODULE_ID}.component`,
    name: game.i18n.localize("SHIPCOMBAT.Component.New"),
    system,
  }]);
}

async function _onDeleteEmbedded(event, target) {
  if (!this.actor?.isOwner) return;
  const row = target.closest("[data-id]");
  const id = target.dataset.id ?? row?.dataset.id;
  if (!id) return;
  const doc = this.actor.items.get(id);
  if (doc) await doc.delete();
}

// ── Role management ─────────────────────────────────────────────────────────

async function _onUnassignRole(event, target) {
  emitToGM("assignRole", { userId: null, roleId: target.dataset.roleId });
}

async function _onClaimRole(event, target) {
  const actor = game.user.character;
  const ref = actor ?? game.actors.find(a => a.isOwner && a.type === "character");
  emitToGM("assignRole", {
    userId: game.user.id,
    roleId: target.dataset.roleId,
    actorRef: ref ? {
      id: ref.id,
      uuid: ref.uuid,
      name: ref.name,
      img: ref.img,
    } : null,
  });
}

async function _onReleaseRole(event, target) {
  // Release the current user's own role by un-assigning via the roleId on the row
  emitToGM("assignRole", { userId: null, roleId: target.dataset.roleId });
}

// ── Captain ─────────────────────────────────────────────────────────────────

async function _onPerformStandard(event, target) {
  // Captain/crew generic "perform standard"  -  just marks the role's turn done
  const roleId = target.dataset.roleId;
  if (roleId) emitToGM("toggleTurnDone", { roleId });
}

async function _onPerformOvercharged(event, target) {
  const roleId = target.dataset.roleId;
  if (roleId) emitToGM("markOvercharge", { roleId });
}

// ── Engineer ───────────────────────────────────────────────────────────────

async function _onToggleCore(event, target) {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const roleId = target.dataset.roleId;
  if (!roleId) return;
  // Once dispatched (true) or core consumed this turn ("spent"), cannot toggle
  if (sys.assignedCores?.[roleId]) return;
  const hasStaged = !!(sys.resources?.engineer?.stagedCores?.[roleId]);
  emitToGM(hasStaged ? "unstagePowerCore" : "stagePowerCore", { targetRoleId: roleId });
}

// ── Sectors ─────────────────────────────────────────────────────────────────

async function _onAdjustSector(event, target) {
  const { sector, field, delta } = target.dataset;
  if (field !== "shields") return;
  const sys     = SystemAdapter.current.getShipData(this.actor);
  const current = sys.shields?.[sector] ?? 0;
  const pool    = sys.shieldPool?.current ?? 0;
  const d       = Number(delta);
  // When increasing, cannot exceed available pool; when decreasing, cannot go below 0
  if (d > 0 && pool <= 0) return;
  const next = Math.max(0, current + d);
  emitToGM("adjustShieldZone", { sector, value: next });
}


// ── Generic resource increment/decrement ────────────────────────────────────

async function _onIncrementResource(event, target) {
  const { roleId, key, max } = target.dataset;
  const sys     = SystemAdapter.current.getShipData(this.actor);
  const current = sys.resources?.[roleId]?.[key] ?? 0;
  const next    = Math.min(Number(max ?? Infinity), current + 1);
  emitToGM("updateResource", { roleId, key, value: next });
}

async function _onDecrementResource(event, target) {
  const { roleId, key } = target.dataset;
  const sys     = SystemAdapter.current.getShipData(this.actor);
  const current = sys.resources?.[roleId]?.[key] ?? 0;
  const next    = Math.max(0, current - 1);
  emitToGM("updateResource", { roleId, key, value: next });
}

async function _onMarkDone(event, target) {
  const roleId = target.dataset.roleId;
  if (!roleId) return;
  emitToGM("toggleTurnDone", { roleId });
}

// ── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Adjust a shield zone by delta without needing a synthetic DOM event.
 * Used by the scroll/click interaction on the arc compass.
 */
export function adjustShieldSectorDelta(sheet, sector, delta) {
  const sys     = SystemAdapter.current.getShipData(sheet.actor);
  const current = sys.shields?.[sector] ?? 0;
  const pool    = sys.shieldPool?.current ?? 0;
  if (delta > 0 && pool <= 0) return;
  const next = Math.max(0, current + delta);
  emitToGM("adjustShieldZone", { sector, value: next });
}

// ── Exported action map ─────────────────────────────────────────────────────

export const SHARED_ACTIONS = {
  createItem:         _onCreateItem,
  deleteEmbedded:     _onDeleteEmbedded,
  unassignRole:       _onUnassignRole,
  claimRole:          _onClaimRole,
  releaseRole:        _onReleaseRole,
  performStandard:    _onPerformStandard,
  performOvercharged: _onPerformOvercharged,
  toggleCore:         _onToggleCore,
  adjustSector:       _onAdjustSector,
  incrementResource:  _onIncrementResource,
  decrementResource:  _onDecrementResource,
  markDone:           _onMarkDone,
};
