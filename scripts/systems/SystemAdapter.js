/**
 * SystemAdapter – abstract interface that isolates system-specific logic.
 *
 * Each TTRPG system (Imperium Maledictum, etc.) provides a concrete subclass
 * registered at module init.  All system-specific calls throughout the module
 * route through `SystemAdapter.current`.
 *
 * USAGE:
 *   import { SystemAdapter } from "./SystemAdapter.js";
 *   const adapter = SystemAdapter.current;
 *   await adapter.rollSkillTest(actor, "pilot");
 */

export class SystemAdapter {

  /* ── Registry ──────────────────────────────────────────────────────────── */

  /** @type {SystemAdapter|null} */
  static _current = null;

  /** Register the active adapter (called once at init). */
  static register(adapter) {
    if (!(adapter instanceof SystemAdapter))
      throw new Error("SystemAdapter.register() requires a SystemAdapter instance.");
    this._current = adapter;
  }

  /** @returns {SystemAdapter} */
  static get current() {
    if (!this._current) throw new Error("No SystemAdapter registered. Call SystemAdapter.register() during init.");
    return this._current;
  }

  /* ── Identity ──────────────────────────────────────────────────────────── */

  /** Human-readable system name for logging / tooltips. */
  get systemName() { throw new Error("Not implemented"); }

  /* ── Base classes ──────────────────────────────────────────────────────── */

  /**
   * Return the ApplicationV2 (or subclass) to use as the base for ShipSheet.
   * Must support warhammer-lib mixin interface if warhammer-lib is present.
   * @returns {typeof Application}
   */
  get SheetBaseClass() { throw new Error("Not implemented"); }

  /**
   * Return the base data-model class for actor models (e.g. BaseWarhammerActorModel).
   * @returns {typeof foundry.abstract.DataModel}
   */
  get ActorModelBaseClass() { throw new Error("Not implemented"); }

  /**
   * Return the base data-model class for item models.
   * @returns {typeof foundry.abstract.DataModel}
   */
  get ItemModelBaseClass() { throw new Error("Not implemented"); }

  /**
   * Return the ApplicationV2 (or subclass) to use as the base for item sheets.
   * @returns {typeof Application}
   */
  get ItemSheetBaseClass() { throw new Error("Not implemented"); }

  /* ── Skill tests ───────────────────────────────────────────────────────── */

  /**
   * Map a role-based skill key to whatever the underlying system requires.
   *
   * @param {"pilot"|"engineering"|"sensors"|"ordnance"|"leadership"|"navigation"} roleSkill
   * @returns {{ key: string, specialisation: string }} system-specific skill descriptor
   */
  resolveSkill(roleSkill) { throw new Error("Not implemented"); }

  /**
   * Invoke the system's roll workflow for a given crew actor.
   *
   * @param {Actor}  crewActor      – the character linked to the bridge role
   * @param {string} roleSkill      – abstract skill identifier (see resolveSkill)
   * @param {object} [options]      – extra options (modifier, fastForward, etc.)
   * @returns {Promise<{SL: number, succeeded: boolean, roll: Roll}>}
   */
  async rollSkillTest(crewActor, roleSkill, options = {}) { throw new Error("Not implemented"); }

  /* ── Initiative rolls ──────────────────────────────────────────────────── */

  /**
   * Generate the initiative roll for a ship-bound crew actor.
   * The engine only consumes the resulting numeric `total`; formula shape is
   * entirely up to the adapter.
   *
   * @param {Actor}  crewActor   – character linked to the bridge role
   * @param {string} roleSkill   – abstract role-skill key ("leadership", "pilot", ...)
   * @param {object} [options]   – { flavor: string, speaker: object }
   * @returns {Promise<{total: number, roll: Roll, message: ChatMessage|null}>}
   */
  async rollShipInitiative(crewActor, roleSkill, options = {}) { throw new Error("Not implemented"); }

  /**
   * Variant for NPC ships that store a raw numeric attribute rather than a
   * linked crew actor's skill tree. The formula is system-defined.
   *
   * @param {number} attributeValue  – e.g. `sys.attributes.piloting` (0–100 in IM)
   * @param {string} flavorLabel     – localized label for the chat card
   * @param {object} [options]       – { speaker: object }
   * @returns {Promise<{total: number, roll: Roll, message: ChatMessage|null}>}
   */
  async rollShipInitiativeFromAttribute(attributeValue, flavorLabel, options = {}) { throw new Error("Not implemented"); }

