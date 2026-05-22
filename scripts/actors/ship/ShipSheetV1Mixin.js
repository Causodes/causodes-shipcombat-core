/**
 * ShipSheetV1Mixin – system-agnostic AppV1 (legacy ActorSheet) ship actor sheet.
 *
 * Usage:
 *   import { ShipSheetV1Mixin } from ".../ShipSheetV1Mixin.js";
 *   export class ShipSheet extends ShipSheetV1Mixin(SystemAdapter.current.SheetBaseClassV1) {}
 *
 * `defaultOptions.classes` is intentionally empty — the concrete class appends
 * system-specific classes via its own `defaultOptions` override.
 *
 * The V1 mixin is a structural mirror of ShipSheetV2Mixin: both thin wrappers
 * that delegate all business logic to ShipController.
 */

import { CORE_MODULE_ID, hullDisplay } from "../../constants.js";
import { ShipController } from "./ShipController.js";
import { PILOT_ACTIONS, helmUpdatePreview } from "../../roles/pilot.js";
import { HelmPreview } from "../../canvas/HelmPreview.js";
import { WeaponArcOverlay } from "../../canvas/WeaponArcOverlay.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";
import { MODULE_ID } from "../../constants.js";
import { emitToGM }  from "../../socket.js";
import { OVERVIEW_ACTIONS } from "../../roles/overview.js";
import { SHARED_ACTIONS }   from "../../roles/shared.js";
import { ENGINEER_ACTIONS } from "../../roles/engineer.js";
import { CAPTAIN_ACTIONS }  from "../../roles/captain.js";
import { SENSORS_ACTIONS }  from "../../roles/sensors.js";
import { GUNNER_ACTIONS }   from "../../roles/gunner.js";
import { ORDNANCE_ACTIONS } from "../../roles/ordnance.js";

// ── Mixin ─────────────────────────────────────────────────────────────────

