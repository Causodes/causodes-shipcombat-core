/**
 * Template + partial registry for causodes-shipcombat-core.
 *
 * Two responsibilities:
 *   1. Hold the canonical inventory of every Handlebars partial used by the engine,
 *      mapping each *short name* (e.g. "captain-conditions") to its default path
 *      inside this module.
 *   2. Allow a system companion module to override any partial's path by short
 *      name, via ShipCombat.registerPartialOverride(name, path), before core
 *      compiles and registers the partials in the "setup" hook.
 *
 * Tab-shell, popup, and chat templates are loaded by path only — they are not
 * overridable in v1 (see PHASE_4_PLAN.md §2). They live in STATIC_TEMPLATE_PATHS.
 *
 * Sheet PARTS templates (referenced from JS by Foundry's ApplicationV2 PARTS
 * config) are also path-bound and out of scope; system modules that need a
 * different sheet layout subclass the sheet and override PARTS directly.
 */

const CORE_MODULE_ID = "causodes-shipcombat-core";

// ── Overridable partials ──────────────────────────────────────────────────
//
// Every partial referenced from a tab shell, sheet, or other partial via
// `{{> "short-name"}}` is listed here, mapped to its default path in core.
// A system module may replace any of these by calling
//   ShipCombat.registerPartialOverride("short-name", "modules/<sysmodule>/path/to.hbs");
// before the "setup" hook fires.

const partialPath = (name) =>
  `modules/${CORE_MODULE_ID}/templates/actor/partials/${name}.hbs`;

export const CORE_PARTIAL_DEFAULTS = Object.freeze(Object.fromEntries([
  // Headers
  "ship-header",
  "npc-ship-header",
  "station-header",
  // Shared
  "complete-turn",
  "core-status-banner",
  "payload-status-badge",
  "command-deck-bar",
  // Vessel (torpedo / strike-craft)
  "vessel-resource-bar",
  "vessel-movement-controls",
  "vessel-weapon-traits",
  "vessel-turn-complete",
  "vessel-trait-summary",
  "payload-damage-component",
  // Captain
  "captain-claim-prompt",
  "captain-status-bar",
  "captain-leadership",
  "captain-voidshields",
  "captain-conditions",
  "captain-core-actions",
  "captain-hand",
  "captain-active-orders",
  "combined-core-actions",
  "combined-leadership",
  "deployed-strike-craft",
  "deployed-torpedoes",
  // Ordnance
  "ordnance-claim-prompt",
  "ordnance-captain-boost",
  "ordnance-status-bar",
  "ordnance-requisition",
  "ordnance-main-actions",
  "ordnance-payload",
  "ordnance-core-actions",
  "ordnance-deployed",
  // Engineer
  "engineer-claim-prompt",
  "engineer-captain-boost",
  "engineer-status-bar",
  "engineer-core-distribution",
  "engineer-heat-management",
  "engineer-fire-suppression",
  "engineer-hull-repair",
  // Pilot
  "pilot-claim-prompt",
  "pilot-captain-boost",
  "pilot-status-bar",
  "pilot-helm-sl-alloc",
  "pilot-helm-control",
  "pilot-overcharged-actions",
  // Sensors
  "sensors-claim-prompt",
  "sensors-captain-boost",
  "sensors-status-bar",
  "sensors-radar",
  "sensors-radar-popout",
  "sensors-bda",
  "sensors-abilities-ref",
  // Gunner
  "gunner-claim-prompt",
  "gunner-captain-boost",
  "gunner-status-bar",
  "gunner-combined-status-bar",
  "gunner-ordnance-allocation",
  "gunner-core-actions",
  "gunner-weapon-batteries",
  // Component sheet
  "component-extended-fields",
].map(name => [name, partialPath(name)])));

// ── Static (non-overridable) templates ────────────────────────────────────
//
// Tab shells, popups, chat cards. Loaded by path only.

