import { MODULE_ID } from "./constants.js";
import { ALLOCATION_WARNING_SETTING, AllocationWarningResetMenu } from "./apps/allocation-warning.js";

/**
 * Register all module settings.
 * Called once from the main entry point during "init".
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, ALLOCATION_WARNING_SETTING, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.registerMenu(MODULE_ID, "resetAllocationWarnings", {
    name: "SHIPCOMBAT.Setting.ResetAllocationWarnings",
    label: "SHIPCOMBAT.Setting.ResetAllocationWarningsButton",
    hint: "SHIPCOMBAT.Setting.ResetAllocationWarningsHint",
    icon: "fa-solid fa-rotate-left",
    type: AllocationWarningResetMenu,
    restricted: false,
  });

  game.settings.register(MODULE_ID, "contactDesignation", {
    name: "SHIPCOMBAT.Setting.ContactDesignation",
    hint: "SHIPCOMBAT.Setting.ContactDesignationHint",
    scope: "world",
    config: true,
    type: String,
    default: "naval-greek",
    choices: {
      "contact-greek":   "SHIPCOMBAT.Setting.ContactGreek",
      "contact-numeric": "SHIPCOMBAT.Setting.ContactNumeric",
      "naval-greek":     "SHIPCOMBAT.Setting.NavalGreek",
      "naval-numeric":   "SHIPCOMBAT.Setting.NavalNumeric",
    },
  });

  game.settings.register(MODULE_ID, "sweepGatedPositions", {
    name: "SHIPCOMBAT.Setting.SweepGatedPositions",
    hint: "SHIPCOMBAT.Setting.SweepGatedPositionsHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "movementMode", {
    name: "SHIPCOMBAT.Setting.MovementMode",
    hint: "SHIPCOMBAT.Setting.MovementModeHint",
    scope: "world",
    config: true,
    requiresReload: true,
    type: String,
    default: "simplified",
    choices: {
      "simplified": "SHIPCOMBAT.Config.MovementSimplified",
      "realistic":  "SHIPCOMBAT.Config.MovementRealistic",
    },
  });

}