  /**
   * Translate the engine's raw initiative total into a Foundry Combatant
   * initiative value stored in the combat tracker. Most adapters return
   * `rawTotal` unchanged; PF2e divides by 10, WFRP packs a skill fraction
   * as the decimal part, etc.
   *
   * @param {number} rawTotal
   * @param {Actor}  shipActor
   * @returns {number}
   */
  toCombatantInitiative(rawTotal, _shipActor) { return rawTotal; }



  /**
   * Foundry roll formula used for unopposed/NPC rolls (salvo shots, automatic
   * strike-craft fire, etc.). d100 systems return "1d100"; d20 systems "1d20".
   *
   * @returns {string}
   */
  getRollFormula() { return "1d100"; }

  /**
   * Compute the engine's canonical Success Level pool from a raw Roll and
   * target number. Positive = success magnitude, zero/negative = failure margin.
   *
   * d100 (WFRP/IM): floor((target - roll.total) / 10).
   *
   * @param {Roll}   roll
   * @param {number} target
   * @returns {number}
   */
  computeSuccessLevel(roll, target) {
    return Math.floor((target - (roll?.total ?? 0)) / 10);
  }

  /**
   * Extract { SL, roll } from a chat message so reroll hooks can react to
   * post-hoc SL changes (fortune rerolls, etc.). Default reads warhammer-lib
   * shape `message.system.result`; override for other systems.
   *
   * @param {ChatMessage} message
   * @returns {{ SL: number|null, roll: Roll|null }}
   */
  parseRollResultFromMessage(message) {
    const sl   = message?.system?.result?.SL;
    const roll = message?.system?.result?.roll ?? null;
    return { SL: typeof sl === "number" ? sl : null, roll };
  }

  /**
   * True if the roll is an automatic critical hit independent of the target
   * (e.g. d100 "≤5 always crits"). Distinct from margin-based crits, which
   * live in `isCriticalHit()`.
   *
   * @param {Roll} roll
   * @returns {boolean}
   */
  isAutomaticCrit(roll) { return false; }

  /**
   * True if a hitting roll counts as a critical hit (matching tens/units,
   * natural 20, etc.). Hit/miss itself is decided by computeSuccessLevel >= 0.
   *
   * @param {Roll}   roll
   * @param {number} target
   * @returns {boolean}
   */
  isCriticalHit(roll, target) { return false; }

  /**
   * True if the roll counts as a weapon jam. The salvo resolver passes the
   * weapon's traits map so adapters can gate jamming on a trait flag.
   *
   * @param {Roll}   roll
   * @param {number} target
   * @param {object} traits
   * @returns {boolean}
   */
  isJam(roll, target, traits) { return false; }

  /* ── Sensor lock retention thresholds ──────────────────────────────────── */

  /**
   * Map a BDA / sensor-roll Success Level to a retained lock tier (0–4).
   * Tier 0 = lock lost, tier 4 = strongest lock. Default is a 1:1 clamp.
   *
   * @param {number} sl
   * @returns {number} tier in [0, 4]
   */
  getLockTierForSL(sl) {
    if (!Number.isFinite(sl)) return 0;
    return Math.max(0, Math.min(4, Math.floor(sl)));
  }

  /* ── Hit resolution ────────────────────────────────────────────────────── */

  /**
   * Magnitude of one accuracy step on this system's scale. Used everywhere a
   * fixed ±1-step bonus or penalty is applied (stance, lock tier, fire
   * correction, BDA, zone penalties). The engine uses half this value for
   * per-SL accuracy bonuses from gunner allocation.
   *
   *   d100 (IM, WFRP): 10
   *   d20 / PF2e:       1
   *
   * @returns {number}
   */
  getModifierStepSize() { return 1; }

