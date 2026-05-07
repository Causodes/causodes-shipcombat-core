/**
 * causodes-shipcombat-core – System-agnostic ship combat engine.
 *
 * A system-specific companion module (e.g. causodes-shipcombat-impmal) MUST call
 * ShipCombat.configure({ moduleId, adapter }) at module-evaluation time — before
 * Foundry fires the "init" hook — to activate the engine.
 *
 * Load order:
 *   (module eval)   → companion calls ShipCombat.configure()
 *   init            → register actor/item types, sheets, settings, Handlebars helpers, templates
 *   socketlib.ready → register socket actions via socketlib
 */

import { MODULE_ID, setModuleId } from "./scripts/constants.js";

// Templates, styles, and other static assets always live in this module.
// This is a compile-time constant and never changes.
const CORE_MODULE_ID = "causodes-shipcombat-core";
import { ShipCombatState } from "./scripts/state/ShipCombatState.js";
import { setupSocket } from "./scripts/socket.js";

import { isOrdnance, isTorpedo, isStrikeCraft, ordnanceSubtype } from "./scripts/actors/ordnance/ordnance-types.js";
import { HelmPreview } from "./scripts/canvas/HelmPreview.js";
import { ShieldArcOverlay } from "./scripts/canvas/ShieldArcOverlay.js";
import { WeaponArcOverlay } from "./scripts/canvas/WeaponArcOverlay.js";
import { StrikeCraftArcOverlay } from "./scripts/canvas/StrikeCraftArcOverlay.js";
import { refreshTokenVisibility, applyTokenVisibility } from "./scripts/canvas/TokenVisibility.js";

import { SystemAdapter } from "./scripts/systems/SystemAdapter.js";
import { registerSettings } from "./scripts/settings.js";
import { registerLangSubstitution } from "./scripts/lang.js";
import { BDAPopup, launchBDAFromChat } from "./scripts/apps/BDAPopup.js";
import { registerAnimations } from "./scripts/animations.js";
import { PartialRegistry, CORE_PARTIAL_DEFAULTS, loadAllTemplates } from "./scripts/templates.js";

// ── Public configuration API ────────────────────────────────────────────────
// A system module MUST call ShipCombat.configure() before Foundry fires "init".
// It MAY register partial overrides during its own "init" hook (core compiles
// partials in "setup", which runs after every module's "init").

let _configured = false;
const _partialRegistry = new PartialRegistry(CORE_PARTIAL_DEFAULTS);

globalThis.ShipCombat = {
  /**
   * Configure the ship combat engine with a module ID and system adapter.
   * Must be called at module-evaluation time by the system companion module.
   * @param {object}        opts
   * @param {string}        opts.moduleId  – Foundry module ID of the calling module.
   * @param {SystemAdapter} opts.adapter   – Concrete SystemAdapter instance.
   */
  configure({ moduleId, adapter }) {
    setModuleId(moduleId);
    SystemAdapter.register(adapter);
    _configured = true;
  },

  /**
   * Replace the path of a named Handlebars partial.
   *
   * Must be called during the companion module's "init" hook (i.e. before
   * core's "setup" hook fires). The override path is responsible for
   * consuming the same context shape and emitting the same data-action
   * outputs as the default partial; see CORE_PARTIAL_DEFAULTS in
   * scripts/templates.js for the inventory of valid names.
   *
   * @param {string} name – Short name of the partial (e.g. "captain-conditions").
   * @param {string} path – Full path of the replacement .hbs file.
   */
  registerPartialOverride(name, path) {
    _partialRegistry.register(name, path);
  },
};

// ── Lang token substitution ────────────────────────────────────────────────
// Must be registered at module-eval time so the i18nInit hook (which fires
// before "init") finds the listener.
registerLangSubstitution();

// ── Handlebars helpers ─────────────────────────────────────────────────────