export const STATIC_TEMPLATE_PATHS = Object.freeze([
  // Tab shells & ship sheet
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/ship-overview.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/ship-config.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-body.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-config.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-movement.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-gunner.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-ordnance.hbs`,
  // Role-tab compositors
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/captain.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/ordnance.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/engineer.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/pilot.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/sensors.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/gunner.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/captain.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/engineer.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/gunner.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/4/captain.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/4/gunner.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/tabs/3/engineer.hbs`,
  // Ordnance / vessel sheets
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/torpedo-header.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/torpedo-warhead.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/torpedo-config.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/strike-craft-header.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/strike-craft-sheet.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/strike-craft-config.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/ordnance-header.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/ordnance-main.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/sheets/ordnance-config.hbs`,
  // V1 (AppV1 / legacy ActorSheet) wrapper templates
  `modules/${CORE_MODULE_ID}/templates/actor/npc-ship-v1.hbs`,
  `modules/${CORE_MODULE_ID}/templates/actor/ordnance-v1.hbs`,
  // Item templates
  `modules/${CORE_MODULE_ID}/templates/item/component-header.hbs`,
  `modules/${CORE_MODULE_ID}/templates/item/component-details.hbs`,
  `modules/${CORE_MODULE_ID}/templates/item/component-description.hbs`,
  // App templates (popups)
  `modules/${CORE_MODULE_ID}/templates/apps/bda-popup.hbs`,
  `modules/${CORE_MODULE_ID}/templates/apps/strike-craft-attack-popup.hbs`,
  `modules/${CORE_MODULE_ID}/templates/apps/recover-craft-popup.hbs`,
  // Chat templates
  `modules/${CORE_MODULE_ID}/templates/chat/bda-pending.hbs`,
  `modules/${CORE_MODULE_ID}/templates/chat/strike-craft-result.hbs`,
  `modules/${CORE_MODULE_ID}/templates/chat/torpedo-result.hbs`,
]);

// ── Registry ──────────────────────────────────────────────────────────────

/**
 * Single source of truth for partial-override resolution.
 *
 * Lifecycle:
 *   1. Companion module's "init" hook: calls register(name, path) for each override.
 *   2. Core's "setup" hook: calls finalize() and resolve(), then loadTemplates().
 *   3. After finalize(), register() throws — overrides registered too late.
 *
 * Resolution semantics: an override is a complete replacement of the default
 * path. The override path is responsible for emitting the same data-action
 * outputs and consuming the same context shape as the default partial.
 */
export class PartialRegistry {
  constructor(defaults) {
    this._defaults  = { ...defaults };
    this._overrides = new Map();
    this._finalized = false;
  }

  /**
   * Register an override for a named partial. Must be called before finalize().
   * Throws if name is unknown or the registry has been finalized.
   */
  register(name, path) {
    if (this._finalized) {
      throw new Error(
        `causodes-shipcombat-core | registerPartialOverride("${name}") called after partials were finalized. ` +
        "Overrides must be registered during the system module's \"init\" hook.",
      );
    }
    if (!(name in this._defaults)) {
      throw new Error(
        `causodes-shipcombat-core | registerPartialOverride: unknown partial name "${name}". ` +
        `Valid names: ${Object.keys(this._defaults).sort().join(", ")}`,
      );
    }
    if (typeof path !== "string" || !path.endsWith(".hbs")) {
      throw new Error(
        `causodes-shipcombat-core | registerPartialOverride("${name}", ${path}): path must be a .hbs file path.`,
      );
    }
    this._overrides.set(name, path);
  }

  finalize() { this._finalized = true; }
  get isFinalized() { return this._finalized; }

  /** Returns the resolved path for a partial (override if present, else default). */
  resolve(name) {
    return this._overrides.get(name) ?? this._defaults[name] ?? null;
  }

  /**
   * Return a frozen snapshot of all (name → resolvedPath) pairs.
   * Used to drive Handlebars partial registration in core's setup hook.
   */
  entries() {
    const out = {};
    for (const name of Object.keys(this._defaults)) out[name] = this.resolve(name);
    return Object.freeze(out);
  }

  /** Set of names that have an override registered (for diagnostics / tests). */
  overriddenNames() {
    return new Set(this._overrides.keys());
  }
}

// ── Loader ────────────────────────────────────────────────────────────────

/**
 * Compile and register every overridable partial (under its short name) plus
 * every static template (under its full path). Called once during core's
 * "setup" hook, after companion modules have had their "init" turn.
 */
export async function loadAllTemplates(registry) {
  registry.finalize();

  // Object form of loadTemplates registers partials under their short names
  // (e.g. "ship-header").  AppV2 sheets reference partials by short name via
  // {{> "ship-header"}} in tab templates, which works fine.
  const overridableMap = registry.entries();
  await foundry.applications.handlebars.loadTemplates(overridableMap);

  // AppV1 sheets call {{> (lookup partTemplates partId)}} where partTemplates
  // maps part IDs to full paths (e.g. "modules/.../partials/ship-header.hbs").
  // Handlebars only knows those templates under their short names, so we also
  // register the already-compiled functions under their full paths — no extra
  // socket round-trips needed.
  for (const [name, path] of Object.entries(overridableMap)) {
    const compiled = Handlebars.partials[name];
    if (compiled && !(path in Handlebars.partials)) {
      Handlebars.registerPartial(path, compiled);
    }
  }

  // Static templates: array form — registered under their full paths.
  await foundry.applications.handlebars.loadTemplates([...STATIC_TEMPLATE_PATHS]);
}
