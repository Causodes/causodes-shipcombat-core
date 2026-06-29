/**
 * ShipSheetV2Mixin – system-agnostic AppV2 player ship actor sheet.
 *
 * Usage:
 *   import { ShipSheetV2Mixin } from ".../ShipSheetV2Mixin.js";
 *   export class ShipSheet extends ShipSheetV2Mixin(SystemAdapter.current.SheetBaseClass) {}
 *
 * DEFAULT_OPTIONS.classes is intentionally empty — the concrete class injects
 * system-specific CSS classes.
 *
 * @deprecated Use the named import `ShipSheetV2Mixin` instead of `ShipSheetMixin`.
 */

import { MODULE_ID } from "../../constants.js";
import { emitToGM } from "../../socket.js";

import { OVERVIEW_ACTIONS } from "../../roles/overview.js";
import { SHARED_ACTIONS } from "../../roles/shared.js";
import { PILOT_ACTIONS, helmUpdatePreview } from "../../roles/pilot.js";
import { ENGINEER_ACTIONS } from "../../roles/engineer.js";
import { SENSORS_ACTIONS } from "../../roles/sensors.js";
import { GUNNER_ACTIONS } from "../../roles/gunner.js";
import { ORDNANCE_ACTIONS } from "../../roles/ordnance.js";
import { CAPTAIN_ACTIONS } from "../../roles/captain.js";
import { HelmPreview } from "../../canvas/HelmPreview.js";
import { WeaponArcOverlay } from "../../canvas/WeaponArcOverlay.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";
import { SHIP_PARTS, SHIP_TABS } from "./parts.js";
import { ShipController } from "./ShipController.js";
export { getEffectiveSkillSpec } from "./ShipController.js";

// ── Mixin ─────────────────────────────────────────────────────────────────

