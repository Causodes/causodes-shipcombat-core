# Causodes's Ship Combat (Core)

System-agnostic ship combat engine for Foundry VTT. The core module ships the
data models, sheets, canvas overlays, socket handlers, and templates. All
system-specific behaviour (roll formulas, success-level math, hit resolution,
skill labels, model integration) lives in a **companion module** that pairs
this engine with a specific game system.

---

## Companion module responsibilities

A companion module MUST do four things:

1. Subclass `SystemAdapter` and implement the abstract methods.
2. Call `ShipCombat.configure({ moduleId, adapter })` at module-evaluation
   time (top-level in your entry-point script), **before Foundry fires the
   `init` hook**.
3. Provide a `lang/en.json` (and other locales) that overrides any of core's
   neutral default strings with system-flavoured terminology.
4. Optionally, register Handlebars partial overrides during its own `init`
   hook to swap out specific UI panels.
5. **Never import core files directly via ES `import` statements.** Hosting
   platforms such as [The Forge](https://forge-vtt.com) serve each module's
   scripts from its own CDN base URL. A companion's ES import of a core file
   (whether relative or absolute `/modules/` path) resolves to a different URL
   than core's own internal import of the same file; the browser loads two
   separate module instances, breaking `instanceof` checks inside
   `SystemAdapter.register()` and producing a
   `"… is not a registered game setting"` error at startup.

   Instead, access all core APIs through **`globalThis.ShipCombat._api`**,
   which core populates at evaluation time (before any companion loads):

   ```js
   // ✗  Breaks on The Forge (ES import — different URL per module on CDN)
   import { SystemAdapter } from "/modules/causodes-shipcombat-core/scripts/systems/SystemAdapter.js";

   // ✓  Always correct (runtime global — same object reference everywhere)
   const { SystemAdapter, emitToGM } = globalThis.ShipCombat._api;
   export class MyAdapter extends SystemAdapter { ... }
   ```

If `ShipCombat.configure()` is not called by the time `init` fires, core
logs a warning and disables itself.

### Minimum companion entry-point

```js
import { MyAdapter } from "./scripts/my-adapter.js";

ShipCombat.configure({
  moduleId: "my-shipcombat-module",
  adapter:  new MyAdapter(),
});

Hooks.once("init", () => {
  // Optional: replace specific UI partials.
  ShipCombat.registerPartialOverride(
    "captain-conditions",
    "modules/my-shipcombat-module/templates/my-conditions.hbs",
  );
});
```

---

## `ShipCombat` global API

| Method | Call from | Purpose |
| --- | --- | --- |
| `configure({ moduleId, adapter })` | module eval | Register the companion module ID and adapter instance. Must precede `init`. |
| `registerPartialOverride(name, path)` | `init` hook | Replace a named Handlebars partial with a companion-supplied template. |
| `registerPopupOverride(key, PopupClass)` | `init` hook | Replace a core popup class. Keys: `"targeting"`, `"ramTarget"`, `"battleClarity"`, `"strikeCraftAttack"`, `"recoverCraft"`. |

---

## The `SystemAdapter` contract

Subclass `SystemAdapter` from
[scripts/systems/SystemAdapter.js](scripts/systems/SystemAdapter.js).
Methods marked **abstract** throw if not overridden; **overridable** methods
have a working default and only need overriding when the host system requires
different behaviour.

### Identity

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `get moduleId` | abstract | `string` | Companion module's Foundry ID. Used for socket scopes, flag namespaces, and template paths. |
| `get systemName` | abstract | `string` | Foundry system ID (e.g. `"impmal"`, `"pf2e"`). Used for gate-checks. |

### Application bases

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `get SheetBaseClass` | abstract | `typeof Application` | AppV2 base class for ship/ordnance sheets. Typically the system's actor sheet base. |
| `get ItemSheetBaseClass` | abstract | `typeof Application` | AppV2 base class for component item sheets. |
| `get ActorModelBaseClass` | abstract | `typeof DataModel` | Base `DataModel` for ship/ordnance actors (e.g. `BaseWarhammerActorModel`). |
| `get ItemModelBaseClass` | abstract | `typeof DataModel` | Base `DataModel` for component items. |
| `get useApplicationV1` | overridable | `boolean` | Return `true` to use the AppV1 bridge for all sheets and popups. Default: `false`. |
| `get SheetBaseClassV1` | overridable | `typeof ActorSheet \| null` | AppV1-compatible base class for ship sheets. Only used when `useApplicationV1 === true`. Default: `null`. |
| `get sheetCSSClasses` | overridable | `string[]` | CSS classes appended to every ship/ordnance sheet's class list. Lets the adapter inject system-scoped selectors. Default: `[]`. |

### Ship data storage

Core reads and writes ship data through two adapter methods rather than
touching `actor.system` directly. This lets flag-based adapters (e.g. SF2e,
which does not allow module-defined actor sub-types) store ship data in
`actor.flags[moduleId]` while other adapters use `actor.system`.

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `getShipData(actor)` | overridable | `object` | Return the ship data root for `actor`. Default: `actor.system`. Flag-based adapters return `actor.flags[this.moduleId] ?? {}`. |
| `systemPath(shortKey)` | overridable | `string` | Convert a short dot-separated key to the full Foundry update path. Default: `"system." + shortKey`. Flag-based adapters return `"flags." + this.moduleId + "." + shortKey`. **All `actor.update()` calls in core route through this.** |

```js
// impmal (default — system sub-type)
getShipData(actor) { return actor.system; }
systemPath(key)    { return `system.${key}`; }

// SF2e (flag-based — no module sub-types allowed)
getShipData(actor) { return actor.flags[this.moduleId] ?? {}; }
systemPath(key)    { return `flags.${this.moduleId}.${key}`; }
```

### Model lifecycle hooks

| Method | Kind | Notes |
| --- | --- | --- |
| `initModelStubs(model)` | overridable | Called in `computeBase()`. Attach interface stubs the host system expects on `actor.system` (`characteristics`, `skills`, …). Default: no-op. |
| `deriveModelData(model)` | overridable | Called in `computeDerived()` after items are resolved. Final pass to write derived state. Default: no-op. |
| `applyHullDisplay(model)` | overridable | Called after hull is derived. Translate core's hull representation into what the host system or external modules (HealthEstimate, PF2e HP bar, …) expect. Default: no-op. |
| `get hullDisplayMode` | overridable | `"damageTaken"` (bar grows; value = damage/wounds count) or `"hpRemaining"` (bar shrinks; value = remaining HP). Default: `"damageTaken"`. |

### Skill resolution

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `resolveSkill(roleSkill)` | abstract | `{ key, specialisation }` | Decode a role-skill identifier (`"pilot"`, `"engineering"`, …) into the system-specific skill descriptor. |
| `getDefaultRoleSkillMapping()` | overridable | `Record<roleId, { skillKey, specialisation, rootLabel, label }>` | Default role → skill mapping used when no per-ship override is set. Must override for any role that uses skill allocation. Default: `{}`. |
| `getSkillLabel(key)` | overridable | `string` | Localised display name for a skill key. Default: the key itself. |
| `getRoleSkillOptions()` | overridable | `Promise<{ value, skillKey, specName, label }[]>` | All selectable skill options for role-skill override dropdowns. Default: `[]`. |
| `getActorExtraSkillOptions(actor)` | overridable | `Promise<{ value, skillKey, specName, label }[]>` | Actor-specific extra options not in the global list (e.g. lore skills). Merged per-role with the assigned actor. Default: `[]`. |
| `getSkillScore(actor, skillKey)` | overridable | `number \| null` | Numeric check modifier for a skill key on an actor. Default reads `actor.system.skills[key].total`. |
| `getHelmRollModifier(actor)` | overridable | `number \| null` | Roll modifier displayed in the helm skill-block row for the pilot's assigned actor. Default: `null` (hidden). |

### Initiative and skill rolls

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `rollSkillTest(crewActor, roleSkill, opts)` | abstract | `Promise<{ SL, succeeded, roll }>` | Invoke the system roll workflow for a crew actor. |
| `rollShipInitiative(crewActor, roleSkill, opts)` | abstract | `Promise<{ total, roll, message }>` | Initiative roll for player-crewed ships. |
| `rollShipInitiativeFromAttribute(value, label, opts)` | abstract | `Promise<{ total, roll, message }>` | Initiative roll for NPC ships (single numeric attribute). |
| `toCombatantInitiative(rawTotal, shipActor)` | overridable | `number` | Translate the engine's raw total to Foundry's `combatant.initiative`. Default: identity. |
| `buildSkillRollFlavor(baseFlavor, roll, sl)` | overridable | `string` | Enrich a skill roll chat card flavor (e.g. append SL threshold table). Default: returns `baseFlavor` unchanged. |
| `parseRollResultFromMessage(message)` | overridable | `{ SL, roll }` | Extract SL and roll from a chat message produced by `rollSkillTest`. Called when reroll hooks (fortune, etc.) mutate the message. Default reads warhammer-lib `message.system.result` shape. |

### Hit resolution — salvo primitives

The salvo loop calls these lightweight methods for every individual shot. For
non-salvo (single-fire) actions, core calls `resolveHitRoll()` instead.

| Method | Kind | Default | Notes |
| --- | --- | --- | --- |
| `getRollFormula()` | overridable | `"1d100"` | Foundry roll formula for salvo shots. |
| `getModifierStepSize()` | overridable | `1` | The engine's shared accuracy-step unit (10 for d100, 1 for d20). **One call site drives all of the following:** lock-tier 4 bonus, BDA adjust-bearing correction, ranging-fire correction, battle-clarity bonus, aggressive/defensive stance modifier, and per-SL pilot-evasion / gunner-allocation bonuses (applied at half this value per SL). If the host system uses a consistent bonus scale, this is the only method you need. |
| `getHitBonusStep()` | overridable | `getModifierStepSize()` | Magnitude of a single fixed bonus step: lock-tier 4 accuracy, BDA adjust-bearing, ranging-fire correction, battle-clarity pierce, and the captain's Inspired Targeting action. Override when the system applies these fixed bonuses at a different scale than `getModifierStepSize()`. SF2e example: `getModifierStepSize()` returns `1` (d20 per-SL step) but `getHitBonusStep()` returns `2` (fixed bonuses always grant +2, regardless of SL scale). |
| `computeSuccessLevel(roll, target)` | overridable | `floor((target − total) / 10)` | SL from a roll result. Default is d100-style; override for d20 or custom systems. |
| `formatModifier(value)` | overridable | signed number | UI display for a modifier (e.g. `"+10%"` for IM). |
| `formatTargetNumber(target)` | overridable | bare number | UI display for a target number. |
| `formatAccuracyDisplay(accuracy, targetAC)` | overridable | `"${accuracy}%"` | Targeting popup accuracy label. d20 adapters override to show a signed modifier. |
| `formatChatAccuracyDisplay(accuracy, targetAC)` | overridable | `accuracy` | "vs X" reference in the chat card salvo summary. d20 adapters show the target AC. |
| `formatChatHitMod(accuracy)` | overridable | `null` (hidden) | Attack modifier label in chat card. d20 adapters show the modifier string. |
| `isHit(roll, target, targetAC)` | overridable | `roll.total ≤ target` | Hit decision for one shot. Override for d20 roll-over mechanics. |
| `getTargetAC(actor)` | overridable | `number \| null` | Extract the target actor's AC. Returns `null` for roll-under systems — the AC row is hidden in the radar popup and `null` is forwarded to `isHit()`, `isCriticalHit()`, `isCriticalMiss()`, and `isJam()` as their `targetAC` parameter (the defaults ignore it). When non-null, the numeric AC is displayed in the Lock-3+ radar popup and passed to all four roll methods. |
| `isAutomaticCrit(roll)` | overridable | `false` | True if the roll is an auto-crit regardless of margin (e.g. nat-100 in d100 systems). |
| `isCriticalHit(roll, target, targetAC, traits)` | overridable | `false` | Margin-based crit determination after a confirmed hit. |
| `isCriticalMiss(roll, accuracy, targetAC, traits)` | overridable | `false` | Critical failure (for die-chip CSS highlighting). |
| `isJam(roll, target, traits, targetAC)` | overridable | `false` | Weapon jam determination. |
| `getCritHitCount(salvoRolls, hitsThroughShield, isDevastation)` | overridable | `null` | Override the number of crit rolls for a salvo. `null` uses core's default damage-threshold path. |
| `computeZone1Bonus(totalAccuracy)` | overridable | `0` | Close-scan (Zone 1) accuracy bonus. IM uses `(100 − accuracy) / 2`. |
| `getLockTierForSL(sl)` | overridable | `clamp(floor(sl), 0, 4)` | Map sensor-roll SL to a retained lock tier (0–4). |

### Full hit resolution (non-salvo)

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `resolveHitRoll(context)` | abstract | `Promise<{ hit, sl, roll, message, displayTarget, breakdownParts }>` | Full single-shot resolution for non-salvo fire actions. `context` provides `baseAccuracy`, `modifiers[]`, `weaponItem`, `targetActor`, and `options`. The salvo loop uses the lighter primitives above instead. |

### Damage types

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `getDamageTypeChoices()` | overridable | `{ value, label }[]` | Sorted options for the weapon damage-type dropdown. Default: `[]`. |
| `getWeaponDamageFormula(weapon)` | overridable | `string` | Roll formula for a weapon item. Default reads `weapon.system.damage` as a free-text formula string. Override for structured damage fields. |
| `getWeaponDamageType(weapon)` | overridable | `string \| null` | Localised damage type label for display. Default: `null`. |
| `getRamDamageType()` | overridable | `string \| null` | Damage type label for ram collisions. Default: `null`. |
| `modifyDamageForType(hullDamage, damageType, targetActor)` | overridable | `{ finalDamage, immune, note }` | Apply resistance/weakness/immunity to one hit's post-armour hull damage. Default: pass-through. |

### IWR (immunities, weaknesses, resistances)

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `getIWR(actor)` | overridable | `object \| null` | Return IWR data for the sensor-radar Lock-4+ Defenses drawer. Default: `null` — the drawer is omitted entirely. The drawer is also omitted when all three arrays are empty. Non-null shape: `{ immunities: string[], weaknesses: { type: string, value: number }[], resistances: { type: string, value: number }[] }`. |

### Component schema extensions

Adapters may declare extra fields stored on every component item (armour
class, hardpoint slots, etc.). Core stores them under `system.extended`.

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `getComponentSchemaExtensions(componentType)` | overridable | `Record<string, DataField>` | Extra `DataModel` fields to merge into the component's `extended` SchemaField. Called once per slot type at schema build time. Default: `{}`. |
| `getAvailabilityOptions()` | overridable | `Record<string, string>` | `{ key: label }` pairs for the item-availability dropdown. Default: `{}`. |

If you declare extension fields, also register a partial override for
`component-extended-fields` to render inputs for them in the item sheet.

### Crew

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `isCrewActorEligible(actor)` | overridable | `boolean` | Whether an actor may be assigned to a bridge role. Default: `true` (all actors eligible). |

### Canvas

| Method | Kind | Returns | Notes |
| --- | --- | --- | --- |
| `radarPalette()` | overridable | `object` | Partial colour palette for the sensor-radar canvas overlay. Missing keys fall back to the green defaults defined in `SensorRadar.js`. Default: `{}`. |

---

## Partial override registry

Core renders ship sheets from named Handlebars partials. Each name resolves
to a default path under `templates/actor/partials/<name>.hbs`. Override any
of them with `ShipCombat.registerPartialOverride(name, path)` during the
companion module's `init` hook.

The full inventory of valid names is in `scripts/templates.js`. Override
paths must consume the same context shape and emit the same `data-action`
attributes as the defaults, otherwise event wiring breaks.

| Group | Partial name |
| --- | --- |
| **Sheet headers** | `ship-header`, `npc-ship-header`, `station-header` |
| **Shared UI** | `complete-turn`, `core-status-banner`, `payload-status-badge`, `command-deck-bar` |
| **Vessel (torpedo / strike craft)** | `vessel-resource-bar`, `vessel-movement-controls`, `vessel-weapon-traits`, `vessel-turn-complete`, `vessel-trait-summary` |
| **Captain** | `captain-claim-prompt`, `captain-status-bar`, `captain-leadership`, `captain-voidshields`, `captain-conditions`, `captain-core-actions`, `captain-hand`, `captain-active-orders`, `combined-core-actions`, `combined-leadership`, `deployed-strike-craft`, `deployed-torpedoes` |
| **Ordnance Master** | `ordnance-claim-prompt`, `ordnance-captain-boost`, `ordnance-status-bar`, `ordnance-requisition`, `ordnance-main-actions`, `ordnance-payload`, `ordnance-core-actions`, `ordnance-deployed` |
| **Engineer** | `engineer-claim-prompt`, `engineer-captain-boost`, `engineer-status-bar`, `engineer-core-distribution`, `engineer-heat-management`, `engineer-fire-suppression`, `engineer-hull-repair` |
| **Pilot** | `pilot-claim-prompt`, `pilot-captain-boost`, `pilot-status-bar`, `pilot-helm-sl-alloc`, `pilot-helm-control`, `pilot-overcharged-actions` |
| **Sensors** | `sensors-claim-prompt`, `sensors-captain-boost`, `sensors-status-bar`, `sensors-radar`, `sensors-radar-popout`, `sensors-bda`, `sensors-abilities-ref` |
| **Gunner** | `gunner-claim-prompt`, `gunner-captain-boost`, `gunner-status-bar`, `gunner-combined-status-bar`, `gunner-ordnance-allocation`, `gunner-core-actions`, `gunner-weapon-batteries` |
| **Component item sheet** | `component-extended-fields` ← **the main one to override** |

The most commonly overridden slot is **`component-extended-fields`** — rendered
at the bottom of the component item sheet's Details tab. Empty by default;
override it to expose UI for the fields you declared in
`getComponentSchemaExtensions()`.

---

## AppV1 vs AppV2

Core defaults to Foundry's **ApplicationV2** (AppV2) for all ship sheets. To
use the legacy AppV1 bridge (required by some systems, e.g. SF2e), override
two adapter methods:

```js
get useApplicationV1() { return true; }
get SheetBaseClassV1() { return foundry.appv1.sheets.ActorSheet; }
```

When `useApplicationV1` is `true`:

- Core registers `ShipSheetV1Mixin(SheetBaseClassV1)` instead of `ShipSheetV2Mixin(SheetBaseClass)`.
- The popup resolver automatically selects the bundled V1-compatible popups
  (`TargetingPopupV1`, `RamTargetPopupV1`, etc.) for any key not explicitly
  registered via `registerPopupOverride`.
- Tab show/hide rules are provided by `styles/appv1-compact.css`; Foundry V14
  removed the global AppV1 hide rule that older modules relied on.

### Popup class resolution

`ShipCombat._popupClass(key, DefaultClass)` resolves in this order:

1. An explicit `registerPopupOverride(key, PopupClass)` call (highest priority).
2. The bundled V1 default for `key` when `useApplicationV1 === true`.
3. `DefaultClass` — the AppV2 popup bundled with core.

Valid keys: `"targeting"`, `"ramTarget"`, `"battleClarity"`, `"strikeCraftAttack"`, `"recoverCraft"`.

### AppV1 action dispatch

AppV1 sheets do not use Foundry's `data-action` system. Core uses a custom
`dispatchAction(type, element)` call on the sheet controller. Register new
actions in `ShipSheetV1Mixin.DEFAULT_OPTIONS.actions`.

---

## Localisation overrides

Core ships neutral default strings. Companion modules supply a
`lang/en.json` that overrides any keys the system flavours differently.
Foundry merges all loaded modules' lang files automatically, so a partial
override file only needs to contain the keys it changes.

Lang values may reference other lang keys with `{{Some.Key}}` syntax;
core resolves those tokens once at `init` so a single change to (say)
`SHIPCOMBAT.Role.Pilot` propagates to every string that mentions the pilot
role. The token form must be a fully-qualified dot path; nesting is not
supported.

---

## Lifecycle hooks

The table below shows every hook core registers and what it does. Hooks
marked with ★ call an adapter method and may interact with companion code.

| Hook | Core action | Adapter note |
| --- | --- | --- |
| *(module eval)* | nothing yet | ★ Companion calls `ShipCombat.configure()`. |
| `init` | Registers actor/item types, sheets, settings, Handlebars helpers; aborts if `configure()` was not called. | ★ Companion may call `registerPartialOverride()` and `registerPopupOverride()`. |
| `setup` | Compiles all partials (defaults + overrides) with Handlebars. | No companion action needed. |
| `socketlib.ready` | Registers socket actions. | — |
| `ready` (×3) | Registers animations; purges orphaned embedded-edit actors; runs one-shot data migrations. | — |
| `preCreateActor` | Sets `disposition`, `lockRotation`, `actorLink`, and `prototypeToken.texture.src` defaults on new ship and ordnance actors. | — |
| `preCreateItem` | Sets `icons/svg/levels.svg` as the fallback icon on new `${MODULE_ID}.component` items. | — |
| `preUpdateActor` | When `system.payloadCount` changes on an ordnance actor, syncs `hull.max` to the new count and resets `hull.value` according to `hullDisplayMode`. | ★ `hullDisplayMode` read from adapter. |
| `canvasReady` | Refreshes shield arc overlays; re-evaluates token visibility; auto-links any unlinked ship tokens on the scene. | — |
| `updateActor` | Refreshes shield arcs and token visibility when a ship actor updates. | — |
| `refreshToken` | Redraws per-token shield/weapon arcs; re-applies visibility overrides. | — |
| `updateToken` | Refreshes arcs and visibility when a ship token moves. | — |
| `deleteToken` | Destroys token overlays; auto-deletes world actors spawned by ordnance launch. | — |
| `updateChatMessage` | When a piloting roll message is mutated (reroll/fortune), reads the new SL and updates pilot allocation state. | ★ Calls `parseRollResultFromMessage()`. |
| `updateCombat` | Advances helm state at turn/round boundaries (auto-move, reset allocations, apply internal fire). | — |
| `canvasTearDown` | Hides helm preview and destroys all arc/shield overlays. | — |
| `renderChatMessage` | Wires BDA-pending chat card buttons. | — |

---

## Layout

```
causodes-shipcombat-core/
├── causodes-shipcombat-core.js   # Entry point, ShipCombat global, all Hooks
├── module.json
├── scripts/
│   ├── constants.js              # MODULE_ID, CORE_MODULE_ID, role/slot keys
│   ├── settings.js               # Global module settings
│   ├── templates.js              # Partial registry + CORE_PARTIAL_DEFAULTS list
│   ├── socket.js                 # socketlib actions
│   ├── lang.js                   # Lang token-substitution helper
│   ├── theme.js
│   ├── animations.js
│   ├── systems/
│   │   └── SystemAdapter.js      # The contract documented above
│   ├── actors/                   # ShipModel, OrdnanceModel, NPC ship, sheet mixins
│   ├── items/                    # ShipComponentSchema, item sheet
│   ├── apps/                     # Targeting, BDA, Strike Craft, V1 popups
│   ├── canvas/                   # Helm preview, arc/shield overlays, radar
│   ├── roles/                    # Per-role action handlers (captain, gunner, …)
│   └── state/                    # ShipCombatState + per-role state slices
├── styles/
│   ├── appv1-compact.css         # Tab show/hide rules for AppV1 sheets
│   └── custom-class-compat.css   # Compat shims for systems that inject CSS classes
├── templates/                    # Sheets, partials, chat cards
└── lang/en.json                  # Neutral default strings
```


---
