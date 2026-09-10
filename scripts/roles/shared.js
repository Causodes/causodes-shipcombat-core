/**
 * Shared action handlers used across multiple bridge-crew roles.
 * Includes captain, engineer, gunner, sensors, and generic resource actions.
 */
import { MODULE_ID } from "../constants.js";
import { createActionRequester } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const requestGM = createActionRequester(context => context.actor);

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
  requestGM(this, "assignRole", { userId: null, roleId: target.dataset.roleId });
}

async function _onClaimRole(event, target) {
  const actor = game.user.character;
  const ref = actor ?? game.actors.find(a => a.isOwner && a.type === "character");
  requestGM(this, "assignRole", {
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
  requestGM(this, "assignRole", { userId: null, roleId: target.dataset.roleId });
}

// ── Captain ─────────────────────────────────────────────────────────────────

async function _onPerformStandard(event, target) {
  // Captain/crew generic "perform standard"  -  just marks the role's turn done
  const roleId = target.dataset.roleId;
  if (roleId) requestGM(this, "toggleTurnDone", { roleId });
}

async function _onPerformOvercharged(event, target) {
  const roleId = target.dataset.roleId;
  if (roleId) await requestGM(this, "consumePowerCore", { roleId });
}

// ── Engineer ───────────────────────────────────────────────────────────────

async function _onToggleCore(event, target) {
  const sys = SystemAdapter.current.getShipData(this.actor);
  const roleId = target.dataset.roleId;
  if (!roleId) return;
  // Once dispatched, the Engineer cannot assign another core to this role.
  if (sys.assignedCores?.[roleId]) return;
  const hasStaged = !!(sys.resources?.engineer?.stagedCores?.[roleId]);
  if (hasStaged) {
    return requestGM(this, "unstagePowerCore", { targetRoleId: roleId });
  }
  return requestGM(this, "stagePowerCore", { targetRoleId: roleId });
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
  requestGM(this, "adjustShieldZone", { sector, value: next });
}


// ── Generic resource increment/decrement ────────────────────────────────────

async function _onIncrementResource(event, target) {
  const { roleId, key, max } = target.dataset;
  await requestGM(this, "adjustResources", {
    adjustments: [{ roleId, key, delta: 1, max: Number(max ?? Infinity) }],
  });
}

async function _onDecrementResource(event, target) {
  const { roleId, key } = target.dataset;
  await requestGM(this, "adjustResources", {
    adjustments: [{ roleId, key, delta: -1, min: 0 }],
  });
}

async function _onMarkDone(event, target) {
  const roleId = target.dataset.roleId;
  if (!roleId) return;
  requestGM(this, "toggleTurnDone", { roleId });
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
  requestGM(sheet, "adjustShieldZone", { sector, value: next });
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