Handlebars.registerHelper("shipcombatEq",       (a, b) => a === b);
Handlebars.registerHelper("shipcombatNeq",      (a, b) => a !== b);
Handlebars.registerHelper("shipcombatGt",       (a, b) => Number(a) > Number(b));
Handlebars.registerHelper("shipcombatLt",       (a, b) => Number(a) < Number(b));
Handlebars.registerHelper("shipcombatNot",      (v)    => !v);
Handlebars.registerHelper("shipcombatOr",       (a, b) => a || b);
Handlebars.registerHelper("shipcombatTimes", function(n, block) {
  let result = "";
  for (let i = 0; i < n; i++) result += block.fn(i);
  return result;
});
Handlebars.registerHelper("divide",   (a, b) => b !== 0 ? a / b : 0);
Handlebars.registerHelper("multiply", (a, b) => a * b);

// ── Term helper ─────────────────────────────────────────────────────────────
// Usage in templates: {{shipcombatTerm "PowerCore"}} → "Power Core"
// Edit the canonical display string in lang/en.json under SHIPCOMBAT.Term.*
// Role names (Helmsman, Ordnance Master, etc.) live in SHIPCOMBAT.Role.*
Handlebars.registerHelper("shipcombatTerm", key => game.i18n.localize(`SHIPCOMBAT.Term.${key}`));
Handlebars.registerHelper("shipcombatRole", key => game.i18n.localize(`SHIPCOMBAT.Role.${key}`));

// ── init ──────────────────────────────────────────────────────────────────

Hooks.once("init", async () => {
  if (!_configured) {
    console.error(
      "causodes-shipcombat-core | ShipCombat.configure() was not called before the \"init\" hook. " +
      "A system module must call ShipCombat.configure({ moduleId, adapter }) at module-evaluation " +
      "time. Ship combat will not be activated."
    );
    return;
  }

  console.log(`${MODULE_ID} | Initialising ship combat module`);

  // Allow fractional initiative so skill/100 tiebreakers are preserved
  CONFIG.Combat.initiative.decimals = 2;

  // Model/sheet registration is handled by the system companion module.

  registerSettings();

  // Templates are compiled in the "setup" hook (after every module's "init"),
  // which gives the companion module a chance to register overrides via
  // ShipCombat.registerPartialOverride().

  // ── Token visibility override ──────────────────────────────────────────
  // Foundry V13 resets token.visible = this.isVisible inside
  // _refreshVisibility() on every render cycle, so hook-based overrides are
  // immediately undone.  Patch the prototype so our own-ship and sensor-tier
  // logic runs *after* the base method and survives the render pipeline.
  const TokenCls = CONFIG.Token.objectClass;
  const _origRefreshVisibility = TokenCls.prototype._refreshVisibility;
  TokenCls.prototype._refreshVisibility = function () {
    _origRefreshVisibility.call(this);
    // Defer to the module's per-token handler (imported from TokenVisibility.js)
    applyTokenVisibility(this);
  };

  // ── Ordnance token control restriction ─────────────────────────────────
  // Non-GM, non-Ordnance Master players can see friendly ordnance but not select or
  // move it.  Only the ordnance role holder (Ordnance Master) may interact.
  const _origCanControl = TokenCls.prototype._canControl;
  TokenCls.prototype._canControl = function (user, event) {
    if (isOrdnance(this.document.actor)) {
      if (user.isGM) return true;
      const ship = ShipCombatState.ship;
      const myRole = ship?.system?.roles?.[user.id];
      return myRole === "ordnance";
    }
    return _origCanControl.call(this, user, event);
  };
});

// ── setup: compile templates ─────────────────────────────────────────────
// Runs after every module's "init" hook, so any partial overrides registered
// by the system companion module are honoured.
Hooks.once("setup", async () => {
  if (!_configured) return;
  await loadAllTemplates(_partialRegistry);
});

// ── Default component icon ───────────────────────────────────────────────

Hooks.on("preCreateItem", (item, data) => {
  if (item.type !== `${MODULE_ID}.component`) return;
  if (!data.img || data.img === foundry.documents.BaseItem.DEFAULT_ICON) {
    item.updateSource({ img: "modules/impmal-core/assets/icons/weapons/explosive.webp" });
  }
});

