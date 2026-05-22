/**
 * Ship sheet part and tab registries.
 *
 * Extracted from ShipSheetMixin so both the AppV2 mixin (ShipSheetMixin /
 * ShipSheetV2Mixin) and the future AppV1 mixin (ShipSheetV1Mixin) can share
 * the same definitions without duplication.
 *
 * AppV2 usage:
 *   static PARTS = SHIP_PARTS;
 *   static TABS  = SHIP_TABS;
 *
 * AppV1 usage (wrapper template):
 *   context.partTemplates = Object.fromEntries(
 *     Object.entries(SHIP_PARTS).map(([id, def]) => [id, def.template])
 *   );
 */

import { CORE_MODULE_ID } from "../../constants.js";

// ── Part definitions ──────────────────────────────────────────────────────

export const SHIP_PARTS = {
  header:        { template: `modules/${CORE_MODULE_ID}/templates/actor/partials/ship-header.hbs`,     classes: ["vehicle-header"], scrollable: [""] },
  tabs:          { template: "templates/generic/tab-navigation.hbs" },
  overview:      { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/ship-overview.hbs`,        scrollable: [""] },
  captain:       { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/captain.hbs`,            scrollable: [""] },
  captain4man:   { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/4/captain.hbs`,            scrollable: [""] },
  captain5man:   { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/captain.hbs`,            scrollable: [""] },
  engineer3man:  { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/3/engineer.hbs`,           scrollable: [""] },
  engineer5man:  { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/engineer.hbs`,           scrollable: [""] },
  engineer:      { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/engineer.hbs`,           scrollable: [""] },
  pilot:         { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/pilot.hbs`,              scrollable: [""] },
  sensors:       { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/sensors.hbs`,            scrollable: [""] },
  gunner4man:    { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/4/gunner.hbs`,             scrollable: [""] },
  gunner5man:    { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/5/gunner.hbs`,             scrollable: [""] },
  gunner:        { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/gunner.hbs`,             scrollable: [""] },
  ordnance:      { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/6/ordnance.hbs`,           scrollable: [""] },
  config:        { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/ship-config.hbs`,          scrollable: [""] },
};

// ── Tab definitions ───────────────────────────────────────────────────────

export const SHIP_TABS = {
  overview:     { id: "overview",     group: "primary", label: "SHIPCOMBAT.Tab.Overview"  },
  captain:      { id: "captain",      group: "primary", label: "SHIPCOMBAT.Role.Captain"  },
  captain4man:  { id: "captain4man",  group: "primary", label: "SHIPCOMBAT.Role.Captain"  },
  captain5man:  { id: "captain5man",  group: "primary", label: "SHIPCOMBAT.Role.Captain"  },
  engineer3man: { id: "engineer3man", group: "primary", label: "SHIPCOMBAT.Role.Engineer" },
  engineer5man: { id: "engineer5man", group: "primary", label: "SHIPCOMBAT.Role.Engineer" },
  engineer:     { id: "engineer",     group: "primary", label: "SHIPCOMBAT.Role.Engineer" },
  pilot:        { id: "pilot",        group: "primary", label: "SHIPCOMBAT.Role.Pilot"    },
  sensors:      { id: "sensors",      group: "primary", label: "SHIPCOMBAT.Role.Sensors"  },
  gunner4man:   { id: "gunner4man",   group: "primary", label: "SHIPCOMBAT.Role.Gunner"   },
  gunner5man:   { id: "gunner5man",   group: "primary", label: "SHIPCOMBAT.Role.Gunner"   },
  gunner:       { id: "gunner",       group: "primary", label: "SHIPCOMBAT.Role.Gunner"   },
  ordnance:     { id: "ordnance",     group: "primary", label: "SHIPCOMBAT.Role.Ordnance" },
  config:       { id: "config",       group: "primary", label: "SHIPCOMBAT.Tab.Config"    },
};
