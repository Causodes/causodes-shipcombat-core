/**
 * ShipComponentSchemaMixin – system-agnostic data schema and computed properties
 * for the ship component item type.
 *
 * Usage:
 *   import { ShipComponentSchemaMixin } from ".../ShipComponentSchema.js";
 *   export class ShipComponentModel extends ShipComponentSchemaMixin(AdapterBase) {}
 *
 * This mixin defines all schema fields, static helpers, and computed getters.
 * There is no hull or combat field — components have no health pool — so no
 * adapter delegation is needed in computeDerived.
 */

export const ShipComponentSchemaMixin = (BaseClass) => class extends BaseClass {

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // ── Slot assignment ──────────────────────────────────────────────────
    schema.slot = new fields.StringField({
      initial: "weapon",
      choices: {
        weapon:      "SHIPCOMBAT.Slot.Weapon",
        shields:     "SHIPCOMBAT.Slot.Shields",
        armour:      "SHIPCOMBAT.Slot.Armour",
        engine:      "SHIPCOMBAT.Slot.Engine",
        sensor:      "SHIPCOMBAT.Slot.Sensor",
        reactor:     "SHIPCOMBAT.Slot.Reactor",
        weaponsBay:  "SHIPCOMBAT.Slot.WeaponsBay",
      },
    });

    // ── Header fields (shared by all slots) ───────────────────────────
    schema.quantity     = new fields.NumberField({ initial: 1, min: 0, integer: true });
    schema.cost         = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.slotCount    = new fields.NumberField({ initial: 1, min: 1, integer: true });
    schema.equipped     = new fields.BooleanField({ initial: true });
    schema.availability = new fields.StringField({ initial: "" });

    // ── Notes (player + GM) ──────────────────────────────────────────
    schema.notes = new fields.SchemaField({
      player: new fields.HTMLField({ initial: "" }),
      gm:     new fields.HTMLField({ initial: "" }),
    });

    // ── Weapon fields ─────────────────────────────────────────────────
    schema.weaponPosition = new fields.StringField({
      initial: "prow",
      choices: {
        flank:  "SHIPCOMBAT.Slot.Flank",
        prow:   "SHIPCOMBAT.Slot.Prow",
        dorsal: "SHIPCOMBAT.Slot.Dorsal",
        stern:  "SHIPCOMBAT.Slot.Stern",
      },
    });
    schema.weaponBay = new fields.StringField({
      initial: "port",
      choices: {
        port:      "SHIPCOMBAT.Slot.Port",
        starboard: "SHIPCOMBAT.Slot.Starboard",
      },
    });
    schema.resourceType = new fields.StringField({
      initial: "ammo",
      choices: {
        ammo:   "SHIPCOMBAT.WeaponResource.Ammo",
        heat:   "SHIPCOMBAT.WeaponResource.Heat",
        power:  "SHIPCOMBAT.WeaponResource.Power",
        none:   "SHIPCOMBAT.WeaponResource.None",
      },
    });
    schema.weaponCategory = new fields.StringField({
      initial: "",
      blank: true,
      choices: {
        "":               "SHIPCOMBAT.WeaponCategory.None",
        macrocannon:      "SHIPCOMBAT.WeaponCategory.Macrocannon",
        nova_cannon:      "SHIPCOMBAT.WeaponCategory.NovaCannon",
        railgun:          "SHIPCOMBAT.WeaponCategory.Railgun",
        pdc_projectile:   "SHIPCOMBAT.WeaponCategory.PdcProjectile",
        lance:            "SHIPCOMBAT.WeaponCategory.Lance",
        laser_pdc:        "SHIPCOMBAT.WeaponCategory.LaserPdc",
        melta:            "SHIPCOMBAT.WeaponCategory.Melta",
        plasma:           "SHIPCOMBAT.WeaponCategory.Plasma",
        missile:          "SHIPCOMBAT.WeaponCategory.Missile",
      },
    });
    schema.damage       = new fields.NumberField({ initial: 0, integer: true });
    schema.salvoSize    = new fields.NumberField({ initial: 1, min: 1, integer: true });
    schema.chargeStep   = new fields.NumberField({ initial: 5, min: 1, integer: true });
    schema.range        = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.degreeOfFire = new fields.NumberField({ initial: 0, min: 0, max: 360, integer: true });

    // ── Structured weapon traits ──────────────────────────────────────────
    schema.traits = new fields.SchemaField({
      shieldBypass:      new fields.BooleanField({ initial: false }),
      unlimitedRof:      new fields.BooleanField({ initial: false }),
      shieldBurn:        new fields.NumberField({ initial: 0, min: 0, integer: true }),
      shieldBurnEnabled: new fields.BooleanField({ initial: false }),
      rend:              new fields.NumberField({ initial: 0, min: 0, integer: true }),
      rendEnabled:       new fields.BooleanField({ initial: false }),
      armourPenetration: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      armourPenetrationEnabled: new fields.BooleanField({ initial: false }),
      devastating:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      devastatingEnabled: new fields.BooleanField({ initial: false }),
      unreliable:        new fields.BooleanField({ initial: false }),
      overcharge:        new fields.BooleanField({ initial: false }),
      hitRatingModifier: new fields.NumberField({ initial: 0, integer: true }),
      hitRatingModifierEnabled: new fields.BooleanField({ initial: false }),
    });

    // ── Shield fields ─────────────────────────────────────────────────
    schema.maxVoidFlux     = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.zoneThresholds  = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Armour fields ─────────────────────────────────────────────────
    schema.armourValues = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Engine fields ─────────────────────────────────────────────────
    schema.speed              = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.maneuverability    = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.powerPerAP         = new fields.NumberField({ initial: 0, min: 0, integer: true });

    // ── Sensor fields ────────────────────────────────────────────────
    schema.rating             = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.bandSize           = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.autoScanRange      = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.maxRange           = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.guaranteedHitRange = new fields.NumberField({ initial: 0, min: 0, integer: true });

    // ── Reactor fields ──────────────────────────────────────────────────
    schema.shieldStrengthPerCore = new fields.NumberField({ initial: 5, min: 0, integer: true });
    schema.heatCapacity          = new fields.NumberField({ initial: 10, min: 0, integer: true });
    schema.bankCapacity          = new fields.NumberField({ initial: 40, min: 0, integer: true });
    schema.reserveMultiplier     = new fields.NumberField({ initial: 1, min: 0, integer: true });

    // ── Torpedo component fields ────────────────────────────────────────
    schema.torpedoFuel           = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.torpedoSpeed          = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.torpedoManeuverability = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.torpedoSalvo          = new fields.NumberField({ initial: 1, min: 1, integer: true });
    schema.torpedoPayloadDamage  = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.torpedoPayloadRadius  = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.torpedoTraits = new fields.SchemaField({
      shieldBypass:      new fields.BooleanField({ initial: false }),
      shieldBurn:        new fields.NumberField({ initial: 0, min: 0, integer: true }),
      shieldBurnEnabled: new fields.BooleanField({ initial: false }),
      rend:              new fields.NumberField({ initial: 0, min: 0, integer: true }),
      rendEnabled:       new fields.BooleanField({ initial: false }),
      armourPenetration: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      armourPenetrationEnabled: new fields.BooleanField({ initial: false }),
    });

    // ── Strike Craft component fields ──────────────────────────────────
    schema.craftFuel             = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.craftSpeed            = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.craftManeuverability  = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.craftType = new fields.StringField({
      initial: "fighter",
      choices: {
        fighter: "SHIPCOMBAT.CraftType.Fighter",
        bomber:  "SHIPCOMBAT.CraftType.Bomber",
      },
    });
    schema.craftPayloadDamage    = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.craftPayloadRadius    = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.craftPayloadCount     = new fields.NumberField({ initial: 1, min: 1, integer: true });
    schema.craftFlightSize       = new fields.NumberField({ initial: 3, min: 1, integer: true });
    schema.craftSensorRating     = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.craftTraits = new fields.SchemaField({
      shieldBypass:      new fields.BooleanField({ initial: false }),
      shieldBurn:        new fields.NumberField({ initial: 0, min: 0, integer: true }),
      shieldBurnEnabled: new fields.BooleanField({ initial: false }),
      rend:              new fields.NumberField({ initial: 0, min: 0, integer: true }),
      rendEnabled:       new fields.BooleanField({ initial: false }),
      armourPenetration: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      armourPenetrationEnabled: new fields.BooleanField({ initial: false }),
    });

    // ── Ordnance Bay component fields ────────────────────────────────────
    schema.bayMaxFlights      = new fields.NumberField({ initial: 2, min: 0, integer: true });
    schema.bayManpower        = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.bayAmmoCapacity    = new fields.NumberField({ initial: 20, min: 0, integer: true });
    schema.bayChargeCapacity  = new fields.NumberField({ initial: 20, min: 0, integer: true });
    schema.bayTorpedoSalvoSize     = new fields.NumberField({ initial: 1, min: 1, integer: true });
    schema.bayTorpedoCapacity      = new fields.NumberField({ initial: 4, min: 0, integer: true });
    schema.bayStrikeCraftFlightSize = new fields.NumberField({ initial: 3, min: 1, integer: true });
    schema.bayStrikeCraftCapacity     = new fields.NumberField({ initial: 6, min: 0, integer: true });

    // ── Adapter-extended fields ──────────────────────────────────────────
    // System adapters may declare additional typed fields via
    // SystemAdapter.getComponentSchemaExtensions(componentType).  Those fields
    // are merged into `extended` so they live under system.extended.* and can
    // never collide with core fields.
    //
    // IM declares no extensions (returns {}), so this defaults to an empty
    // ObjectField that accepts any additional data a system adapter stores.
    schema.extended = new fields.ObjectField({ initial: {} });

    return schema;
  }

  get resource() {
    return this.resourceType;
  }

  static resourceForType(weaponTypeName) {
    const map = {
      macroCannon:  "ammo",
      plasmaCannon: "heat",
      lanceBattery: "power",
      pointDefense: "none",
    };
    return map[weaponTypeName] ?? "ammo";
  }

  get traitsHtml() {
    const t = this.slot === "torpedo" ? this.torpedoTraits
            : this.slot === "strikeCraft" ? this.craftTraits
            : this.traits;
    return this.constructor._formatTraits(t);
  }

  static _formatTraits(t) {
    if (!t) return "";
    const parts = [];
    if (t?.shieldBypass)                              parts.push(game.i18n.localize("SHIPCOMBAT.Trait.ShieldBypass"));
    if (t?.unlimitedRof)                              parts.push(game.i18n.localize("SHIPCOMBAT.Trait.UnlimitedRof"));
    if (t?.shieldBurn > 0 && t?.shieldBurnEnabled)    parts.push(`${game.i18n.localize("SHIPCOMBAT.Trait.ShieldBurn")} (${t.shieldBurn})`);
    if (t?.rend > 0 && t?.rendEnabled)                parts.push(`${game.i18n.localize("SHIPCOMBAT.Trait.Rend")} (${t.rend})`);
    if (t?.armourPenetration > 0 && t?.armourPenetrationEnabled)  parts.push(`${game.i18n.localize("SHIPCOMBAT.Trait.ArmourPenetration")} (${t.armourPenetration})`);
    if (t?.devastating > 0 && t?.devastatingEnabled)  parts.push(`${game.i18n.localize("SHIPCOMBAT.Trait.Devastating")} (${t.devastating})`);
    if (t?.unreliable)                                parts.push(game.i18n.localize("SHIPCOMBAT.Trait.Unreliable"));
    if (t?.overcharge)                                parts.push(game.i18n.localize("SHIPCOMBAT.Trait.Overcharge"));
    return parts.join(", ");
  }

  async summaryData() {
    return {
      notes: this.notes?.player ?? "",
      gmnotes: this.notes?.gm ?? "",
      details: { physical: "", item: {} },
      tags: [],
      summaryLabel: game.i18n.localize("SHIPCOMBAT.Component.Summary"),
    };
  }

  computeOwned(_actor) {}
  computeBase() {}
};