// ── Socket ────────────────────────────────────────────────────────────────

Hooks.once("socketlib.ready", () => {
  setupSocket();
  console.log(`${MODULE_ID} | Registered with socketlib`);
});

// ── Optional animations (Sequencer + JB2A) ────────────────────────────────

Hooks.once("ready", () => {
  registerAnimations();
});

// ── Orphaned embeddedEdit actor cleanup ───────────────────────────────────
// If Foundry (or the browser) is closed while a temp "Edit" actor sheet is
// still open, the patched sheet.close() never runs and the actor is never
// deleted.  On the next ready we purge any survivors so they don't pile up.
Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  const orphans = game.actors.filter(a => a.getFlag(MODULE_ID, "embeddedEdit"));
  if (!orphans.length) return;
  console.log(`causodes-shipcombat-core | Cleaning up ${orphans.length} orphaned embeddedEdit actor(s).`);
  await Actor.deleteDocuments(orphans.map(a => a.id));
});

// ── shipOrdnance migration ────────────────────────────────────────────
// Converts legacy torpedo and strikeCraft world actors (and any embedded
// ordnanceActors template data stored on ships) to the unified
// shipOrdnance type.  Runs once; records a version flag so it never
// repeats.  GM-only.
const MIGRATION_VERSION = "1.0.0-shipOrdnance";
Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  const alreadyRan = game.settings.get(MODULE_ID, "migrationVersion") === MIGRATION_VERSION;
  if (alreadyRan) return;

  const legacyTorpedo    = `${MODULE_ID}.torpedo`;
  const legacyStrikeCraft = `${MODULE_ID}.strikeCraft`;
  const unified          = `${MODULE_ID}.shipOrdnance`;

  // ── World actors ──
  const worldActors = game.actors.filter(
    a => a.type === legacyTorpedo || a.type === legacyStrikeCraft,
  );
  if (worldActors.length) {
    console.log(`causodes-shipcombat-core | Migrating ${worldActors.length} world ordnance actor(s) to shipOrdnance.`);
    for (const actor of worldActors) {
      const subtype = actor.type === legacyTorpedo ? "torpedo" : "strikeCraft";
      await actor.update({ type: unified, "system.subtype": subtype });
    }
  }

  // ── Embedded ordnanceActors template data stored on ships (actorData blobs) ──
  const shipTypes = [`${MODULE_ID}.ship`, `${MODULE_ID}.npcShip`];
  const ships = game.actors.filter(a => shipTypes.includes(a.type));
  for (const ship of ships) {
    const slots = ship.system?.ordnanceActors ?? {};
    const updates = {};
    for (const slotKey of ["torpedo", "strikeCraft"]) {
      const templates = slots[slotKey] ?? [];
      let changed = false;
      const updated = templates.map(ref => {
        if (!ref?.actorData) return ref;
        if (ref.actorData.type !== legacyTorpedo && ref.actorData.type !== legacyStrikeCraft) return ref;
        const subtype = ref.actorData.type === legacyTorpedo ? "torpedo" : "strikeCraft";
        changed = true;
        return {
          ...ref,
          actorData: {
            ...ref.actorData,
            type: unified,
            system: { ...(ref.actorData.system ?? {}), subtype },
          },
        };
      });
      if (changed) updates[`system.ordnanceActors.${slotKey}`] = updated;
    }
    if (Object.keys(updates).length) {
      console.log(`causodes-shipcombat-core | Updating embedded ordnance templates on ship "${ship.name}".`);
      await ship.update(updates);
    }
  }

  // ── Scene tokens ── (update actorData overrides on unlinked tokens if any)
  for (const scene of game.scenes) {
    const tokens = scene.tokens.filter(
      td => td.actorData?.type === legacyTorpedo || td.actorData?.type === legacyStrikeCraft,
    );
    for (const td of tokens) {
      const subtype = td.actorData.type === legacyTorpedo ? "torpedo" : "strikeCraft";
      await td.update({
        "actorData.type": unified,
        "actorData.system.subtype": subtype,
      });
    }
  }

  // Record completion
  await game.settings.set(MODULE_ID, "migrationVersion", MIGRATION_VERSION);
  console.log(`causodes-shipcombat-core | shipOrdnance migration complete.`);
  ui.notifications.info("Ship Combat: ordnance migration to shipOrdnance complete. Please refresh if sheets look wrong.");
});

