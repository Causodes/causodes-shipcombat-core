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

  /**
   * The English spelling variant preferred by this system's companion module.
   * Applied once at `i18nInit` to every string in the `SHIPCOMBAT` translation
   * tree before any template or UI code reads it.
   *
   * - `"british"` (default): "armour", "manoeuvre", etc.
   * - `"american"`:          "armor",  "maneuver",  etc.
   *
   * @returns {"british"|"american"}
   */
  get englishVariant() { return "british"; }

  /* ── Base classes ──────────────────────────────────────────────────────── */

  /**
   * Return the ApplicationV2 (or subclass) to use as the base for ShipSheet.
   * Must support warhammer-lib mixin interface if warhammer-lib is present.
   * @returns {typeof Application}
   */
  get SheetBaseClass() { throw new Error("Not implemented"); }

  /**
   * Return the AppV1 (legacy ActorSheet) base class to use for the ship sheet,
   * or `null` if this adapter does not support V1 sheets.
   * @returns {typeof foundry.appv1.sheets.ActorSheet|null}
   */
  get SheetBaseClassV1() { return null; }

  /**
   * When true, all ship-combat sheets and popups use AppV1 variants instead of
   * the default AppV2 variants.  System adapters whose host system does not
   * supply background CSS for AppV2 `.application` elements (e.g. SF2e/PF2e)
   * should override this to return `true`.
   * @returns {boolean}
   */
  get useApplicationV1() { return false; }

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
  /**
   * Return the overclock DC for the current heat level, scaling from DC 10
   * (no heat) to DC 20 (full heat), or null to use the ImpMal modifier-based
   * tier system instead.
   * @param {number} heat
   * @param {number} heatMax
   * @returns {number|null}
   */
  getOverclockDC(_heat, _heatMax) { return null; }

  /**
   * Determine whether an overclock attempt succeeded.
   *
   * Default (ImpMal): success when SL ≥ 0 — the tier modifier already
   * adjusts the roll difficulty, so any non-negative SL is a pass.
   *
   * DC-based systems (SF2e, D&D5e) override this to compare the raw d20
   * total against the DC that was passed into the roll.
   *
   * @param {{ SL: number, succeeded: boolean, roll: Roll }} result  rollSkillTest result
   * @param {{ dc: number|null, heat: number, heatMax: number }}     options
   * @returns {boolean}
   */
  isOverclockSuccess(result, _options) { return result.SL >= 0; }

  /**
   * Font Awesome icon class for generic "roll dice" buttons in skill-check UI.
   * Default is `fa-dice` (two d6s).  d20 systems override to `fa-dice-d20`.
   * Used by the `{{shipCombatDiceIcon}}` Handlebars helper so templates stay
   * system-agnostic.
   * @returns {string}
   */
  getRollDiceIcon() { return "fa-dice"; }
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
   * @param {Roll}        roll
   * @param {number}      target     - effectiveAccuracy
   * @param {number|null} [targetAC] - target's AC (d20 systems only; ignored by default)
   * @returns {boolean}
   */
  isCriticalHit(roll, target, _targetAC = null, _traits = {}) { return false; }

  /**
   * True if the roll counts as a weapon jam. The salvo resolver passes the
   * weapon's traits map so adapters can gate jamming on a trait flag.
   *
   * @param {Roll}   roll
   * @param {number} target
   * @param {object} traits
   * @returns {boolean}
   */
  isJam(roll, target, traits, _targetAC = null) { return false; }

  /**
   * Whether this individual shot result constitutes a critical failure
   * (for die-chip CSS highlighting).  Default false; d20 adapters override.
   *
   * @param {Roll}        roll
   * @param {number}      accuracy
   * @param {number|null} targetAC
   * @param {object}      traits
   * @returns {boolean}
   */
  isCriticalMiss(_roll, _accuracy, _targetAC, _traits) { return false; }

  /**
   * Return the number of crit rolls to make for this salvo, or `null` to use
   * the default damage-threshold path (one roll based on total hull damage).
   *
   * SF2e override: one crit per critting shot; Devastation Protocol makes ALL
   * hits through shield count as crits.
   *
   * @param {object[]} salvoRolls
   * @param {number}   hitsThroughShield
   * @param {boolean}  isDevastation
   * @returns {number|null}
   */
  getCritHitCount(_salvoRolls, _hitsThroughShield, _isDevastation) { return null; }

  /**
   * Return IWR data for `actor` as `{ immunities, weaknesses, resistances }`,
   * or null if this system does not expose IWR on actors.
   * Used by the sensor-radar Lock-4 popup drawer.
   *
   * @param {Actor} actor
   * @returns {{ immunities: string[], weaknesses: {type:string,value:number}[], resistances: {type:string,value:number}[] }|null}
   */
  getIWR(_actor) { return null; }

  /**
   * Optionally enrich a chat message flavor with a skill roll DC table.
   * Base implementation returns the flavor unchanged; SF2e overrides to append
   * the SL threshold table and "Points Granted" line.
   *
   * @param {string} baseFlavor - the plain-text or HTML flavor string
   * @param {Roll}   roll       - the evaluated Roll
   * @param {number} sl         - clamped success level (0+)
   * @returns {string}
   */
  buildSkillRollFlavor(baseFlavor, _roll, _sl) { return baseFlavor; }

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
   * Magnitude of one fixed hit bonus/penalty step. Used for:
   *   - Lock-tier 4 accuracy bonus
   *   - BDA adjust-bearing correction
   *   - Ranging-fire correction
   *   - Battle-clarity pierce
   *   - Captain "Inspired Targeting" action (captain-state.js)
   *
   * Defaults to getModifierStepSize(). Override when fixed bonuses use a
   * different scale than per-SL modifiers. SF2e example: getModifierStepSize()
   * returns 1 (d20 per-SL step) but getHitBonusStep() returns 2 (fixed bonuses
   * always grant +2 regardless of SL scale).
   *
   * @returns {number}
   */
  getHitBonusStep() { return this.getModifierStepSize(); }

  /**
   * Maximum number of decay bands a weapon can fire into beyond its effective
   * range.  Systems that use a fixed cap (e.g. SF2e: 20) should override this.
   * The default derives the cap from sensor.rating — when the per-band penalty
   * would exceed the sensor's base accuracy there is nothing more to gain.
   *
   * @param {number} sensorRating  The sensor's base hit modifier.
   * @returns {number}
   */
  getMaxDecayBands(sensorRating) {
    return Math.floor(sensorRating / this.getModifierStepSize());
  }

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
   * Format the BDA result SL as a sensor-tab button badge.
   * Default: "SL N". SF2e overrides to "(N Points)".
   *
   * @param {number} sl
   * @returns {string}
   */
  formatBdaBadge(sl) { return `SL ${sl}`; }

  /**
   * Format the accuracy value for display in the targeting popup.
   * Default appends "%" (d100 percentile systems).
   * d20 systems override to show a signed modifier (e.g. "+5 to hit vs AC 18").
   *
   * @param {number}      accuracy   - the computed totalAccuracy value
   * @param {number|null} [targetAC] - the target's AC (d20 systems only)
   * @returns {string}
   */
  formatAccuracyDisplay(accuracy, _targetAC = null) { return `${accuracy}%`; }

  /**
   * Format the "vs X" accuracy reference shown in the chat card salvo summary.
   * Roll-under adapters return the attack modifier / TN as-is.  d20 adapters
   * override to show the target's AC with a unit label.
   *
   * @param {number|null} effectiveAccuracy - attack modifier / TN used for rolls
   * @param {number|null} targetAC          - target AC (d20 systems); null for roll-under
   * @returns {string|number|null}
   */
  formatChatAccuracyDisplay(effectiveAccuracy, _targetAC) { return effectiveAccuracy; }

  /**
   * Format the attack hit modifier for display in the chat card salvo summary.
   * Return null (base) to hide; d20 adapters override to show the modifier.
   *
   * @param {number|null} effectiveAccuracy - the total attack bonus
   * @returns {string|null}
   */
  formatChatHitMod(_effectiveAccuracy) { return null; }

  /**
   * Extract the target's Armour Class (or equivalent DC) for d20-style hit
   * resolution.  Returns null by default (ignored by roll-under adapters);
   * d20 adapters override to return the target ship's AC.
   *
   * @param {Actor} actor  - the target actor
   * @returns {number|null}
   */
  getTargetAC(actor) { return null; }  // eslint-disable-line no-unused-vars

  /**
   * Hit decision for a single shot. Default is roll-under (correct for
   * WFRP/IM/GURPS); d20-style adapters override.
   *
   * @param {Roll}        roll
   * @param {number}      target     - effectiveAccuracy (target number for roll-under; attack bonus for d20)
   * @param {number|null} [targetAC] - target's AC (d20 systems only; ignored by default)
   * @returns {boolean}
   */
  isHit(roll, target, _targetAC = null) { return (roll?.total ?? 0) <= target; }

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

  /**
   * Return a sorted array of damage type options for weapon component sheets.
   * Each entry: { value: string, label: string }.
   * @returns {{ value: string, label: string }[]}
   */
  getDamageTypeChoices() { return []; }

  /**
   * Build the Roll formula string for a weapon component item.
   * The default reads the free-text `system.damage` field (e.g. "4d6").
   * Adapters that store damage as structured fields should override this.
   *
   * @param {Item} weapon  – weapon component item
   * @returns {string}     – Roll-compatible formula, e.g. "4d6", "1d8+2", "10"
   */
  getWeaponDamageFormula(weapon) {
    return String(weapon.system.damage || "0").trim() || "0";
  }

  /**
   * Return a localized display label for the weapon's damage type (e.g. "Piercing").
   * Return null for systems that do not track damage type per-weapon.
   *
   * @param {Item} weapon  – weapon component item
   * @returns {string|null}
   */
  getWeaponDamageType(_weapon) {
    return null;
  }

  /**
   * Return a localized display label for the damage type dealt by a ramming
   * collision (e.g. "Bludgeoning"). Return null for systems that do not type
   * ram damage.
   *
   * @returns {string|null}
   */
  getRamDamageType() {
    return null;
  }

  /**
   * Apply damage-type interactions (resistances, weaknesses, immunities) to a
   * single hit's post-armour hull damage. Called once per surviving hit inside
   * the salvo loop, after armour reduction and before totaling.
   *
   * Return shape:
   *   - `finalDamage`  adjusted hull damage (0 when immune)
   *   - `immune`       true if this damage type is fully negated by the target
   *   - `note`         optional short string for chat display
   *                    (e.g. "Resistant −5", "Weak +10", "Immune")
   *
   * Default: pass-through — no modification.
   *
   * @param {number} hullDamage   post-armour hull damage for one hit
   * @param {string} damageType   weapon damage type key (e.g. "fire", "cold")
   * @param {Actor}  targetActor  target ship actor
   * @returns {{ finalDamage: number, immune: boolean, note: string|null }}
   */
  modifyDamageForType(hullDamage, _damageType, _targetActor) {
    return { finalDamage: hullDamage, immune: false, note: null };
  }

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

  /**
   * Return actor-specific extra skill options (e.g. lore skills) not in the
   * global list from getRoleSkillOptions().  Merged per-role with the assigned actor.
   * @param {Actor} actor
   * @returns {Promise<Array<{value: string, skillKey: string, specName: string, label: string}>>}
   */
  async getActorExtraSkillOptions(actor) { return []; }

  /**
   * Return the numeric check modifier for a given skill key on an actor.
   * Returns null when the skill is unknown or the data is unavailable.
   * Override in system adapters to handle system-specific data paths (e.g.
   * perception as a separate attribute, or lore skills in a synthetic layer).
   * @param {Actor} actor
   * @param {string} skillKey
   * @returns {number|null}
   */
  getSkillScore(actor, skillKey) {
    return actor?.system?.skills?.[skillKey]?.total ?? null;
  }

  /**
   * Return the numeric roll modifier to display in the helm skill-block row.
   * Called with the already-resolved pilot crew actor (or null if none assigned).
   * @param {Actor|null} actor
   * @returns {number|null}
   */
  getHelmRollModifier(actor) { return null; }

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
   * How hull health bars should be presented for this system.
   *
   *   "damageTaken"  – bar grows as damage accumulates; value shown is damage count.
   *                    Appropriate for Warhammer-style "wounds" systems.
   *   "hpRemaining" – bar shrinks as damage accumulates; value shown is remaining HP.
   *                    Appropriate for systems where players think in terms of HP left.
   *
   * Override in a system adapter to change the default for every world using
   * that system without exposing a GM-facing setting.
   *
   * @returns {"damageTaken"|"hpRemaining"}
   */
  get hullDisplayMode() { return "damageTaken"; }

  /**
   * CSS classes appended to DEFAULT_OPTIONS.classes on every ship/ordnance
   * sheet. Lets the adapter inject system-specific styling selectors.
   * @returns {string[]}
   */
  get sheetCSSClasses() { return []; }

  /* ── Ship data access ─────────────────────────────────────────────────── */

  /**
   * Return the ship data object for an actor.
   *
   * For systems that use custom actor sub-types (e.g. impmal):
   *   actor.system  — the TypeDataModel instance.
   *
   * For systems that re-use an existing actor type and store ship data in
   * flags (e.g. SF2e, which does not allow module-defined sub-types):
   *   actor.flags["<moduleId>"]  — the plain flag bag.
   *
   * All role handlers, state managers, canvas overlays, and sheet mixins
   * call this method rather than reading actor.system directly, so the
   * same core code works for both storage strategies.
   *
   * @param {Actor} actor
   * @returns {object}
   */
  getShipData(actor) {
    return actor?.system;
  }

  /**
   * Convert a short ship-data key to the full Foundry document-update path.
   *
   * For impmal:  "hull.value"  →  "system.hull.value"
   * For SF2e:    "hull.value"  →  "flags.<moduleId>.hull.value"
   *
   * All actor.update() calls for ship data go through this method so that
   * writes are directed to the correct storage location.
   *
   * @param {string} shortKey  dot-separated key relative to the ship data root
   * @returns {string}
   */
  systemPath(shortKey) {
    return `system.${shortKey}`;
  }

  /**
   * Colour palette used by SensorRadar for canvas drawing.
   * Return an object whose keys match the _pal defaults in SensorRadar.js.
   * Partial objects are fine — missing keys fall back to the green defaults.
   *
   * @returns {object}
   */
  radarPalette() {
    return {};  // use SensorRadar green defaults
  }
}
