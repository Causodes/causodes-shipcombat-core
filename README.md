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

## The `SystemAdapter` contract

All abstract or overridable methods live on the
`SystemAdapter` base class in
[scripts/systems/SystemAdapter.js](scripts/systems/SystemAdapter.js). The
table below summarises what each method does and what core does with the
return value. Methods marked **abstract** throw if not overridden;
**overridable** methods have a sensible default and only need overriding
when the host system disagrees with it.

### Identity

| Method | Kind | Purpose |
| --- | --- | --- |
| `get moduleId` | abstract | Returns the companion module's Foundry ID. Used for socket scopes, settings namespaces, and template paths owned by the companion. |
| `get systemName` | abstract | Foundry system ID this adapter targets (e.g. `"impmal"`, `"pf2e"`). Used to gate adapter activation. |

### Sheets and data models

| Method | Kind | Purpose |
| --- | --- | --- |
| `get SheetBaseClass` | abstract | Base class extended by ship/ordnance ApplicationV2 sheets. Usually the system's own actor sheet base. |
| `get ItemSheetBaseClass` | abstract | Same as above for component item sheets. |
| `get ActorModelBaseClass` | abstract | Base `DataModel` for ship/ordnance actors. |
| `get ItemModelBaseClass` | abstract | Base `DataModel` for component items. |
| `get sheetCSSClasses` | overridable | Array of CSS classes appended to every ship/ordnance sheet for system-specific styling. Default: `[]`. |
| `initModelStubs(model)` | overridable | Called from `computeBase()`. Attach interface stubs the host system expects (`characteristics`, `skills`, …). Default: no-op. |
| `deriveModelData(model)` | overridable | Called from `computeDerived()` after items resolve. Final pass to write derived state. Default: no-op. |
| `applyHullDisplay(model)` | overridable | Translate core's hull representation into whatever the host system / external modules (HealthEstimate, etc.) expect. Default: no-op. |

### Skill resolution

| Method | Kind | Purpose |
| --- | --- | --- |
| `resolveSkill(roleSkill)` | abstract | Decode a "role skill" identifier into `{ key, name }`. Engine-supplied identifiers may be plain skill keys, dotted paths, or per-ship overrides. |
| `getSkillLabel(key)` | overridable | Localised display name for a skill key. Default: the key itself. |
| `getRoleSkillOptions()` | overridable | Selectable options for the per-ship role-skill override dropdowns. Default: `[]`. |
| `getDefaultRoleSkillMapping()` | overridable | Default `{ roleId: { skillKey, specialisation, rootLabel, label } }` lookup used when a ship has no override. Default: `{}`. |

### Roll resolution

The hit-resolution pipeline calls these (in roughly this order) for every
shot fired:

| Method | Kind | Purpose |
| --- | --- | --- |
| `getRollFormula()` | overridable | Foundry roll formula string. Default: `"1d100"`. |
| `getModifierStepSize()` | overridable | The "natural" step size for accuracy/penalty modifiers in this system (10 for d100, 1 for d20, etc.). Drives every `±10`/`±5`-shaped UI bonus. Default: `1`. |
| `formatModifier(value)` / `formatTargetNumber(target)` | overridable | UI formatting (e.g. trailing `%`). Default: bare number / signed number. |
| `rollSkillTest(crewActor, roleSkill, opts)` | abstract | Make a skill test. Returns `{ SL, …}`. Used for non-attack rolls (Augur, Engineering, Piloting, …). |
| `rollShipInitiative(crewActor, roleSkill, opts)` | abstract | Initiative roll for player-crewed ships. |
| `rollShipInitiativeFromAttribute(value, label, opts)` | abstract | Initiative roll for NPC ships (uses a single attribute). |
| `toCombatantInitiative(rawTotal, shipActor)` | overridable | Translate the raw roll total into Foundry's `combatant.initiative`. Default: identity. |
| `isHit(roll, target)` | overridable | Hit determination for one shot. Default: roll-under (`roll.total ≤ target`). |
| `isAutomaticCrit(roll)` | overridable | True if the system's roll-mechanics make this an auto-crit (e.g. nat 100). Default: `false`. |
| `isCriticalHit(roll, target)` | overridable | Crit determination after a hit. Default: `false`. |
| `isJam(roll, target, traits)` | overridable | Weapon jam determination (relevant for Unreliable, etc.). Default: `false`. |
| `computeSuccessLevel(roll, target)` | overridable | Returns SL. Default: difference of target and roll, divided by `modifierStepSize`, rounded. |
| `parseRollResultFromMessage(message)` | overridable | Extract `{ result, target }` from a chat message produced by `rollSkillTest`. Default returns `null`. |
| `getLockTierForSL(sl)` | overridable | Translate SL → sensor lock tier (0-4). Default: clamp to `0..4`. |
| `computeZone1Bonus(totalAccuracy)` | overridable | Close-scan bonus formula. Default: `0`. |
| `resolveHitRoll(context)` | abstract | Full single-shot resolution. Returns `{ hit, sl, roll, message, displayTarget, breakdownParts }`. |