// ── Ghost cleanup on canvas teardown ──────────────────────────────────────

Hooks.on("canvasTearDown", () => {
  HelmPreview.hide();
  ShieldArcOverlay.destroyAll();
  WeaponArcOverlay.destroyAll();
  StrikeCraftArcOverlay.destroyAll();
});

// ── Ship token defaults ──────────────────────────────────────────────────────
// Sets friendly disposition and disables artwork rotation lock when a new
// ship actor is created (before it is written to the database).

Hooks.on("preCreateActor", (actor, data) => {
  if (actor.type === `${MODULE_ID}.ship`) {
    actor.updateSource({
      "prototypeToken.disposition": CONST.TOKEN_DISPOSITIONS.FRIENDLY,
      "prototypeToken.lockRotation": false,
      "prototypeToken.actorLink": true,
    });
  } else if (actor.type === `${MODULE_ID}.npcShip`) {
    actor.updateSource({
      "prototypeToken.disposition": CONST.TOKEN_DISPOSITIONS.HOSTILE,
      "prototypeToken.lockRotation": false,
      "prototypeToken.actorLink": true,
      "prototypeToken.hidden": true,
    });
  } else if (isOrdnance(actor)) {
    // Torpedoes and strike craft (legacy types or unified shipOrdnance).
    if (!game.user.isGM && !data.flags?.[MODULE_ID]?.fromOrdnanceMaster) {
      ui.notifications.error("Ordnance can only be launched from the Ordnance Master role.");
      return false;
    }
    actor.updateSource({
      "prototypeToken.disposition": CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      "prototypeToken.lockRotation": false,
      "prototypeToken.actorLink": true,
    });
    // When created manually (not from Ordnance Master), set sane hull defaults
    if (!data.flags?.[MODULE_ID]?.fromOrdnanceMaster) {
      actor.updateSource({ "system.hull": { value: 0, max: 1 } });
    }
  }
});

// ── Shield Arc Overlay ───────────────────────────────────────────────────────

Hooks.on("canvasReady", () => {
  ShieldArcOverlay.refresh();
  refreshTokenVisibility();

  // Auto-link any existing unlinked ship tokens so that world-actor data
  // and token-actor data stay in sync (role assignments, combat state, etc.).
  if (game.user.isGM && canvas?.scene) {
    const shipTypes = [`${MODULE_ID}.ship`, `${MODULE_ID}.npcShip`];
    const unlinked = canvas.scene.tokens.filter(
      t => shipTypes.includes(t.actor?.type) && !t.actorLink
    );
    for (const td of unlinked) {
      console.warn(`${MODULE_ID} | Auto-linking unlinked ship token "${td.name}" (${td.id})`);
      td.update({ actorLink: true });
    }
  }
});

Hooks.on("updateActor", (actor) => {
  if (actor.type === `${MODULE_ID}.ship` || actor.type === `${MODULE_ID}.npcShip`) {
    ShieldArcOverlay.refresh();
    refreshTokenVisibility();
  }
});

// refreshToken fires every time a token is redrawn, including each frame of
// movement animation and during manual drag  -  giving smooth overlay tracking.
// applyTokenVisibility runs AFTER all render flags are resolved, ensuring our
// visibility overrides survive Foundry's _refreshState / _refreshVisibility.
Hooks.on("refreshToken", (token) => {
  ShieldArcOverlay._redrawToken(token);
  WeaponArcOverlay.onRefreshToken(token);
  applyTokenVisibility(token);
});