export const ShipSheetV1Mixin = (BaseClass) => {
  class ShipSheetV1Base extends BaseClass {

    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes:        [],   // concrete class adds system classes
        width:          720,
        height:         820,
        template:       `modules/${CORE_MODULE_ID}/templates/actor/ship-sheet-v1.hbs`,
        tabs:           [{ navSelector: ".sheet-navigation", contentSelector: ".sheet-content", initial: "overview" }],
        scrollY:        [".tab.active"],
        submitOnChange: true,
        closeOnSubmit:  false,
        dragDrop:       [{ dragSelector: "[data-drag]", dropSelector: null }],
      });
    }

    // ── Actions map (mirrors ShipSheetMixin.DEFAULT_OPTIONS.actions so that
    //    ShipController.dispatchAction() can resolve every [data-action] id). ──

    static DEFAULT_OPTIONS = {
      actions: {
        ...OVERVIEW_ACTIONS,
        ...SHARED_ACTIONS,
        ...PILOT_ACTIONS,
        ...ENGINEER_ACTIONS,
        ...SENSORS_ACTIONS,
        ...GUNNER_ACTIONS,
        ...ORDNANCE_ACTIONS,
        ...CAPTAIN_ACTIONS,
        openItem:            ShipSheetV1Base._onOpenItem,
        openOrdnanceActor:   ShipSheetV1Base._onOpenOrdnanceActor,
        removeOrdnanceActor: ShipSheetV1Base._onRemoveOrdnanceActor,
        clearOrdnanceSlot:   ShipSheetV1Base._onClearOrdnanceSlot,
        addToInventory:      ShipSheetV1Base._onAddToInventory,
        unassignWeapon:      ShipSheetV1Base._onUnassignWeapon,
        unassignEquipment:   ShipSheetV1Base._onUnassignEquipment,
      },
    };

    // ── Controller ──────────────────────────────────────────────────────────

    get controller() {
      if (!this._controller) this._controller = new ShipController(this);
      return this._controller;
    }

    // ── Shared action handlers (mirrors ShipSheetMixin static methods) ───────

    static _onOpenItem(event, target) {
      const row    = target.closest("[data-id]");
      const itemId = row?.dataset?.id;
      if (!itemId) return;
      this.actor.items.get(itemId)?.sheet?.render(true);
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

    // ── Data preparation ────────────────────────────────────────────────────

    async getData(options) {
      const base    = await super.getData(options);
      const ctx     = await this.controller.buildContext(options);
      const allowed = this.controller.allowedParts();
      const tabs    = this.controller.buildTabs();
      const context = Object.assign(base, ctx, {
        allowedParts:  allowed,
        partsArray:    [...allowed],   // for the wrapper template’s iteration
        tabs,        hullBarLabel:  hullDisplay(ctx.sys?.hull?.value ?? 0, ctx.sys?.hull?.max ?? 0).isDamageTaken
          ? game.i18n.localize("SHIPCOMBAT.Label.HullDamage")
          : game.i18n.localize("SHIPCOMBAT.Label.HullIntegrity"),        // tabsById: each tab template expects a `tab` context object with at least
        // { id, group, cssClass }.  We supply id and group; cssClass is always ""
        // because V1 shows/hides panels via CSS on the outer wrapper div, not via
        // the inner section’s class.  Passing tab.id fixes `data-tab="{{tab.id}}"`
        // inside the core tab shell templates (captain.hbs, pilot.hbs, …).
        tabsById: Object.fromEntries(
          [...allowed].map(id => [id, { id, group: "primary", cssClass: "" }])
        ),
      });
      // Stash for activateListeners (called after getData resolves)
      this._lastContext = context;
      return context;
    }

    // ── Listeners ───────────────────────────────────────────────────────────

    /**
     * V1 has no static actions map.  We use a single delegated click listener
     * that forwards every [data-action] click to the controller, plus the same
     * live-edit name-remap and post-render DOM wiring as the V2 mixin.
     */
    activateListeners($html) {
      super.activateListeners($html);

      // Universal data-action delegate
      $html.on("click", "[data-action]", async (event) => {
        const target = event.currentTarget;
        const id     = target.dataset.action;
        await this.controller.dispatchAction(id, event.originalEvent ?? event, target);
      });

      // Live-edit name remap (mirrors V2 _onChangeInput)
      $html.on("change", "input[name^='system.'], select[name^='system.']", (event) => {
        const input = event.currentTarget;
        if (input.dataset.native) return;
        input.name = this.controller.remapInputName(input.name);
      });

      // Post-render DOM wiring (helm preview, weapon arcs, sensor radar, …)
      this.controller.onRender($html[0], this._lastContext ?? {}, this.options);

      // Shrink-to-fit: defer one frame so the browser has computed layout for
      // newly-injected HTML before we measure scrollWidth / clientWidth.
      requestAnimationFrame(() => this._runShrinkToFit());
    }

    /**
     * Reset then shrink every roll-label element that overflows its container.
     * Must reset first so a label that was previously shrunk can grow back if
     * the text is now shorter (or a different skill was selected).
     */
    _runShrinkToFit() {
      const root = this.element instanceof jQuery ? this.element[0] : this.element;
      if (!root) return;
      for (const el of root.querySelectorAll(".sc-skill-name, .shipcombat-roll-piloting-btn")) {
        el.style.fontSize = ""; // reset to natural size; forces synchronous re-layout on next read
        if (el.scrollWidth <= el.clientWidth) continue;
        let fs = parseFloat(window.getComputedStyle(el).fontSize);
        while (el.scrollWidth > el.clientWidth && fs > 8) {
          fs -= 0.5;
          el.style.fontSize = `${fs}px`;
        }
      }
    }

    // ── Helm preview ────────────────────────────────────────────────────────

    _resolveRoleForUser(user = game.user) {
      return this.controller.resolveRoleForUser(user);
    }

    _updateHelmPreview() {
      // V1 tracks active tab via this._tabs[0]?.active (not tabGroups)
      if (this._tabs?.[0]?.active !== "pilot") { HelmPreview.hide(); return; }
      const myRole = this._resolveRoleForUser(game.user);
      if (myRole !== "pilot" && !game.user.isGM) return;
      helmUpdatePreview(this);
    }

    // ── Tab change (V1 hook — mirrors V2 changeTab) ─────────────────────────

    _onChangeTab(event, tabs, active) {
      super._onChangeTab?.(event, tabs, active);
      // Update the panel-title span if the template provides one (e.g. SF2e wrapper)
      const sheetEl = this.element instanceof jQuery ? this.element[0] : this.element;
      const panelTitle = sheetEl?.querySelector?.(".sheet-navigation .panel-title");
      if (panelTitle) {
        const tabDef = this.controller.buildTabs()[active];
        if (tabDef) panelTitle.textContent = game.i18n.localize(tabDef.label);
      }
      const isHelmTab = active === "pilot" || active === "engineer3man";
      if (!isHelmTab) HelmPreview.hide();
      else this._updateHelmPreview();
      const arcBroadcast = !!(SystemAdapter.current.getShipData(this.actor).resources?.gunner?.arcOverlayActive);
      const GUNNER_TABS  = new Set(["gunner", "gunner4man", "gunner5man"]);
      if (GUNNER_TABS.has(active) || arcBroadcast) WeaponArcOverlay.activate(this.actor);
      else WeaponArcOverlay.deactivate();
      // The newly-active tab panel is now visible; re-run shrink-to-fit so
      // labels that were in a hidden panel (scrollWidth/clientWidth both 0) get
      // correctly sized now that the browser can measure them.
      requestAnimationFrame(() => this._runShrinkToFit());
    }

    // ── Form submission ──────────────────────────────────────────────────────

    async _updateObject(event, formData) {
      this.controller.applySystemPathRemap(formData);
      return super._updateObject(event, formData);
    }

    // ── Drop handling ───────────────────────────────────────────────────────
    // Note: V1 arg order is _onDropActor(event, data) / _onDropItem(event, data)
    // which is the OPPOSITE of V2's _onDropActor(data, event).

    async _onDropActor(event, data) {
      const result = await this.controller.onDropActor(data, event);
      if (result === ShipController.DELEGATE_TO_SUPER) return super._onDropActor?.(event, data);
      return result;
    }

    async _onDropItem(event, data) {
      return this.controller.onDropItem(data, event);
    }
  }

  return ShipSheetV1Base;
};
