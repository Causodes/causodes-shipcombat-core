/**
 * ShipComponentSheetMixin – system-agnostic sheet for ship component items.
 *
 * Usage:
 *   import { ShipComponentSheetMixin } from ".../ShipComponentSheetMixin.js";
 *   export class ShipComponentSheet extends ShipComponentSheetMixin(ItemSheetBaseClass) {}
 *
 * DEFAULT_OPTIONS.classes is intentionally empty in the mixin so the concrete
 * class can inject system-specific CSS classes without duplication.
 */

import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const ZONE_KEYS = ["bow", "stern", "port", "starboard"];

const WEAPON_TRAITS = [
  { key: "shieldBypass",      hasValue: false },
  { key: "unlimitedRof",      hasValue: false },
  { key: "shieldBurn",        hasValue: true,  enabledKey: "shieldBurnEnabled" },
  { key: "rend",              hasValue: true,  enabledKey: "rendEnabled" },
  { key: "armourPenetration", hasValue: true,  enabledKey: "armourPenetrationEnabled" },
  { key: "devastating",       hasValue: true,  enabledKey: "devastatingEnabled" },
  { key: "unreliable",        hasValue: false },
  { key: "overcharge",        hasValue: false },
  { key: "hitRatingModifier", hasValue: true, allowNegative: true, enabledKey: "hitRatingModifierEnabled" },
];
const ORDNANCE_TRAITS = [
  { key: "shieldBypass",      hasValue: false },
  { key: "shieldBurn",        hasValue: true,  enabledKey: "shieldBurnEnabled" },
  { key: "rend",              hasValue: true,  enabledKey: "rendEnabled" },
  { key: "armourPenetration", hasValue: true,  enabledKey: "armourPenetrationEnabled" },
];

function _weaponTraitsDisplayHtml(traits) {
  const parts = [];
  for (const def of WEAPON_TRAITS) {
    const raw = traits?.[def.key];
    const active = def.hasValue
      ? (raw > 0 && (def.enabledKey ? traits[def.enabledKey] : true))
      : raw;
    if (!active) continue;
    const name = game.i18n.localize(`SHIPCOMBAT.Trait.${def.key.charAt(0).toUpperCase() + def.key.slice(1)}`);
    const display = def.hasValue ? `${name} (${raw})` : name;
    parts.push(`<a data-key="${def.key}" data-value="${raw ?? ""}">${display}</a>`);
  }
  return parts.join(", ");
}