// When a ship token's committed position changes (drag released, animation end),
// re-evaluate lock tiers with the new position so autoscan overlays appear/vanish.
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (!("x" in changes || "y" in changes)) return;
  const actor = tokenDoc.actor;
  if (!actor) return;
  if (actor.type === `${MODULE_ID}.ship` || actor.type === `${MODULE_ID}.npcShip`) {
    ShieldArcOverlay.refresh();
    refreshTokenVisibility();
  }
});

// When a token is deleted, destroy its shield overlay immediately.
Hooks.on("deleteToken", (tokenDoc) => {
  ShieldArcOverlay._destroyToken(tokenDoc.id);
  WeaponArcOverlay.destroyAll();

  // Auto-delete world actors spawned by ordnance launch
  if (game.user.isGM && tokenDoc.actor?.flags?.[MODULE_ID]?.fromOrdnanceMaster) {
    // Track destroyed strike craft (does not come back during the fight)
    // Skip if craft is being recovered (not destroyed)
    if (isStrikeCraft(tokenDoc.actor) && !tokenDoc.actor?.flags?.[MODULE_ID]?.recovering && !ShipCombatState._suppressDestroyTracking) {
      const parentTokenId = tokenDoc.actor?.system?.parentShipTokenId;
      if (parentTokenId) {
        const parentToken = canvas?.scene?.tokens.get(parentTokenId);
        const ship = parentToken?.actor;
        if (ship) {
          const current = ship.system?.resources?.ordnance?.craftDestroyed ?? 0;
          ship.update({ "system.resources.ordnance.craftDestroyed": current + 1 });
        }
      }
    }
    const actorId = tokenDoc.actorId;
    const actor = game.actors.get(actorId);
    if (actor) actor.delete();
  }

  // Re-render any open ship sheets so Deployed Ordnance list updates live
  const parentId = tokenDoc.actor?.system?.parentShipTokenId;
  if (parentId) {
    const parentToken = canvas?.scene?.tokens.get(parentId);
    if (parentToken?.actor?.sheet?.rendered) {
      parentToken.actor.sheet.render();
    }
  }
});

// ── Reroll detection: if a tracked piloting message is updated, sync new SL ──

Hooks.on("updateChatMessage", (message, changes) => {
  // Only the GM should write back to the ship actor
  if (!game.user.isGM) return;

  const ship = ShipCombatState.ship;
  if (!ship) return;

  const trackedId = ship.system.resources?.pilot?.pilotingMessageId;
  if (!trackedId || message.id !== trackedId) return;

  // The message's system data may have been updated by a reroll
  const newSL = SystemAdapter.current.parseRollResultFromMessage(message).SL;
  if (newSL == null) return;

  const clampedSL = Math.max(0, newSL);
  const currentSL = ship.system.resources?.pilot?.pilotingSL ?? 0;
  if (clampedSL === currentSL) return;

  // Update SL and reset allocations if they exceed the new pool
  const allocSpeed = ship.system.resources?.pilot?.allocSpeed ?? 0;
  const allocMano  = ship.system.resources?.pilot?.allocMano  ?? 0;
  const updates = { "resources.pilot.pilotingSL": clampedSL };
  if (allocSpeed + allocMano > clampedSL) {
    updates["resources.pilot.allocSpeed"] = 0;
    updates["resources.pilot.allocMano"]  = 0;
  }
  ShipCombatState.update(updates);
});

// ── Sync helm reset with Foundry combat tracker turn/round advancement ────
// When the ship's turn ends in the Foundry tracker: auto-move if idle,
// When the ship's turn ends: auto-move at minimum speed if idle.
// When the ship's turn starts: apply Internal Fire → Hull Damage, then reset
// helm state and all allocations for the new turn.

