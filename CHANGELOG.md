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
