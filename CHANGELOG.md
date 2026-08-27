## 2.3.0 (UNRELEASED)
- Route every Captain-card surface and pile preview through one system-theme contract so sheets, chat, Emergency Salvage, and Dead Reckoning cannot drift into different card graphics
- Centralize allocation terminology in the active system adapter, including count-aware singular/plural forms used by localization, templates, BDA badges, and generated UI copy
- Fix nested role-name localization tokens so companion role overrides resolve cleanly in warnings and Captain-card descriptions
- Fix Combat Telemetry only upgrading one target by applying all lock upgrades in one atomic GM-side actor update
- Fix Combat Telemetry skipping targets within auto-scan range
- Keep BDA results isolated per attack so overlapping assessments cannot display another shot's hit count or damage
- Resolve the BDA operator from crew layout, allow the Captain to operate Sensors in 4-person crews, and retain GM launch access
- Resolve every station operator from the 3–6 person crew layout, including reduced-crew helm, sensor visibility, ordnance rolls, and deployed-craft control
- Use collision-checked 20-character BDA attack IDs and mark completed or round-reset assessment cards as expired
- Derive accuracy copy and fire-tier modifiers from the active system adapter; fix d20 allocation/fire-mode scaling and remove percentile-only strike-craft displays
- Preserve the Captain's rolled initiative as the additive baseline for next-round initiative allocations across core and system-specific combat-tracker roll paths
- Unify Captain, Red Alert, and Engineer Power Core grants into one receiving-operator pool, with Engineer assignment retained only as its once-per-role distribution ledger; reduced-crew stations now read and spend their shared operator pool while keeping the existing available/unavailable overlays
- Serialize every GM-side Power Core grant, spend, and reset in one per-ship transaction queue; consumption and action telemetry commit together, preventing both double-spends and grant/spend lost updates; remove the obsolete direct assign/revoke API
- Balance Sensor Priority by halving Lock 1 and Lock 2 AP costs for the round, rounding up after the sensor component's AP modifier, instead of making those upgrades free
- Add persistent per-ship contact designations shared across radar and targeting interfaces, plus crew-visible canvas markers for the Sensors recommendation and Captain's Priority Target
- Correct Sensor Radar heading transforms after the ship-forward convention change and rotate the true compass beneath relative/heading-up mode
- Restyle Marked Target and Priority Target as high-opacity translucent pale teal/red indicators outside the shield and bow-indicator radius, with two-line, lock-coloured canvas labels and `Bandit-a: Name` contact formatting
- Fix NPC ordnance salvo and flight-size fields being locked to 1 by persisting edits to the embedded template and applying the current field value when launching
- Rework Captain Standing Orders: remove manual draw/full-hand mulligan controls, make Resolve fund per-slot mulligans that lock allocation on first use, and make Inspire set the next round's hand limit above a base of 3
- Make Captain cards instance-aware so duplicate orders remain independently selectable and reorderable
- Rework Emergency Salvage to preview full card effects, add the chosen order to hand with a Salvaged tag regardless of hand limit, recycle the remaining discard pile, and return the Salvaged order to the bottom of the draw pile whenever it leaves hand
- Show full order names, categories, and descriptions while reordering the draw pile with Dead Reckoning
- Spend Captain's Power Core before revealing the draw-pile preview in Dead Reckoning; cancelling or closing the preview no longer avoids the cost
- Remove the redundant Active Standing Orders panel from Captain tabs; active stance remains in the top status bar and role-specific order effects remain visible to affected crew
- Make the Standing Orders next-round counter project the refilled hand, and defer discard recycling until a round begins with an empty draw pile so a partially exhausted pile produces one intentionally short hand
- Define one universal Captain-card surface contract for sheets, chat, Emergency Salvage, and Dead Reckoning so companion-system themes apply consistently without consumer-specific copies
- Serialize and validate Captain, Gunner, Pilot, and Ordnance point allocations on the GM, enforcing pool totals, roll prerequisites, and post-action locks across full and reduced crews; apply equivalent guards to NPC helm and gunnery allocation controls
- Fix Red Alert at the real Foundry round boundary: its internal fire increase and per-station Power Core grants now commit atomically with the round reset, including shared operator pools in reduced crews
- Apply Aggressive and Defensive stance modifiers on both sides of ship and strike-craft attacks, and use their Speed/Maneuverability changes in actual helm previews, movement, rams, and drift rather than display only
- Apply Devastating Protocol to incoming as well as outgoing weapon, strike-craft, torpedo, and ramming hits
- Increase Dead Reckoning footer-button padding so Confirm Order and Cancel labels no longer crowd their right edges
- Classify radar contacts by token allegiance (hostile Bandits, neutral Bogeys, named friendlies), exclude the acting ship and its allies from every shared target picker while preserving hostile-NPC targeting, and enforce the same rule in GM-side target-marking handlers
- Replace the Mark for Crew flag with a crosshair and show Marked/Priority contacts directly on the Sensor Radar; pale-teal intercardinal ticks identify crew marks, Priority doubles the normal ring thickness in pale red, and mirrored name placement keeps the upper label clear
- Rename Battle Clarity to Priority Target
- Add Critical Hit effect tooltips on chat cards
- Clean up allocation locks; locking actions are now more sensible than before
- Harden various emit to GM transport contracts
- Add confirmation dialogue on allocation locking actions
- Add GM Manual Override to player ship stats to the bottom of the Configuration tab
- Remove stale/legacy resource keys
- Add a world-level Shield Resolution setting with backward-compatible Hit Negation and optional Damage Pool modes; Damage Pool applies Shield Burn before absorbing normal damage point-for-point and discards excess Burn instead of spilling it into armour or hull, while weapon, strike-craft, and torpedo attacks consistently respect Shield Bypass, Harden Shields, immunity, Rend, and partial damage overflow

