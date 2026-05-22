/**
 * OrdnanceSchemaMixin – system-agnostic data schema for ship ordnance actors
 * (torpedoes and strike craft).
 *
 * Usage:
 *   import { OrdnanceSchemaMixin } from ".../OrdnanceSchema.js";
 *   export class ShipOrdnanceModel extends OrdnanceSchemaMixin(AdapterBase) {}
 *
 * The hull display translation (core stores hull.value as accumulated damage;
 * system modules may expose a different field for their UI) is delegated to
 * SystemAdapter.current.applyHullDisplay(this) during computeDerived().
 */

import { SystemAdapter } from "../../systems/SystemAdapter.js";

export const OrdnanceSchemaMixin = (BaseClass) => class extends BaseClass {

  itemIsAllowed() {
    return false;
  }

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // ── Discriminator ──────────────────────────────────────────────────────
    // Must be set at creation time and should not be changed afterward.
    schema.subtype = new fields.StringField({
      initial: "",
      choices: ["torpedo", "strikeCraft"],
      blank: true,   // allow blank during template creation before type is known
    });

    // ── Hull ───────────────────────────────────────────────────────────────
    schema.hull = new fields.SchemaField({
      value: new fields.NumberField({ initial: 1, min: 0, integer: true }),
      max:   new fields.NumberField({ initial: 1, min: 0, integer: true }),
    });

    // ── Movement ──────────────────────────────────────────────────────────
    schema.movement = new fields.SchemaField({
      speed:           new fields.NumberField({ initial: 0, min: 0, integer: true }),
      maneuverability: new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Fuel (VU of movement remaining) ──────────────────────────────────
    schema.fuel = new fields.SchemaField({
      value: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      max:   new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    // ── Weapon Traits (shared) ────────────────────────────────────────────
    schema.traits = new fields.SchemaField({
      rend:              new fields.NumberField({ initial: 0, min: 0, integer: true }),
      armourPenetration: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      shieldBurn:        new fields.NumberField({ initial: 0, min: 0, integer: true }),
      shieldBypass:      new fields.BooleanField({ initial: false }),
    });

    // ── Helm state (shared) ───────────────────────────────────────────────
    schema.helm = new fields.SchemaField({
      bearing:      new fields.NumberField({ initial: 0, integer: true }),
      thrustPct:    new fields.NumberField({ initial: 0, min: 0, integer: true }),
      prevTurnMove: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      velocityX:    new fields.NumberField({ initial: 0 }),
      velocityY:    new fields.NumberField({ initial: 0 }),
      bearingUsed:  new fields.NumberField({ initial: 0, min: 0 }),
      momentumUsed: new fields.NumberField({ initial: 0, min: 0 }),
    });

    // ── Payload (shared fields — used by both torpedo and strike craft) ───
    schema.payloadDamage     = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.payloadDiceCount  = new fields.NumberField({ initial: null, nullable: true, min: 1, integer: true });
    schema.payloadDiceSize   = new fields.StringField({ initial: null, nullable: true, blank: true });
    schema.payloadDamageType = new fields.StringField({ initial: null, nullable: true, blank: true });
    schema.payloadRadius = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.armorClass    = new fields.NumberField({ initial: 10, nullable: true, integer: true });

    // ── Turn & parent tracking (shared) ──────────────────────────────────
    schema.turnComplete      = new fields.BooleanField({ initial: false });
    schema.parentShipTokenId = new fields.StringField({ initial: "" });

    // ── Torpedo-only fields ───────────────────────────────────────────────
    schema.designated       = new fields.BooleanField({ initial: false });
    schema.powerBoostActive = new fields.BooleanField({ initial: false });

    // ── Strike-craft-only fields ──────────────────────────────────────────
    schema.ammo = new fields.SchemaField({
      value: new fields.NumberField({ initial: 0, min: 0, integer: true }),
      max:   new fields.NumberField({ initial: 0, min: 0, integer: true }),
    });

    schema.craftType    = new fields.StringField({ initial: "fighter" });
    schema.payloadCount = new fields.NumberField({ initial: 1, min: 0, integer: true });
    schema.payloadAngle = new fields.NumberField({ initial: 120, min: 0, max: 360, integer: true });

    schema.autoScanRange  = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.sensorBandSize = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.sensorRating   = new fields.NumberField({ initial: 0, min: 0, integer: true });
    schema.detectionRadius = new fields.NumberField({ initial: 0, min: 0, integer: true });

    schema.rtb          = new fields.BooleanField({ initial: false });
    schema.pickupRadius = new fields.NumberField({ initial: 3, min: 0, integer: true });

    // ── Notes ─────────────────────────────────────────────────────────────
    schema.notes = new fields.SchemaField({
      player: new fields.HTMLField({ initial: "" }),
      gm:     new fields.HTMLField({ initial: "" }),
    });

    return schema;
  }

  initialize() {
    SystemAdapter.current.initModelStubs(this);
  }

  computeBase() {
    SystemAdapter.current.initModelStubs(this);
  }

  computeDerived() {
    // Delegate hull→display translation to the system adapter.
    // Hull convention: hull.value = accumulated damage (0 = pristine).
    SystemAdapter.current.applyHullDisplay(this);
  }
};