export const ShipSheetV2Mixin = (BaseClass) => {
  class ShipSheetBase extends BaseClass {

    _resolveRoleForUser(user = game.user) {
      return this.controller.resolveRoleForUser(user);
    }

    get isEditable() { return true; }

    get controller() {
      if (!this._controller) this._controller = new ShipController(this);
      return this._controller;
    }

    static DEFAULT_OPTIONS = {
      // classes intentionally empty — concrete class provides system-specific classes
      classes: [],
      actions: {
        ...OVERVIEW_ACTIONS,
        ...SHARED_ACTIONS,
        ...PILOT_ACTIONS,
        ...ENGINEER_ACTIONS,
        ...SENSORS_ACTIONS,
        ...GUNNER_ACTIONS,
        ...ORDNANCE_ACTIONS,
        ...CAPTAIN_ACTIONS,
        openItem:            ShipSheetBase._onOpenItem,
        openOrdnanceActor:   ShipSheetBase._onOpenOrdnanceActor,
        removeOrdnanceActor: ShipSheetBase._onRemoveOrdnanceActor,
        clearOrdnanceSlot:   ShipSheetBase._onClearOrdnanceSlot,
        addToInventory:      ShipSheetBase._onAddToInventory,
        unassignWeapon:      ShipSheetBase._onUnassignWeapon,
        unassignEquipment:   ShipSheetBase._onUnassignEquipment,
      },
      position: { width: 720, height: 820 },
      defaultTab: "overview",
    };

    static PARTS = SHIP_PARTS;

    static TABS = SHIP_TABS;

    _getDisabledRoles() {
      return this.controller.getDisabledRoles();
    }

    _allowedParts() {
      return this.controller.allowedParts();
    }

    _configureRenderOptions(options) {
      super._configureRenderOptions(options);
      const allowed = this._allowedParts();
      options.parts = (options.parts ?? Object.keys(SHIP_PARTS))
        .filter(p => allowed.has(p));
    }

    _prepareTabs(options) {
      const superTabs = super._prepareTabs(options);
      const ctrlTabs  = this.controller.buildTabs();
      for (const key of Object.keys(superTabs)) {
        if (!ctrlTabs[key]) delete superTabs[key];
        else superTabs[key].label = ctrlTabs[key].label;
      }
      return superTabs;
    }

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      return Object.assign(context, await this.controller.buildContext(options));
    }
    // ── Actions ─────────────────────────────────────────────────────────────

    static _onOpenItem(event, target) {
      const row    = target.closest("[data-id]");
      const itemId = row?.dataset?.id;
      if (!itemId) return;
      this.actor.items.get(itemId)?.sheet?.render({ force: true });
    }

    static async _onOpenOrdnanceActor(event, target) {
      const row      = target.closest("[data-ordnance-id]");
      if (!row) return;
      const slotType = row.dataset.ordnanceSlot;
      const entryId  = row.dataset.ordnanceId;
      if (!slotType || !entryId) return;
      const entries = SystemAdapter.current.getShipData(this.actor).ordnanceActors?.[slotType] ?? [];
      const entry   = entries.find(e => e.id === entryId);
      if (!entry?.actorData) {
        const uuid = row.dataset.uuid;
        if (uuid) { const actor = await fromUuid(uuid); actor?.sheet?.render(true); }
        return;
      }
      const editData = foundry.utils.deepClone(entry.actorData);
      editData._id   = undefined;
      editData.name  = `[Edit] ${entry.name || editData.name || "Ordnance"}`;
      editData.flags = foundry.utils.mergeObject(editData.flags ?? {}, {
        [MODULE_ID]: { fromOrdnanceMaster: true, embeddedEdit: true },
      });
      const editActor = await Actor.create(editData);
      if (!editActor) return;
      // Restore the custom token texture that Actor.create normalises away.
      if (entry.tokenImg && editActor.prototypeToken?.texture?.src !== entry.tokenImg) {
        await editActor.update({ "prototypeToken.texture.src": entry.tokenImg });
      }
      const sheet = editActor.sheet;
      sheet.render(true);
      const shipActor = this.actor;
      const origClose = sheet.close.bind(sheet);
      let _closing = false;
      sheet.close = async (options) => {
        if (_closing) return origClose(options);
        _closing = true;
        const updatedData = editActor.toObject();
        if (updatedData.name?.startsWith("[Edit] ")) updatedData.name = updatedData.name.slice(7);
        delete updatedData._id;
        const currentEntries = SystemAdapter.current.getShipData(shipActor).ordnanceActors?.[slotType] ?? [];
        const newEntries = currentEntries.map(e =>
          e.id === entryId ? { ...e, actorData: updatedData, name: updatedData.name, img: updatedData.img, tokenImg: updatedData.prototypeToken?.texture?.src ?? null } : e
        );
        await shipActor.update({ [SystemAdapter.current.systemPath(`ordnanceActors.${slotType}`)]: newEntries });
        if (game.actors.has(editActor.id)) await editActor.delete();
        return origClose(options);
      };
    }

    static async _onRemoveOrdnanceActor(event, target) {
      if (!this.actor?.isOwner) return;
      const row      = target.closest("[data-ordnance-id]");
      const slotType = row?.dataset?.ordnanceSlot;
      const actorId  = row?.dataset?.ordnanceId;
      if (!slotType || !actorId) return;
      const existing = SystemAdapter.current.getShipData(this.actor).ordnanceActors?.[slotType] ?? [];
      return this.actor.update({ [SystemAdapter.current.systemPath(`ordnanceActors.${slotType}`)]: existing.filter(e => e?.id !== actorId) });
    }

    static async _onClearOrdnanceSlot(event, target) {
      if (!this.actor?.isOwner) return;
      const index = parseInt(target.dataset.slotIndex, 10);
      if (isNaN(index)) return;
      const existing = [...(SystemAdapter.current.getShipData(this.actor).activeOrdnance ?? [])];
      existing[index] = null;
      let end = existing.length;
      while (end > 0 && !existing[end - 1]) end--;
      return this.actor.update({ [SystemAdapter.current.systemPath("activeOrdnance")]: existing.slice(0, end) });
    }

    static async _onAddToInventory(event, target) {
      if (!this.actor?.isOwner) return;
      await this.actor.createEmbeddedDocuments("Item", [{
        type: `${MODULE_ID}.component`,
        name: game.i18n.localize("SHIPCOMBAT.Component.New"),
        system: { slot: "weapon", equipped: false },
      }]);
    }

    static async _onUnassignWeapon(event, target) {
      const row = target.closest("[data-id]");
      const id  = row?.dataset?.id;
      if (!id) return;
      emitToGM("unassignComponent", { itemId: id });
    }

    static async _onUnassignEquipment(event, target) {
      const row = target.closest("[data-id]");
      const id  = row?.dataset?.id;
      if (!id) return;
      emitToGM("unassignComponent", { itemId: id });
    }

    // ── Post-render wiring ─────────────────────────────────────────────────

    _prepareSubmitData(event, form, formData) {
      this.controller.applySystemPathRemap(formData);
      return super._prepareSubmitData(event, form, formData);
    }

    _onRender(context, options) {
      super._onRender?.(context, options);
      this.controller.onRender(this.element, context, options);
    }

    _updateHelmPreview() {
      if (this.tabGroups?.primary !== "pilot") { HelmPreview.hide(); return; }
      const myRole = this._resolveRoleForUser(game.user);
      if (myRole !== "pilot" && !game.user.isGM) return;
      helmUpdatePreview(this);
    }

    changeTab(tab, group, options = {}) {
      super.changeTab(tab, group, options);
      if (group === "primary") {
        const isHelmTab = tab === "pilot" || tab === "engineer3man";
        if (!isHelmTab) HelmPreview.hide();
        else this._updateHelmPreview();
        const arcBroadcast = !!(SystemAdapter.current.getShipData(this.actor).resources?.gunner?.arcOverlayActive);
        if (tab === "gunner" || arcBroadcast) WeaponArcOverlay.activate(this.actor);
        else WeaponArcOverlay.deactivate();
      }
    }

    // ── Drop handling ──────────────────────────────────────────────────────

    async _onDropActor(event, data) {
      const result = await this.controller.onDropActor(data, event);
      if (result === ShipController.DELEGATE_TO_SUPER) return super._onDropActor?.(event, data);
      return result;
    }

    async _onDropItem(event, data) {
      return this.controller.onDropItem(data, event);
    }

    async _onChangeInput(event) {
      const input = event.currentTarget;
      if (input.name?.startsWith("system.") && !input.dataset.native) {
        input.name = this.controller.remapInputName(input.name);
      }
      return super._onChangeInput(event);
    }
  }

  return ShipSheetBase;
};

/** @deprecated Use {@link ShipSheetV2Mixin} instead. */
export const ShipSheetMixin = ShipSheetV2Mixin;
