## v2.2.0
- Fix weapon accuracy being double-counted: the targeting popups pass a fully composed hit modifier, and `fireWeapon` no longer re-adds allocation/stance/weapon-rating/captain bonuses on top of it — only the Fire Control Failure penalty (unknown to the popups) is applied at resolution time. Rolls now match the value shown in the targeting popup
- Use the fixed hit-bonus step (`getHitBonusStep`) for the Lock 4, BDA Adjust Bearing, Ranging Fire, and Battle Clarity bonuses in the core targeting popups (no change for d100 systems, where both steps are equal)
- Fix target Evasion double-dipping on d20 systems: the accuracy-side evasion penalty in the targeting popups now only applies on roll-under systems (`getTargetAC` → null); d20 adapters carry evasion on the target's AC
- Enforce **Sensor Disruption**: the disrupted ship now takes an adapter-defined penalty (`getSensorDisruptionPenalty`, default one range band) on weapon fire and NPC ship checks
- Enforce **Sensor Overcharge**: an overcharged ship's weapons can only target within its own auto-scan range
- **Signal Inversion** now mechanically strips all shields from the target's quadrant closest to the player ship (new `stripQuadrantShields` socket action + chat card)
- Add `ShipCombatState.hasSensorEffectOn` / `getDisruptionPenalty` helpers and the `getSensorDisruptionPenalty` adapter hook
- Fix strike craft flight size being inverted on HP-remaining systems (computed as damage taken instead of remaining airframes)
- Fix the gunner-tab condition banner showing hardcoded d100 stance/fire-control values; now scaled to the active system's modifier step
- Fix inverted token front/bow convention by adjusting offset from `-90` to `+90`. At token rotation 0, FoundryVTT treats heading south as the bow. Adjust `_tokenBasis` to match this behavior instead of treating north as the bow.
- Helm preview now correctly preserves token image mirroring configurations.

## v2.1.6
- Fix bug where extra cores awarded from Overclock were not being correctly displayed
- Further agnosticize Overclock success logic and move binary success determination to companion module
- Add handling for module-specific dice icon override

## v2.1.5
- Explicitly classify buttons as type `button` in handlebars templates to prevent unintended form submission behavior
- Add handling for scaling DC for Overclock checks in systems like SF2e or D&D5e

## v2.1.4
- Fix all AppV2 ship sheets throwing `DataModelValidationError` ("must be a number") when a number field is cleared
  - Applies to NPC ship, player ship, ship component items, and ordnance sheets
  - Extract shared `coerceEmptyNumberInputs` helper into `scripts/sheet-utils.js`
  - AppV2: override `_processFormData` in each sheet mixin to coerce `null` values from empty `<input type="number">` to `0` before Foundry validates the expanded object; use `querySelector`+`CSS.escape` for reliable element lookup with dotted names
  - AppV1: `_updateObject` coerces empty inputs to `0` before the key-remap loop

## v2.1.3
- Remove legacy data migration code
- Add flavour/flavor language keys
- Fix NPC ship skill checks for non d100/roll-under systems

## v2.1.2
- Add a notification informing users to use the refresh button to propagate item component updates

## v2.1.1
- Add missing hull damage ramming path for HP-based systems (SF2e); hull value will now correctly be decremented instead of incremented

## v2.1.0
- Expose companion API via `globalThis.ShipCombat._api` to eliminate cross-module ES import issues on hosting platforms (e.g. The Forge) where each module's scripts are served from a separate CDN base URL, causing duplicate module instances and broken `instanceof` checks

## v2.0.0
- Initial v14 release
- Add AppV1 compatibility
- Add Flux -> AP Ratio on Shields Component
- Add AP Cost Multiplier on Sensors Component
- Add American vs British English substitution
- Add support for damage types, dice damage values, and IWR
- Helm and Ramming movement calculation bugfixes
- Update J2BA animation paths

## v1.0.0
- Initial v13 release