## 2.2.4
- Fix NPC ship weapon delete controls doing nothing by registering the shared embedded-item actions on both AppV2 and legacy AppV1 NPC sheets

## v2.2.3
- Fix weapon firing-arc and range overlays being disabled on AppV2 player ships using the 4- or 5-person Gunner tabs; `gunner`, `gunner4man`, and `gunner5man` are now handled consistently
- Give each AppV2 weapon-targeting popup a unique application ID so opening overlapping targeting windows no longer replaces another popup's DOM frame or triggers detached-element positioning errors

## v2.2.2
- Fix players being unable to control launched ordnance: the player who owns a launched torpedo or strike craft can now operate its helm controls
- Fix strike craft ownership going to the Captain instead of the Gunner in 3- and 4-player crews, where the Gunner runs the ordnance station
- `spawnOrdnance` now resolves the controlling player from the launching ship's role assignments rather than the first ship found (fixes wrong ownership in multi-ship scenes)
- Fix launched ordnance not appearing in other players' deployed panels until the next ship update: ship sheets now re-render on every client when an ordnance token is created
- Replace deprecated Foundry API calls (`renderChatMessage` hook → `renderChatMessageHTML`; `loadTemplates` → `foundry.applications.handlebars.loadTemplates`)

## v2.2.1
- Add missing handling for display of flat weapon damage bonuses (such as in D&D5e)

## v2.2.0
- Fix weapon accuracy being double-counted: the targeting popups pass a fully composed hit modifier, and `fireWeapon` no longer re-adds allocation/stance/weapon-rating/captain bonuses on top of it — only the Fire Control Failure penalty (unknown to the popups) is applied at resolution time. Rolls now match the value shown in the targeting popup
- Use the fixed hit-bonus step (`getHitBonusStep`) for the Lock 4, BDA Adjust Bearing, Ranging Fire, and Priority Target bonuses in the core targeting popups (no change for d100 systems, where both steps are equal)
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
