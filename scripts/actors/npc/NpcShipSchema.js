/**
 * NpcShipSchemaMixin – system-agnostic data schema and computed data for NPC ship actors.
 *
 * Usage:
 *   import { NpcShipSchemaMixin } from ".../NpcShipSchema.js";
 *   export class NpcShipModel extends NpcShipSchemaMixin(AdapterBase) {}
 *
 * The `combat` SchemaField (which contains system-specific display stubs such as
 * `action`, `initiative`, and `wounds`) is NOT defined here. System modules extend
 * this mixin and add the `combat` field in their own `defineSchema()`.
 *
 * Hull convention: hull.value = accumulated damage (0 = pristine, max = destroyed).
 * The system adapter translates this to system-specific display fields via
 * SystemAdapter.current.applyHullDisplay(this) called at the end of computeDerived().
 */

import { MODULE_ID } from "../../constants.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";

export const NpcShipSchemaMixin = (BaseClass) => class extends BaseClass {

  itemIsAllowed(item) {
    if (item.type === `${MODULE_ID}.component`) return true;
    ui.notifications.error("SHIPCOMBAT.Warning.OnlyComponents", { localize: true });
    return false;
  }

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // ── Ship Identity ─────────────────────────────────────────────────────
    schema.classification = new fields.StringField({ initial: "" });
    schema.model          = new fields.StringField({ initial: "" });
    schema.shipFaction    = new fields.StringField({ initial: "" });
    schema.shipRole       = new fields.StringField({ initial: "" });

    // ── Combat meta ─────────────────────────────────────────────────────────
    schema.active = new fields.BooleanField({ initial: false });
    schema.round  = new fields.NumberField({ initial: 0, min: 0, integer: true });

    // ── Hull ─────────────────────────────────────────────────────────────────
    // hull.value = accumulated damage (0 = pristine, max = destroyed)
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

    // ── Per-sector shield max (auto-fill each turn) ──────────────────────────
    schema.shieldMax = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Per-sector armour ─────────────────────────────────────────────────────
    schema.armour = new fields.SchemaField({
      bow:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
      stern:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
      port:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
      starboard: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    schema.armourBase = new fields.SchemaField({
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

    // ── Movement ─────────────────────────────────────────────────────────────
    schema.movement = new fields.SchemaField({
      speed:              new fields.NumberField({ initial: 0, min: 0, integer: true }),
      maneuverability:    new fields.NumberField({ initial: 0, min: 0, integer: true }),
      baseSpeed:          new fields.NumberField({ initial: 0, min: 0, integer: true }),
      baseManeuverability: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Heat & Internal Fire ─────────────────────────────────────────────────
    schema.heat         = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.heatMax      = new fields.NumberField({ initial: 10, min: 1, integer: true });
    schema.internalFire = new fields.NumberField({ initial: 0, min: 0, integer: true });

    // ── Crit conditions ──────────────────────────────────────────────────────
    schema.conditions = new fields.SchemaField({
      hull:           new fields.ObjectField({ initial: {} }),
      engines:        new fields.ObjectField({ initial: {} }),
      manoeuvring:    new fields.ObjectField({ initial: {} }),
      coreSystems:    new fields.ObjectField({ initial: {} }),
      weaponsSensors: new fields.ObjectField({ initial: {} }),
    });

    schema.engActionUsed = new fields.BooleanField({ initial: false });

    // ── Voidshield Flux ─────────────────────────────────────────────────────
    schema.voidshieldFlux          = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.voidshieldFluxRemaining = new fields.NumberField({ initial: 0, integer: true });

    // ── NPC Attributes ────────────────────────────────────────────────────────
    schema.attributes = new fields.SchemaField({
      piloting: new fields.NumberField({ initial: 40, integer: true }),
      tech:     new fields.NumberField({ initial: 40, integer: true }),
      gunnery:  new fields.NumberField({ initial: 40, integer: true }),
    });

    schema.autoScanRange  = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.sensorBandSize = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.sensorRating   = new fields.NumberField({ initial: 0, min: 0, integer: true });

    // ── Three ammo tracks ────────────────────────────────────────────────────
    schema.ammoTracks = new fields.SchemaField({
      a: new fields.SchemaField({
        label: new fields.StringField({ initial: "Macrocannon" }),
        value: new fields.NumberField({ initial: 0, min: 0, integer: true }),
        max:   new fields.NumberField({ initial: 10, min: 0, integer: true }),
      }),
      b: new fields.SchemaField({
        label: new fields.StringField({ initial: "Lance" }),
        value: new fields.NumberField({ initial: 0, min: 0, integer: true }),
        max:   new fields.NumberField({ initial: 10, min: 0, integer: true }),
      }),
      c: new fields.SchemaField({
        label: new fields.StringField({ initial: "Torpedo" }),
        value: new fields.NumberField({ initial: 0, min: 0, integer: true }),
        max:   new fields.NumberField({ initial: 10, min: 0, integer: true }),
      }),
    });

    // ── Slots ────────────────────────────────────────────────────────────────
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
      torpedo:     new fields.NumberField({ initial: 1, min: 0, integer: true }),
      strikeCraft: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      weaponsBay:  new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Ordnance templates ────────────────────────────────────────────────────
    schema.ordnanceActors = new fields.SchemaField({
      torpedo:     new fields.ArrayField(new fields.ObjectField()),
      strikeCraft: new fields.ArrayField(new fields.ObjectField()),
    });

    const _sidesSchema = () => new fields.SchemaField({
      bow:       new fields.BooleanField({ initial: true }),
      port:      new fields.BooleanField({ initial: true }),
      starboard: new fields.BooleanField({ initial: true }),
      stern:     new fields.BooleanField({ initial: true }),
    });
    schema.ordnanceLaunchSides = new fields.SchemaField({
      torpedo:    _sidesSchema(),
      strikeCraft: _sidesSchema(),
    });

    // ── Resources (helm + gunner state) ──────────────────────────────────────
    schema.resources = new fields.SchemaField({
      pilot: new fields.SchemaField({
        pilotingSL:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
        allocSpeed:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
        allocMano:        new fields.NumberField({ initial: 0, min: 0, integer: true }),
        allocEvasion:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
        fuelBurned:       new fields.NumberField({ initial: 0, min: 0, integer: true }),
        prevTurnMove:     new fields.NumberField({ initial: 0, min: 0, integer: true }),
        bearing:          new fields.NumberField({ initial: 0, integer: true }),
        bearingUsed:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
        momentumUsed:     new fields.NumberField({ initial: 0, min: 0 }),
        velocityX:        new fields.NumberField({ initial: 0 }),
        velocityY:        new fields.NumberField({ initial: 0 }),
        overdrive:        new fields.BooleanField({ initial: false }),
        helmResetId:      new fields.NumberField({ initial: 0, min: 0, integer: true }),
        pilotingMessageId: new fields.StringField({ initial: "" }),
        prowGunLocked:    new fields.BooleanField({ initial: false }),
        ramAllocLocked:   new fields.BooleanField({ initial: false }),
      }),
      gunner: new fields.SchemaField({
        ammo:             new fields.NumberField({ initial: 0,  min: 0, integer: true }),
        power:            new fields.NumberField({ initial: 0,  min: 0, integer: true }),
        ammoMax:          new fields.NumberField({ initial: 20, min: 1, integer: true }),
        powerMax:         new fields.NumberField({ initial: 20, min: 1, integer: true }),
        ordnanceSL:       new fields.NumberField({ initial: 0,  min: 0, integer: true }),
        allocAccuracy:    new fields.NumberField({ initial: 0,  min: 0, integer: true }),
        allocPenetration: new fields.NumberField({ initial: 0,  min: 0, integer: true }),
        allocFirepower:   new fields.NumberField({ initial: 0,  min: 0, integer: true }),
        ordnanceRolled:   new fields.BooleanField({ initial: false }),
        slLocked:         new fields.BooleanField({ initial: false }),
      }),
    });

    // ── Notes ────────────────────────────────────────────────────────────────
    schema.notes = new fields.SchemaField({
      gm: new fields.HTMLField({ initial: "" }),
    });

    // NOTE: `combat` SchemaField is NOT defined here.
    // System modules define it in their concrete subclass to add system-specific
    // display stubs (e.g. `action`, `initiative`, `wounds` for warhammer-lib).

    return schema;
  }

  // ── warhammer-lib / impmal interface stubs ──────────────────────────────
  computeBase() {
    SystemAdapter.current.initModelStubs(this);
  }

  computeDerived() {
    // Derive movement stats from installed engine component
    const engine = this.parent?.items?.find(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "engine"
    );
    if (engine) {
      this.movement.baseSpeed           = engine.system.speed           ?? this.movement.baseSpeed;
      this.movement.baseManeuverability = engine.system.maneuverability ?? this.movement.baseManeuverability;
    }

    this.movement.speed           = this.movement.baseSpeed;
    this.movement.maneuverability = this.movement.baseManeuverability;

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

    // Translate hull damage to system-specific display fields.
    // Hull convention: hull.value = accumulated damage (0 = pristine).
    SystemAdapter.current.applyHullDisplay(this);
  }

  getOtherEffects()          { return []; }
  effectIsApplicable(_effect){ return true; }
  effectIncluded(_effect)    { return true; }
};