  /**
   * Format an accuracy modifier for tooltips/chat. Default has no unit; IM
   * appends "%".
   *
   * @param {number} value
   * @returns {string}
   */
  formatModifier(value) {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value}`;
  }

  /**
   * Format a final target number for display. Default returns the bare
   * number; IM appends "%".
   *
   * @param {number} target
   * @returns {string}
   */
  formatTargetNumber(target) { return String(target); }

  /**
   * Hit decision for a single shot. Default is roll-under (correct for
   * WFRP/IM/GURPS); d20-style adapters override.
   *
   * @param {Roll}   roll
   * @param {number} target
   * @returns {boolean}
   */
  isHit(roll, target) { return (roll?.total ?? 0) <= target; }

  /**
   * Zone 1 (close scan / point-blank) accuracy bonus. In IM this halves the
   * miss chance: bonus = (100 − totalAccuracy) / 2. Non-percentile systems
   * return a flat bonus or 0.
   *
   * @param {number} totalAccuracy  accumulated accuracy *before* this bonus
   * @returns {number}
   */
  computeZone1Bonus(totalAccuracy) { return 0; }

  /**
   * Full hit resolution for a single fire event. The engine builds a
   * HitContext (base accuracy + named modifier list); the adapter rolls,
   * decides hit/miss, and returns the complete outcome including the chat
   * message and a display breakdown.
   *
   * The salvo loop instead uses the lighter primitives (`getRollFormula`,
   * `isHit`, `isCriticalHit`, `isJam`) for per-shot resolution.
   *
   * @param {object} context
   * @param {number}        context.baseAccuracy
   * @param {HitModifier[]} context.modifiers
   * @param {Item}          [context.weaponItem]
   * @param {Actor}         [context.targetActor]
   * @param {object}        [context.options]      { flavor, speaker, zone }
   * @returns {Promise<{hit: boolean, sl: number, roll: Roll, message: ChatMessage|null, displayTarget: number, breakdownParts: string[]}>}
   */
  async resolveHitRoll(context) { throw new Error("Not implemented"); }

  /* ── Role default skill mapping ────────────────────────────────────────── */

  /**
   * Default mapping from bridge role → main skill spec, used when no per-role
   * override is set in `system.roleSkillOverrides`.
   *
   * Returns a record keyed by roleId of
   *   { skillKey, specialisation, rootLabel, label }
   * where `skillKey|specialisation` is the engine's tuple shape, `label` is
   * an i18n key, and `rootLabel` is a fallback string.
   *
   * Default returns `{}` — adapters MUST override for any role that
   * participates in skill-allocation gameplay.
   *
   * @returns {Record<string, {skillKey: string, specialisation: string, rootLabel: string, label: string}>}
   */
  getDefaultRoleSkillMapping() { return {}; }

  /* ── Schema extensions ────────────────────────────────────────────────── */

  /**
   * Extra DataModel fields to merge into a component item's `extended`
   * SchemaField for the given component type. Called once per type when the
   * schema is first built. IM uses no extensions and returns `{}`; a PF2e
   * adapter might return `{ ac: new NumberField(...) }` for armour/engine
   * components.
   *
   * @param {string} componentType  slot string ("weapon", "armour", "engine", ...)
   * @returns {Record<string, foundry.data.fields.DataField>}
   */
  getComponentSchemaExtensions(componentType) { return {}; }

  /* ── System config access ──────────────────────────────────────────────── */

  /**
   * Return an object of { key: label } pairs for item availability dropdowns.
   * @returns {Record<string, string>}
   */
  getAvailabilityOptions() { return {}; }

  /* ── Model interface stubs ─────────────────────────────────────────────── */

  /**
   * Called during `computeBase()` on the actor model. Provide any interface
   * stubs the system expects to find on `actor.system` (characteristics, skills, etc.).
   * @param {object} model – the ShipModel instance
   */
  initModelStubs(model) {}

  /**
   * Called during `computeDerived()` on the actor model (after items resolved).
   * @param {object} model – the ShipModel instance
   */
  deriveModelData(model) {}

  /* ── Module identity ───────────────────────────────────────────────────── */

  /**
   * Configured module ID (e.g. "impmal-shipcombat").
   * @returns {string}
   */
  get moduleId() { throw new Error("Not implemented"); }

  /* ── Skill labels ──────────────────────────────────────────────────────── */

  /**
   * Return the localized display name for a skill key.
   * @param {string} key – system skill key (e.g. "tech", "piloting")
   * @returns {string} localized label
   */
  getSkillLabel(key) { return key; }

  /**
   * Return all selectable role-skill options for override dropdowns.
   * Each entry: { value, skillKey, specName, label }
   * @returns {Promise<Array<{value: string, skillKey: string, specName: string, label: string}>>}
   */
  async getRoleSkillOptions() { return []; }

  /* ── Crew eligibility ──────────────────────────────────────────────────── */

  /**
   * Return true if the given actor may be assigned as a crew member.
   * @param {Actor} actor
   * @returns {boolean}
   */
  isCrewActorEligible(actor) { return true; }

  /**
   * Translate the engine's hull damage representation into whatever the host
   * system's UI/integration layer expects (HealthEstimate, PF2e HP, ...).
   * Core stores `hull.value` as accumulated damage (0 = pristine, max =
   * destroyed). Default is a no-op.
   *
   * @param {object} model  the actor data model whose hull was just derived
   */
  applyHullDisplay(model) {}

  /**
   * CSS classes appended to DEFAULT_OPTIONS.classes on every ship/ordnance
   * sheet. Lets the adapter inject system-specific styling selectors.
   * @returns {string[]}
   */
  get sheetCSSClasses() { return []; }
}