export const ShipComponentSheetMixin = (BaseClass) => {
  class ShipComponentSheetBase extends BaseClass {

    static DEFAULT_OPTIONS = {
      // classes intentionally empty — concrete class provides system-specific classes
      classes: [],
      defaultTab: "description",
      position: { width: 480, height: 500 },
      actions: {
        editWeaponTraits: ShipComponentSheetBase._onEditWeaponTraits,
      },
    };

    static PARTS = {
      header:      { template: `modules/${CORE_MODULE_ID}/templates/item/component-header.hbs` },
      tabs:        { template: "templates/generic/tab-navigation.hbs" },
      description: { template: `modules/${CORE_MODULE_ID}/templates/item/component-description.hbs`, scrollable: [""] },
      details:     { template: `modules/${CORE_MODULE_ID}/templates/item/component-details.hbs`, scrollable: [""] },
    };

    static TABS = {
      description: {
        id: "description",
        group: "primary",
        label: "SHIPCOMBAT.Tab.Description",
      },
      details: {
        id: "details",
        group: "primary",
        label: "SHIPCOMBAT.Tab.Details",
      },
    };

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const sys = this.item.system;

      const slotChoices = Object.entries(
        this.item.system.schema.fields.slot.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.slot,
      }));

      const slot     = sys.slot;
      const isWeapon      = slot === "weapon";
      const isShields     = slot === "shields";
      const isArmour      = slot === "armour";
      const isEngine      = slot === "engine";
      const isSensor      = slot === "sensor";
      const isReactor     = slot === "reactor";
      const isTorpedo     = slot === "torpedo";
      const isStrikeCraft = slot === "strikeCraft";
      const isWeaponsBay  = slot === "weaponsBay";

      const weaponPositionChoices = Object.entries(
        this.item.system.schema.fields.weaponPosition.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.weaponPosition,
      }));

      const resourceTypeChoices = Object.entries(
        this.item.system.schema.fields.resourceType.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.resourceType,
      }));

      const weaponBayChoices = Object.entries(
        this.item.system.schema.fields.weaponBay.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.weaponBay,
      }));

      const weaponCategoryChoices = Object.entries(
        this.item.system.schema.fields.weaponCategory.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === (sys.weaponCategory ?? ""),
      }));

      const isFlankWeapon = sys.weaponPosition === "flank";

      const zoneLabel = (key) => game.i18n.localize(`SHIPCOMBAT.Zone.${key.charAt(0).toUpperCase() + key.slice(1)}`);

      const shieldZones = ZONE_KEYS.map(key => ({
        key,
        label: zoneLabel(key),
        value: sys.zoneThresholds?.[key] ?? 8,
      }));

      const armourZones = ZONE_KEYS.map(key => ({
        key,
        label: zoneLabel(key),
        value: sys.armourValues[key],
      }));

      const availConfig = SystemAdapter.current.getAvailabilityOptions();
      const availabilityChoices = Object.entries(availConfig)
        .filter(([k]) => k !== "")
        .map(([value, labelKey]) => ({
          value,
          label: game.i18n.localize(labelKey),
          selected: value === sys.availability,
        }));

      const damageTypeChoices = isWeapon
        ? [
            { value: "", label: "—", selected: !sys.damageType },
            ...SystemAdapter.current.getDamageTypeChoices().map(c => ({
              ...c,
              selected: c.value === sys.damageType,
            })),
          ]
        : [];

      const traitsDisplayHtml = _weaponTraitsDisplayHtml(
        isTorpedo ? sys.torpedoTraits : isStrikeCraft ? sys.craftTraits : sys.traits
      );

      const craftTypeChoices = Object.entries(
        this.item.system.schema.fields.craftType.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.craftType,
      }));

      Object.assign(context, {
        sys,
        slotChoices,
        availabilityChoices,
        damageTypeChoices,
        isWeapon,
        isShields,
        isArmour,
        isEngine,
        isSensor,
        isReactor,
        isTorpedo,
        isStrikeCraft,
        isWeaponsBay,
        weaponPositionChoices,
        resourceTypeChoices,
        weaponBayChoices,
        weaponCategoryChoices,
        isFlankWeapon,
        traitsDisplayHtml,
        shieldZones,
        armourZones,
        craftTypeChoices,
        isOwner: this.item.isOwner,
      });
      return context;
    }

    async _handleEnrichment() {
      let enriched = { system: { notes: {} } };
      enriched.system.notes.player = await TextEditor.enrichHTML(this.item.system.notes.player, { async: true });
      enriched.system.notes.gm     = await TextEditor.enrichHTML(this.item.system.notes.gm, { async: true });
      return enriched;
    }

    static async _onEditWeaponTraits() {
      const sys    = this.item.system;
      const slot = sys.slot;
      let traitPath, traits, traitDefs;
      if (slot === "torpedo") {
        traitPath = "system.torpedoTraits";
        traits = sys.torpedoTraits ?? {};
        traitDefs = ORDNANCE_TRAITS;
      } else if (slot === "strikeCraft") {
        traitPath = "system.craftTraits";
        traits = sys.craftTraits ?? {};
        traitDefs = ORDNANCE_TRAITS;
      } else {
        traitPath = "system.traits";
        traits = sys.traits ?? {};
        traitDefs = WEAPON_TRAITS;
      }

      const rows = traitDefs.map(def => {
        const name    = game.i18n.localize(`SHIPCOMBAT.Trait.${def.key.charAt(0).toUpperCase() + def.key.slice(1)}`);
        const enabled = def.hasValue
          ? (def.enabledKey ? (traits[def.enabledKey] === true) : (traits[def.key] > 0))
          : (traits[def.key] === true);
        const val     = def.hasValue ? (traits[def.key] ?? 0) : 0;
        return `
          <div class="form-group">
            <label for="trait-${def.key}">${name}</label>
            <div class="form-fields">
              ${def.hasValue ? `<input type="number" name="${def.key}-value" value="${val}" ${def.allowNegative ? "" : `min="0"`} style="width:3.5rem;text-align:center">` : ""}
              <input type="checkbox" id="trait-${def.key}" name="${def.enabledKey ?? def.key}" ${enabled ? "checked" : ""}>
            </div>
          </div>`;
      }).join("");

      const result = await foundry.applications.api.DialogV2.prompt({
        window:  { title: game.i18n.localize("SHIPCOMBAT.Component.Traits") },
        content: `<div class="flexcol">${rows}</div>`,
        ok: { callback: (_ev, button) => new FormDataExtended(button.form).object },
      });
      if (!result) return;

      const updates = {};
      for (const def of traitDefs) {
        if (def.hasValue) {
          updates[`${traitPath}.${def.key}`] = Number(result[`${def.key}-value`] ?? 0);
          if (def.enabledKey) {
            updates[`${traitPath}.${def.enabledKey}`] = result[def.enabledKey] === true || result[def.enabledKey] === "on";
          }
        } else {
          updates[`${traitPath}.${def.key}`] = result[def.key] === true || result[def.key] === "on";
        }
      }
      this.item.update(updates);
    }
  }

  return ShipComponentSheetBase;
};