Hooks.on("updateCombat", async (combat, changes) => {
  if (!game.user.isGM) return;
  if (!("round" in changes) && !("turn" in changes)) return;

  const ship = ShipCombatState.ship;
  if (!ship) return;

  const shipCombatant = combat.combatants.find(c => c.actor?.id === ship.id);
  if (!shipCombatant) return;

  const prevCombatantId    = combat.previous?.combatantId;
  const currentCombatantId = combat.combatant?.id;

  // ── Ship's turn ENDED: auto-move at minimum speed if the ship didn't move ──
  if (prevCombatantId === shipCombatant.id) {
    const fuelBurned  = ship.system.resources?.pilot?.fuelBurned ?? 0;
    const token       = ship.getActiveTokens()?.[0];
    const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";

    if (token) {
      const speed = (ship.system.movement?.speed ?? 6)
                  + (ship.system.resources?.pilot?.allocSpeed ?? 0);

      if (isRealistic) {
        // Realistic: always auto-drift the remaining uncarried portion of velocity,
        // regardless of whether the pilot used thrust this turn.
        const vx = ship.system.resources?.pilot?.velocityX ?? 0;
        const vy = ship.system.resources?.pilot?.velocityY ?? 0;
        const momentumUsed   = ship.system.resources?.pilot?.momentumUsed ?? 0;
        const remainFraction = Math.max(0, 1 - momentumUsed / 100);
        const velMag = Math.floor(Math.hypot(vx, vy) * remainFraction);
        if (velMag > 0) {
          const gridSize = canvas.grid.size;
          const tokenW   = token.document.width  * gridSize;
          const tokenH   = token.document.height * gridSize;
          const cx       = token.document.x + tokenW / 2;
          const cy       = token.document.y + tokenH / 2;
          const newCx    = cx + vx * gridSize * remainFraction;
          const newCy    = cy + vy * gridSize * remainFraction;
          await ShipCombatState.confirmMovement({
            fuelUsed:         0,
            driftUsed:        0,
            speed,
            newX:             newCx - tokenW / 2,
            newY:             newCy - tokenH / 2,
            newRotation:      token.document.rotation,
            gridSquaresMoved: velMag,
            velocityX:        vx,
            velocityY:        vy,
          });
        }
      } else if (fuelBurned === 0) {
        // Simplified: auto-move at minimum speed straight ahead only if no thrust used.
        const prevTurnMove = ship.system.resources?.pilot?.prevTurnMove ?? 0;
        const minMove      = Math.ceil(prevTurnMove / 2);
        const bearing      = ship.system.resources?.pilot?.bearing ?? 0;

        if (minMove > 0) {
          const autoMinMovePct = Math.round(minMove / (minMove + speed) * 100);
          const projected = HelmPreview.projectPosition(token, bearing, autoMinMovePct, speed, minMove);
          if (projected) {
            await ShipCombatState.confirmMovement({
              fuelUsed:         autoMinMovePct,
              driftUsed:        0,
              speed:            speed + minMove,
              newX:             projected.x,
              newY:             projected.y,
              newRotation:      projected.rotation,
              gridSquaresMoved: minMove,
            });
          }
        }
      }
    }
    // Process ordnance lifecycle (drift, fuel burn, detonation) at the end of
    // the parent ship's turn so it happens simultaneously with the ship's own
    // turn-end auto-drift — not at the start of the following turn.
    await ShipCombatState.processOrdnanceLifecycle();
  }

  // ── Ship's turn STARTED: apply effects and reset all allocations ───────────
  if (currentCombatantId === shipCombatant.id) {
    // 1. prevTurnMove was set correctly by confirmMovement and persists through resetHelmState.

    // 2. Per-round condition effects  -  capture fire BEFORE updates so Hull High
    //    doesn't also apply the new fire as hull damage in the same tick
    const fireBefore   = ship.system.internalFire ?? 0;
    const sysConds     = ship.system.conditions ?? {};
    const condHullTier = sysConds.hull?.tier;
    const condUp       = {};
    if (condHullTier) {
      const dmgMap = { low: 1, medium: 2, high: 3 };
      const hullVal = ship.system.hull?.value ?? 0;
      const hullMax = ship.system.hull?.max   ?? 40;
      condUp["hull.value"] = Math.min(hullMax, hullVal + (dmgMap[condHullTier] ?? 0));
      if (condHullTier === "high") {
        condUp.internalFire = fireBefore + 5;
      }
    }
    if (sysConds.coreSystems?.tier === "high") {
      condUp["resources.engineer.heat"] = (ship.system.resources?.engineer?.heat ?? 0) + 5;
    }
    if (Object.keys(condUp).length > 0) {
      await ShipCombatState.update(condUp);
    }

    // 3. Internal Fire (pre-condition snapshot) → Hull Damage
    if (fireBefore > 0) {
      const curDamage = ship.system.hull?.value ?? 0;
      const maxDamage = ship.system.hull?.max   ?? 40;
      const newDamage = Math.min(maxDamage, curDamage + fireBefore);
      await ShipCombatState.update({ "hull.value": newDamage });
    }

    // 4. Reset helm state and all allocations for the new turn
    await ShipCombatState.resetHelmState();
    await ShipCombatState.resetActions();
  }

  // ── NPC ship turn STARTED: condition effects, internal fire, flux reset ───
  if (currentCombatantId && canvas?.scene) {
    const currentCombatant = combat.combatants.get(currentCombatantId);
    if (currentCombatant?.actor?.type === `${MODULE_ID}.npcShip`) {
      const npcActor = currentCombatant.actor;
      const npcSys   = npcActor.system;
      const npcUpd   = {};

      // Voidshield flux: reset remaining to max
      const fluxMax = npcSys.voidshieldFlux ?? 0;
      if (fluxMax > 0) {
        npcUpd["system.voidshieldFluxRemaining"] = fluxMax;
      }

      // Hull crit condition: per-round hull damage (Low +1, Medium +2, High +3)
      const conds    = npcSys.conditions ?? {};
      const hullTier = conds.hull?.tier;
      if (hullTier) {
        const dmgMap = { low: 1, medium: 2, high: 3 };
        const hullVal = npcSys.hull?.value ?? 0;
        const hullMax = npcSys.hull?.max   ?? 50;
        npcUpd["system.hull.value"] = Math.min(hullMax, hullVal + (dmgMap[hullTier] ?? 0));
        // Critical Breach (High): also +5 internal fire per round
        if (hullTier === "high") {
          npcUpd["system.internalFire"] = (npcSys.internalFire ?? 0) + 5;
        }
      }

      // Reactor Breach (Core Systems High): +5 heat per round
      if (conds.coreSystems?.tier === "high") {
        const heatMax = npcSys.heatMax ?? 10;
        npcUpd["system.heat"] = Math.min(heatMax, (npcSys.heat ?? 0) + 5);
      }

      // Internal fire → hull damage (uses updated internalFire if just incremented)
      const fire = npcUpd["system.internalFire"] ?? (npcSys.internalFire ?? 0);
      if (fire > 0) {
        const hullVal = npcUpd["system.hull.value"] ?? (npcSys.hull?.value ?? 0);
        const hullMax = npcSys.hull?.max ?? 50;
        npcUpd["system.hull.value"] = Math.min(hullMax, hullVal + fire);
      }

      if (Object.keys(npcUpd).length > 0) {
        await npcActor.update(npcUpd);
      }
    }
  }
});

// ── BDA-Pending chat card: Augur-only launch button ─────────────────────────

Hooks.on("renderChatMessage", (message, html) => {
  const flags = message.flags?.[MODULE_ID];
  if (flags?.type !== "bdaPending") return;

  const btn = html[0]?.querySelector("[data-action='openBDAFromChat']");
  if (!btn) return; // Already in rolled/completed state  -  no button in template

  const augurUserId = flags.augurUserId;
  if (game.user.id !== augurUserId) {
    btn.remove();
    return;
  }

  let _launching = false;
  btn.addEventListener("click", async () => {
    if (_launching) return;
    _launching = true;
    btn.disabled = true;

    const ship = ShipCombatState.ship;
    if (!ship) { _launching = false; btn.disabled = false; return; }

    await launchBDAFromChat(ship, message);
  });
});

// ── Public API ────────────────────────────────────────────────────────────

window.ImpMalShipCombat = {
  ShipCombatState,
  HelmPreview,
  getShip: () => ShipCombatState.ship,
};