### Component schema extensions

Adapters may declare extra fields stored on every component item (armour
class, hardpoint slots, etc.). Core stores them under `system.extended`.

| Method | Kind | Purpose |
| --- | --- | --- |
| `getComponentSchemaExtensions(componentType)` | overridable | Returns `{ fieldName: foundry.data.fields.DataField }`. Default: `{}`. |
| `getAvailabilityOptions()` | overridable | `{ key: label }` for the item-availability dropdown. Default: `{}`. |

If you declare extension fields, also register a partial override for
`component-extended-fields` so the item sheet renders inputs for them.

### Misc

| Method | Kind | Purpose |
| --- | --- | --- |
| `isCrewActorEligible(actor)` | overridable | Filter for who may occupy bridge stations. Default: `true`. |

---

## Partial override registry

Core renders ship sheets from a fixed inventory of named Handlebars
partials. Each name resolves to a default path under
`templates/actor/partials/<name>.hbs`. Companion modules may swap any of
them with `ShipCombat.registerPartialOverride(name, path)` during their
`init` hook (core compiles partials in `setup`, which runs after every
module's `init`).

The full inventory of valid names is the
`CORE_PARTIAL_DEFAULTS` array in
[scripts/templates.js](scripts/templates.js). Override paths must consume
the same context shape and emit the same `data-action` attributes as the
default, otherwise event wiring breaks.

The most useful slot for adapters:

- **`component-extended-fields`** — rendered at the bottom of the component
  item sheet's Details tab. Empty by default; override it to expose UI for
  the fields you declared in `getComponentSchemaExtensions()`.

---

## Localisation overrides

Core ships neutral default strings. Companion modules supply a
`lang/en.json` that overrides any keys the system flavours differently
(e.g. core's neutral `"Engineer"` becomes `"Engineer"` in the IM
companion). Foundry merges all loaded modules' lang files automatically,
so a partial override file only needs to contain the keys it changes.

Lang values may reference other lang keys with `{{Some.Key}}` syntax;
core resolves those tokens once at `init` so a single change to (say)
`SHIPCOMBAT.Role.Pilot` propagates to every string that mentions the pilot
role. The token form must be a fully-qualified dot path; nesting is not
supported.

---

## Lifecycle hooks

| Hook | What core does | When the adapter sees it |
| --- | --- | --- |
| (module eval) | nothing yet | Adapter calls `ShipCombat.configure()`. |
| `init` | Registers actor/item types, sheets, settings, Handlebars helpers; throws if `configure()` was not called. | Adapter may call `registerPartialOverride()`. |
| `setup` | Compiles all partials (defaults + overrides) and pre-registers them with Handlebars. | — |
| `socketlib.ready` | Registers socket actions. | — |
| `ready` | Boots `ShipCombatState`, performs one-shot data migrations. | — |

---

## Layout

```
causodes-shipcombat-core/
├── causodes-shipcombat-core.js   # Entry point, ShipCombat global, init wiring
├── module.json
├── scripts/
│   ├── constants.js              # MODULE_ID, CORE_MODULE_ID, role/slot keys
│   ├── settings.js               # Global module settings
│   ├── templates.js              # Partial registry + name list
│   ├── socket.js                 # socketlib actions
│   ├── lang.js                   # Lang token-substitution helper
│   ├── theme.js
│   ├── animations.js
│   ├── systems/
│   │   └── SystemAdapter.js      # The contract documented above
│   ├── actors/                   # ShipModel, OrdnanceModel, NPC ship, sheet mixins
│   ├── items/                    # ShipComponentSchema, item sheet
│   ├── apps/                     # Targeting, BDA, Strike Craft popups
│   ├── canvas/                   # Helm preview, arc/shield overlays, radar
│   ├── roles/                    # Per-role action handlers (captain, gunner, …)
│   └── state/                    # ShipCombatState + per-role state slices
├── templates/                    # Sheets, partials, chat cards
└── lang/en.json                  # Neutral default strings
```