// ── AppV1 variant ────────────────────────────────────────────────────────────

/**
 * AppV1 Application version of the ship-component item sheet.
 *
 * Provides the same context data as ShipComponentSheetMixin._prepareContext()
 * plus the AppV2-compatible keys (`source`, `fields`, `enriched`) consumed by
 * the shared partial templates (component-description.hbs, component-details.hbs).
 *
 * Usage (in a system companion module):
 *   import { ShipComponentSheetV1Mixin } from ".../ShipComponentSheetMixin.js";
 *   export class ShipComponentSheet extends ShipComponentSheetV1Mixin(foundry.appv1.sheets.ItemSheet) {}
 */

/**
 * AppV1 dialog for editing weapon / ordnance traits.
 * Replaces the DialogV2-based _onEditWeaponTraits static action so the editor
 * window has its own persistent chrome (no transparent-background issue in
 * systems that style AppV1 windows only).
 *
 * @private – used only by ShipComponentSheetV1Mixin
 */
class _WeaponTraitsEditorV1 extends foundry.appv1.api.Application {
  /** @param {Item} item – The component item whose traits are being edited. */
  constructor(item) {
    super();
    this._item = item;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:       "shipcombat-weapon-traits-editor",
      title:    game.i18n.localize("SHIPCOMBAT.Component.Traits"),
      template: `modules/${CORE_MODULE_ID}/templates/item/weapon-traits-editor.hbs`,
      width:    380,
      height:   "auto",
    });
  }

  async getData(options = {}) {
    const context = await super.getData(options);
    const sys = this._item.system;
    const slot = sys.slot;

    let traitDefs, traits;
    if (slot === "torpedo") {
      traitDefs = ORDNANCE_TRAITS;
      traits    = sys.torpedoTraits ?? {};
    } else if (slot === "strikeCraft") {
      traitDefs = ORDNANCE_TRAITS;
      traits    = sys.craftTraits ?? {};
    } else {
      traitDefs = WEAPON_TRAITS;
      traits    = sys.traits ?? {};
    }

    const rows = traitDefs.map(def => {
      const name    = game.i18n.localize(`SHIPCOMBAT.Trait.${def.key.charAt(0).toUpperCase() + def.key.slice(1)}`);
      const enabled = def.hasValue
        ? (def.enabledKey ? (traits[def.enabledKey] === true) : (traits[def.key] > 0))
        : (traits[def.key] === true);
      const val = def.hasValue ? (traits[def.key] ?? 0) : 0;
      return { def, name, enabled, val };
    });

    return { ...context, rows, slot };
  }

  activateListeners($html) {
    super.activateListeners($html);
    $html.find("[data-action='saveTraits']").on("click", this._onSave.bind(this));
  }

  async _onSave(event) {
    event.preventDefault();
    const sys  = this._item.system;
    const slot = sys.slot;

    let traitPath, traitDefs;
    if (slot === "torpedo") {
      traitPath = "system.torpedoTraits";
      traitDefs = ORDNANCE_TRAITS;
    } else if (slot === "strikeCraft") {
      traitPath = "system.craftTraits";
      traitDefs = ORDNANCE_TRAITS;
    } else {
      traitPath = "system.traits";
      traitDefs = WEAPON_TRAITS;
    }

    const form   = this.element.find("form")[0];
    const result = new FormDataExtended(form).object;

    const updates = {};
    for (const def of traitDefs) {
      if (def.hasValue) {
        updates[`${traitPath}.${def.key}`] = Number(result[`${def.key}-value`] ?? 0);
        if (def.enabledKey) {
          updates[`${traitPath}.${def.enabledKey}`] = result[def.enabledKey] === true || result[def.enabledKey] === "on";
        }
      } else {
        updates[`${traitPath}.${def.key}`] = result[def.key] === true || result[def.key] === "on";
      }
    }
    await this._item.update(updates);
    this.close();
  }
}

