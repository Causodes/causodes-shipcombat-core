/**
 * ShipSchemaMixin – system-agnostic data schema and computed data for player ship actors.
 *
 * Usage:
 *   import { ShipSchemaMixin } from ".../ShipSchema.js";
 *   export class ShipModel extends ShipSchemaMixin(AdapterBase) {}
 *
 * The `combat` SchemaField is NOT defined here. System modules extend this mixin
 * and add the `combat` field in their own `defineSchema()`.
 *
 * Hull convention: hull.value = accumulated damage (0 = pristine, max = destroyed).
 */

import { MODULE_ID } from "../../constants.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";

export const ShipSchemaMixin = (BaseClass) => class extends BaseClass {

  itemIsAllowed(item) {
    if (item.type === `${MODULE_ID}.component`) return true;
    ui.notifications.error("SHIPCOMBAT.Warning.OnlyComponents", { localize: true });
    return false;
  }

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // ── Combat meta ─────────────────────────────────────────────────────────
    schema.active         = new fields.BooleanField({ initial: false });
    schema.round          = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.crewSize       = new fields.NumberField({ initial: 6, min: 3, max: 6, integer: true });
    schema.useStrikeCraft = new fields.BooleanField({ initial: true });
    schema.crewScale      = new fields.StringField({ initial: "warship", choices: ["warship", "smallcraft"] });
    schema.roleTitles     = new fields.ObjectField({ initial: {} });

    // ── Bridge crew assignments ──────────────────────────────────────────────
    schema.roles              = new fields.ObjectField({ initial: {} });
    schema.roleSkillOverrides = new fields.ObjectField({ initial: {} });
    schema.crewActors         = new fields.ObjectField({ initial: {} });
    schema.ordnanceActors     = new fields.ObjectField({ initial: { torpedo: [], strikeCraft: [] } });

    const _sidesSchema = () => new fields.SchemaField({
      bow:       new fields.BooleanField({ initial: true }),
      port:      new fields.BooleanField({ initial: true }),
      starboard: new fields.BooleanField({ initial: true }),
      stern:     new fields.BooleanField({ initial: false }),
    });
    schema.ordnanceLaunchSides = new fields.SchemaField({
      torpedo:    _sidesSchema(),
      strikeCraft: _sidesSchema(),
    });

    schema.activeOrdnance = new fields.ArrayField(new fields.ObjectField(), { initial: [] });
    schema.assignedCores  = new fields.ObjectField({ initial: {} });
    schema.turnDone       = new fields.ObjectField({ initial: {} });
    schema.overchargeUsed = new fields.ObjectField({ initial: {} });

    // ── Role-specific resource pools ─────────────────────────────────────────
    schema.resources = new fields.ObjectField({ initial: {} });

    // ── Internal Fire condition severity ─────────────────────────────────────
    schema.internalFire = new fields.NumberField({ initial: 0, min: 0, integer: true });

    // ── Crit conditions ──────────────────────────────────────────────────────
    schema.conditions = new fields.SchemaField({
      hull:           new fields.ObjectField({ initial: {} }),
      engines:        new fields.ObjectField({ initial: {} }),
      manoeuvring:    new fields.ObjectField({ initial: {} }),
      coreSystems:    new fields.ObjectField({ initial: {} }),
      weaponsSensors: new fields.ObjectField({ initial: {} }),
    });

    // ── Hull ─────────────────────────────────────────────────────────────────
    schema.hull = new fields.SchemaField({
      value: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      max:   new fields.NumberField({ initial: 50, min: 0, integer: true }),
    });

    // ── Per-sector void shield integrity ─────────────────────────────────────
    schema.shields = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Void Shield Pool ─────────────────────────────────────────────────────
    schema.shieldPool = new fields.SchemaField({
      current:   new fields.NumberField({ initial: 0, min: 0, integer: true }),
      committed: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Core Bank ────────────────────────────────────────────────────────────
    schema.coreBank   = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.ventLocked = new fields.BooleanField({ initial: false });
    schema.ventPending = new fields.BooleanField({ initial: false });

    // ── Per-sector armour ─────────────────────────────────────────────────────
    schema.armour = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });
    schema.armourRend = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Slot configuration ───────────────────────────────────────────────────
    schema.weaponSlots = new fields.SchemaField({
      port:      new fields.NumberField({ initial: 1, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 1, min: 0, integer: true }),
      prow:      new fields.NumberField({ initial: 1, min: 0, integer: true }),
      dorsal:    new fields.NumberField({ initial: 1, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });
    schema.equipmentSlots = new fields.SchemaField({
      shields:    new fields.NumberField({ initial: 1, min: 0, integer: true }),
      armour:     new fields.NumberField({ initial: 1, min: 0, integer: true }),
      engine:     new fields.NumberField({ initial: 1, min: 0, integer: true }),
      sensor:     new fields.NumberField({ initial: 1, min: 0, integer: true }),
      reactor:    new fields.NumberField({ initial: 1, min: 0, integer: true }),
      weaponsBay: new fields.NumberField({ initial: 1, min: 0, integer: true }),
    });
    schema.ordnanceSlots = new fields.SchemaField({
      ordnance: new fields.NumberField({ initial: 1, min: 0, integer: true }),
    });

    // ── Notes ────────────────────────────────────────────────────────────────
    schema.notes = new fields.SchemaField({
      player: new fields.HTMLField({ initial: "" }),
      gm:     new fields.HTMLField({ initial: "" }),
    });

    // ── Ship Identity ─────────────────────────────────────────────────────────
    schema.classification = new fields.StringField({ initial: "" });
    schema.model          = new fields.StringField({ initial: "" });
    schema.shipFaction    = new fields.StringField({ initial: "" });
    schema.shipRole       = new fields.StringField({ initial: "" });
    schema.patron         = new fields.StringField({ initial: "" });

    // ── Movement ─────────────────────────────────────────────────────────────
    schema.movement = new fields.SchemaField({
      speed:           new fields.NumberField({ initial: 0, min: 0, integer: true }),
      maneuverability: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // NOTE: `combat` SchemaField is NOT defined here.
    // System modules define it in their concrete subclass.

    return schema;
  }

  computeBase() {
    SystemAdapter.current.initModelStubs(this);
  }

  computeDerived() {
    // Derive movement stats from the installed engine component (if any).
    const engine = this.parent?.items?.find(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "engine"
    );
    if (engine) {
      this.movement.speed           = engine.system.speed           ?? this.movement.speed;
      this.movement.maneuverability = engine.system.maneuverability ?? this.movement.maneuverability;
    }

    // Engine crit condition: −1/−2/−4 Speed
    const engineCondTier = this.conditions?.engines?.tier;
    if (engineCondTier) {
      const speedPenalty = { low: 1, medium: 2, high: 4 };
      this.movement.speed = Math.max(1, this.movement.speed - (speedPenalty[engineCondTier] ?? 0));
    }

    // Manoeuvring crit condition: −1/−2/−4 Maneuverability
    const manoCondTier = this.conditions?.manoeuvring?.tier;
    if (manoCondTier) {
      const manoPenalty = { low: 1, medium: 2, high: 4 };
      this.movement.maneuverability = Math.max(0, this.movement.maneuverability - (manoPenalty[manoCondTier] ?? 0));
    }

    // Sum armour from all equipped armour components, then subtract accumulated rend.
    const armourItems = this.parent?.items?.filter(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "armour"
    ) ?? [];
    for (const sector of ["bow", "stern", "port", "starboard"]) {
      const base = armourItems.reduce(
        (sum, item) => sum + (item.system.armourValues?.[sector] ?? 0), 0
      );
      this.armour[sector] = Math.max(0, base - (this.armourRend[sector] ?? 0));
    }

    // Translate hull damage to system-specific display fields.
    SystemAdapter.current.applyHullDisplay(this);
  }

  getOtherEffects()          { return []; }
  effectIsApplicable(_effect){ return true; }
  effectIncluded(_effect)    { return true; }
};
