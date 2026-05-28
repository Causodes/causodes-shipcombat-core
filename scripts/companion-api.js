/**
 * companion-api.js — Re-exports every symbol that companion modules need from
 * core.  Exposed at runtime via `globalThis.ShipCombat._api`.
 *
 * Companion modules MUST NOT import these files directly with ES `import`
 * statements: on hosting platforms such as The Forge, each module's scripts are
 * served from a different CDN base URL, so a relative or absolute ES-module
 * import in a companion resolves to a different URL than core's own internal
 * imports of the same file.  The browser treats them as distinct modules,
 * producing duplicate class objects that break `instanceof` checks.
 *
 * Usage in companion modules:
 *
 *   const { SystemAdapter, emitToGM } = globalThis.ShipCombat._api;
 *   export class MyAdapter extends SystemAdapter { ... }
 *
 * Core evaluates before any companion (Foundry dependency order), so
 * `globalThis.ShipCombat._api` is populated before any companion file runs.
 */

export { SystemAdapter }                                     from "./systems/SystemAdapter.js";
export { emitToGM }                                          from "./socket.js";
export { ShipCombatState }                                   from "./state/ShipCombatState.js";
export { THEME, pixi }                                       from "./theme.js";
export { isOrdnance }                                        from "./actors/ordnance/ordnance-types.js";
export { classifyZone, getHitQuadrant, testArc }             from "./apps/TargetingPopup.js";
export { _drawArrow, _makeArrowContainer, _destroyContainer } from "./apps/StrikeCraftPopups.js";
export { HelmPreview }                                       from "./canvas/HelmPreview.js";
export { NpcShipSheetV1Mixin }                               from "./actors/npc/NpcShipSheetMixin.js";
export { NpcShipSheetMixin }                                 from "./actors/npc/NpcShipSheetMixin.js";
export { buildHelmContext }                                  from "./roles/pilot.js";
export { NpcShipSchemaMixin }                                from "./actors/npc/NpcShipSchema.js";
export { OrdnanceSchemaMixin }                               from "./actors/ordnance/OrdnanceSchema.js";
export { OrdnanceSheetV1Mixin }                              from "./actors/ordnance/OrdnanceSheetMixin.js";
export { OrdnanceSheetMixin }                                from "./actors/ordnance/OrdnanceSheetMixin.js";
export { ShipSchemaMixin }                                   from "./actors/ship/ShipSchema.js";
export { ShipSheetV1Mixin }                                  from "./actors/ship/ShipSheetV1Mixin.js";
export { ShipSheetV2Mixin }                                  from "./actors/ship/ShipSheetMixin.js";
export { ShipSheetMixin }                                    from "./actors/ship/ShipSheetMixin.js";
export { SHIP_PARTS, SHIP_TABS }                             from "./actors/ship/parts.js";
export { ShipComponentSchemaMixin }                          from "./items/ShipComponentSchema.js";
export { ShipComponentSheetMixin, ShipComponentSheetV1Mixin } from "./items/ShipComponentSheetMixin.js";
export { CORE_MODULE_ID, MACRO_FIRE_TIERS, buildChargeTiers, SHIP_CLASSIFICATIONS } from "./constants.js";
export { hullDisplay }                                       from "./constants.js";