export const ShipComponentSheetV1Mixin = (BaseClass) => {
  class ShipComponentSheetV1Base extends BaseClass {

    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        // classes intentionally empty — concrete class provides system-specific classes
        classes:        [],
        width:          480,
        height:         500,
        template:       `modules/${CORE_MODULE_ID}/templates/item/component-sheet-v1.hbs`,
        tabs:           [{ navSelector: ".component-sheet-tabs", contentSelector: ".component-sheet-body", initial: "description" }],
        scrollY:        [".tab.active"],
        submitOnChange: true,
        closeOnSubmit:  false,
      });
    }

    async getData(options = {}) {
      const base = await super.getData(options);
      const item = this.item;
      const sys  = item.system;

      // AppV2-compatible bindings expected by the shared partial templates
      const fields = sys.schema?.fields ?? {};
      const source = item._source ?? item.toObject();
      const enriched = {
        system: {
          notes: {
            player: await TextEditor.enrichHTML(sys.notes?.player ?? ""),
            gm:     await TextEditor.enrichHTML(sys.notes?.gm     ?? ""),
          },
        },
      };

      const slotChoices = Object.entries(
        sys.schema.fields.slot.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.slot,
      }));

      const slot         = sys.slot;
      const isWeapon     = slot === "weapon";
      const isShields    = slot === "shields";
      const isArmour     = slot === "armour";
      const isEngine     = slot === "engine";
      const isSensor     = slot === "sensor";
      const isReactor    = slot === "reactor";
      const isTorpedo    = slot === "torpedo";
      const isStrikeCraft = slot === "strikeCraft";
      const isWeaponsBay = slot === "weaponsBay";

      const weaponPositionChoices = Object.entries(
        sys.schema.fields.weaponPosition.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.weaponPosition,
      }));

      const resourceTypeChoices = Object.entries(
        sys.schema.fields.resourceType.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.resourceType,
      }));

      const weaponBayChoices = Object.entries(
        sys.schema.fields.weaponBay.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.weaponBay,
      }));

      const weaponCategoryChoices = Object.entries(
        sys.schema.fields.weaponCategory.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === (sys.weaponCategory ?? ""),
      }));

      const isFlankWeapon = sys.weaponPosition === "flank";

      const zoneLabel = (key) => game.i18n.localize(`SHIPCOMBAT.Zone.${key.charAt(0).toUpperCase() + key.slice(1)}`);

      const shieldZones = ZONE_KEYS.map(key => ({
        key,
        label: zoneLabel(key),
        value: sys.zoneThresholds?.[key] ?? 8,
      }));

      const armourZones = ZONE_KEYS.map(key => ({
        key,
        label: zoneLabel(key),
        value: sys.armourValues[key],
      }));

      const availConfig = SystemAdapter.current.getAvailabilityOptions();
      const availabilityChoices = Object.entries(availConfig)
        .filter(([k]) => k !== "")
        .map(([value, labelKey]) => ({
          value,
          label: game.i18n.localize(labelKey),
          selected: value === sys.availability,
        }));

      const damageTypeChoices = isWeapon
        ? [
            { value: "", label: "—", selected: !sys.damageType },
            ...SystemAdapter.current.getDamageTypeChoices().map(c => ({
              ...c,
              selected: c.value === sys.damageType,
            })),
          ]
        : [];

      const traitsDisplayHtml = _weaponTraitsDisplayHtml(
        isTorpedo ? sys.torpedoTraits : isStrikeCraft ? sys.craftTraits : sys.traits
      );

      const craftTypeChoices = Object.entries(
        sys.schema.fields.craftType.choices
      ).map(([value, labelKey]) => ({
        value,
        label: game.i18n.localize(labelKey),
        selected: value === sys.craftType,
      }));

      return {
        ...base,
        item,
        source,
        fields,
        enriched,
        sys,
        system: sys,
        cssClass:  this.isEditable ? "editable" : "locked",
        editable:  this.isEditable,
        limited:   item.limited,
        owner:     item.isOwner,
        user:      { isGM: game.user.isGM },
        tabsById: {
          description: { id: "description", cssClass: "" },
          details:     { id: "details",     cssClass: "" },
        },
        slotChoices,
        availabilityChoices,
        damageTypeChoices,
        isWeapon,
        isShields,
        isArmour,
        isEngine,
        isSensor,
        isReactor,
        isTorpedo,
        isStrikeCraft,
        isWeaponsBay,
        weaponPositionChoices,
        resourceTypeChoices,
        weaponBayChoices,
        weaponCategoryChoices,
        isFlankWeapon,
        traitsDisplayHtml,
        shieldZones,
        armourZones,
        craftTypeChoices,
        isOwner: item.isOwner,
      };
    }

    activateListeners($html) {
      super.activateListeners($html);
      if (!this.isEditable) return;
      $html.on("click", "[data-action='editWeaponTraits']", () => this._onEditWeaponTraits());
    }

    /** Open the weapon-traits editor.  Override in subclasses to substitute a system-specific dialog. */
    _onEditWeaponTraits() {
      new _WeaponTraitsEditorV1(this.item).render(true);
    }
  }

  return ShipComponentSheetV1Base;
};
