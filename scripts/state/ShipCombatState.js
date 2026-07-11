/**
 * ShipCombatState – all state lives directly in the Ship actor's system data.
 *
 * The active ship is the first actor of type "impmal-shipcombat.ship" found in
 * the current combat tracker; if no combat is running it falls back to the
 * first such actor in the world.  The GM is the only one who writes via
 * actor.update(); players request changes through the socket (see socket.js).
 *
 * Domain-specific methods are defined in separate files and attached as static
 * methods below.  This keeps the core infrastructure small while preserving
 * the same public API  -  callers still use ShipCombatState.fireWeapon(), etc.
 */

import { MODULE_ID, CORE_MODULE_ID, DEFAULT_COMBAT_STATE, LOCK_DECAY_ROUNDS, buildCaptainDeck } from "../constants.js";
import { isOrdnance, isTorpedo, isStrikeCraft } from "../actors/ordnance/ordnance-types.js";

// ── Domain imports ──────────────────────────────────────────────────────────
import * as GunnerState    from "./gunner-state.js";
import * as PilotState     from "./pilot-state.js";
import * as EngineerState from "./engineer-state.js";
import * as SensorsState   from "./sensors-state.js";
import * as OrdnanceState  from "./ordnance-state.js";
import * as CritState      from "./crit-state.js";
import * as CaptainState   from "./captain-state.js";
import { HelmPreview }     from "../canvas/HelmPreview.js";
import { SystemAdapter }   from "../systems/SystemAdapter.js";

export class ShipCombatState {

  /** Suppresses the deleteToken hook's craftDestroyed counter during fullReset. */
  static _suppressDestroyTracking = false;

  // ── Ship resolution ───────────────────────────────────────────────────────

  static get ship() {
    if (game.combat) {
      const combatant = game.combat.combatants.find(
        c => c.actor?.type === `${MODULE_ID}.ship`
      );
      if (combatant?.actor) return combatant.actor;
    }
    // game.actors only includes actors the current user has Limited+ on.
    // Fall back to canvas scene tokens so Observer-level players can resolve
    // the ship even when their world-actor collection omits it.
    const worldActor = game.actors.find(a => a.type === `${MODULE_ID}.ship`);
    if (worldActor) return worldActor;
    if (canvas?.scene) {
      const tokenDoc = canvas.scene.tokens.find(
        t => t.actor?.type === `${MODULE_ID}.ship`
      );
      if (tokenDoc?.actor) return tokenDoc.actor;
    }
    return null;
  }

  /** @deprecated kept for backward-compat while HUDs are migrated */
  static get combat() {
    return game.combat ?? null;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  static getData() {
    return SystemAdapter.current.getShipData(this.ship) ?? foundry.utils.deepClone(DEFAULT_COMBAT_STATE);
  }

  // ── Write (GM only) ───────────────────────────────────────────────────────

  /** Replace the entire system object on the Ship actor (rare – prefer update). */
  static async setData(data) {
    if (!this.ship) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return;
    }
    return this.ship.update({ system: data });
  }

  /**
   * Partial update using dotted-path notation relative to `system`.
   * e.g. update({ "roles.abc123": "pilot", "active": true })
   */
  static async update(changes) {
    if (!this.ship) {
      ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return;
    }
    const prefixed = {};
    for (const [k, v] of Object.entries(changes)) {
      prefixed[`system.${k}`] = v;
    }
    return this.ship.update(prefixed);
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  static getRoleForUser(userId) {
    return this.getData().roles?.[userId] ?? null;
  }

  static async assignRole(userId, roleId, actorRef = null) {
    const data = this.getData();
    const roles = data.roles ?? {};
    const changes = {};

    const existing = Object.entries(roles).find(([, r]) => r === roleId);
    if (existing && existing[0] !== userId) {
      changes[`roles.-=${existing[0]}`] = null;
    }

    if (userId) {
      const previousForUser = roles[userId];
      if (previousForUser && previousForUser !== roleId) {
        changes[`roles.-=${userId}`] = null;
        changes[`crewActors.-=${previousForUser}`] = null;
      }
      changes[`roles.${userId}`] = roleId;
      if (actorRef) {
        changes[`crewActors.${roleId}`] = actorRef;
      }
    } else {
      if (existing) {
        changes[`roles.-=${existing[0]}`] = null;
      }
      changes[`crewActors.-=${roleId}`] = null;
    }

    return this.update(changes);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  static async markOverchargeUsed(roleId) {
    const data      = this.getData();
    const coreCount = data.resources?.[roleId]?.coreCount ?? 0;
    if (coreCount <= 0) return;
    return this.update({
      [`resources.${roleId}.coreCount`]: coreCount - 1,
    });
  }

  static async toggleTurnDone(roleId) {
    const current = this.getData()?.turnDone?.[roleId] ?? false;
    return this.update({ [`turnDone.${roleId}`]: !current });
  }

  static async resetActions() {
    const data = this.getData();
    const wasVentPending = data.ventPending ?? false;

    const reactor   = this.getReactorStats();
    const shieldCfg = this.getShieldStats();

    const max = reactor.coreOutput;

    // ── Shield commitment → pool conversion ──
    const committed = data.shieldPool?.committed ?? 0;
    const newFlux   = Math.min(committed * reactor.shieldStrengthPerCore, shieldCfg.maxVoidFlux);

    // ── Auxiliary Power: generated from unspent cores × multiplier ──
    const coresAvailable = data.resources?.engineer?.powerCores ?? 0;
    const reserveMult    = reactor.reserveMultiplier;
    const prevAP         = data.resources?.engineer?.auxiliaryPower ?? 0;
    const apGain         = coresAvailable * reserveMult;
    const auxPowerCap    = reactor.auxPowerCapacity;

    const updates = {
      "resources.engineer.actionChoices": [],
      "resources.engineer.extraActions":   0,
      "resources.engineer.stagedShieldCores": 0,
      "resources.engineer.stagedAuxCores": 0,
      "resources.engineer.auxiliaryPower": Math.min(auxPowerCap, prevAP + apGain),
      "resources.pilot.overdrive": false,
      "resources.pilot.apThrustBonus": 0,
      "shieldPool.current":   newFlux,
      "shieldPool.committed": 0,
      ventLocked: wasVentPending,
      ventPending: false,
    };

    updates["resources.engineer.powerCores"] = wasVentPending ? 0 : max;

    for (const roleId of Object.keys(data.turnDone ?? {})) {
      updates[`turnDone.${roleId}`] = false;
    }
    for (const roleId of Object.keys(data.overchargeUsed ?? {})) {
      updates[`overchargeUsed.${roleId}`] = false;
    }
    for (const uid of Object.keys(data.assignedCores ?? {})) {
      updates[`assignedCores.${uid}`] = false;
    }
    for (const uid of Object.keys(data.resources?.engineer?.stagedCores ?? {})) {
      updates[`resources.engineer.stagedCores.${uid}`] = false;
    }

    // Apply dispatched auxiliary cores at the start of the new round.
    const committedAuxCores = data.resources?.engineer?.committedAuxCores ?? 0;
    if (committedAuxCores > 0) {
      const reactorStats = this.getReactorStats();
      const reserveMult = reactorStats.reserveMultiplier;
      const auxCap      = reactorStats.auxPowerCapacity;
      const currentAux = data.resources?.engineer?.auxiliaryPower ?? 0;
      updates["resources.engineer.auxiliaryPower"] = Math.min(auxCap, currentAux + committedAuxCores * reserveMult);
      updates["resources.engineer.committedAuxCores"] = 0;
    }
    // AP Shutdown (Core Systems High): AP cannot increase  -  clamp any gains back to prevAP
    if (data.conditions?.coreSystems?.tier === "high") {
      updates["resources.engineer.auxiliaryPower"] = prevAP;
    }

    // ── Augur: reset per-turn flags (NO passive data regen) ──
    updates["resources.sensors.actionUsed"]        = false;
    updates["resources.sensors.coreActionUsed"]    = false;
    updates["resources.sensors.bdaAvailable"]      = false;
    updates["resources.sensors.bdaCorrectionPending"] = false;
    updates["resources.sensors.bdaResultSL"]       = 0;
    updates["resources.sensors.bdaTargetTokenId"]  = null;
    updates["resources.sensors.fireCorrection"]    = null;

    const prevEffects = data.resources?.sensors?.effects ?? [];
    const hasLockHarmonics = prevEffects.some(e => e.actionId === "lockHarmonics");

    // Expire sensor effects
    updates["resources.sensors.effects"] = prevEffects
      .map(e => ({ ...e, roundsRemaining: e.roundsRemaining - 1 }))
      .filter(e => e.roundsRemaining > 0);

    // Lock decay
    const prevLocks = data.resources?.sensors?.locks ?? [];
    const lockDecayBonus = hasLockHarmonics ? 1 : 0;
    updates["resources.sensors.locks"] = prevLocks
      .map(l => {
        const remaining = (l.decayRounds ?? 1) - 1 + lockDecayBonus;
        if (remaining > 0) return { ...l, decayRounds: remaining };
        const newTier = (l.tier ?? 1) - 1;
        if (newTier <= 0) return null;
        return { ...l, tier: newTier, decayRounds: LOCK_DECAY_ROUNDS[newTier] ?? 1 };
      })
      .filter(Boolean);

    // ── Gunner: lance charge persists (ammo passive regen REMOVED) ──

    // ── Gunner: reset per-turn SL allocation ──
    updates["resources.gunner.ordnanceSL"]       = 0;
    updates["resources.gunner.allocAccuracy"]    = 0;
    updates["resources.gunner.allocPenetration"] = 0;
    updates["resources.gunner.allocFirepower"]   = 0;
    updates["resources.gunner.slLocked"]         = false;
    updates["resources.gunner.ordnanceRolled"]   = false;
    updates["resources.gunner.arcOverlayActive"] = false;
    updates["resources.gunner.sensorBandExpanded"] = false;
    updates["resources.gunner.chooseCritLocation"] = false;
    updates["resources.gunner.critLocationChoice"]  = null;
    updates["resources.gunner.firedWeaponIds"]      = [];

    // Shield overallocation decay
    for (const sector of ["bow", "stern", "port", "starboard"]) {
      const zt = shieldCfg.zoneThresholds?.[sector] ?? 0;
      const sv = data.shields?.[sector] ?? 0;
      if (sv > zt) updates[`shields.${sector}`] = zt;
    }

    // ── Ordnance Master: reset action flags ──
    updates["resources.ordnance.actionUsed"]     = false;
    updates["resources.ordnance.coreActionUsed"] = false;

    // ── Payloads: expire after one round ──
    updates["resources.gunner.payload"]    = "";
    updates["resources.pilot.payload"]     = "";
    updates["resources.sensors.payload"]   = "";
    updates["resources.engineer.payload"] = "";

    // ── Ordnance Master: reset per-turn SL allocation and roll ──
    updates["resources.ordnance.bosunSL"]      = 0;
    updates["resources.ordnance.bosunRolled"]  = false;
    updates["resources.ordnance.allocEfficiency"] = 0;
    updates["resources.ordnance.allocExpedience"] = 0;

    // ── Captain: reset triage budget + per-round card state + leadership roll ──
    updates["resources.captain.triageCount"]          = 2;
    updates["resources.captain.triageConditionsUsed"] = [];
    updates["resources.captain.handCapBonus"]          = 0;
    updates["resources.captain.playedCards"]           = [];
    updates["resources.captain.holdTheLineActive"]     = false;
    updates["resources.captain.hardenedShields"]        = false;
    updates["resources.gunner.captainHitBonus"]        = 0;
    updates["resources.pilot.hardOverActive"]           = false;
    updates["resources.sensors.sensorPriorityActive"]   = false;
    // ── Per-role power core count + played actions ──
    for (const roleId of ["gunner", "pilot", "sensors", "ordnance"]) {
      updates[`resources.${roleId}.coreCount`]         = 0;
      updates[`resources.${roleId}.coreActionsPlayed`] = [];
    }
    updates["resources.captain.mulliganUsed"]         = false;

    // ── Initiative: carry allocInitiative bonus forward to Foundry combat tracker ──
    const rolledInitiative_ar = data.resources?.captain?.rolledInitiative ?? 0;
    const allocInitiative_ar  = data.resources?.captain?.allocInitiative  ?? 0;
    if ((rolledInitiative_ar > 0 || allocInitiative_ar > 0) && game.combat) {
      const shipCombatant = game.combat.combatants.find(c => c.actor?.id === this.ship?.id);
      if (shipCombatant) {
        await game.combat.setInitiative(shipCombatant.id, rolledInitiative_ar + allocInitiative_ar);
      }
    }

    updates["resources.captain.leadershipRolled"]     = false;
    updates["resources.captain.leadershipSL"]         = 0;
    updates["resources.captain.allocInspire"]         = 0;
    updates["resources.captain.allocResolve"]         = 0;
    updates["resources.captain.allocInitiative"]      = 0;
    updates["resources.captain.coreActionUsed"]            = false;
    updates["resources.captain.selectedCoreAction"]        = null;
    updates["resources.captain.priorityTargetId"]          = null;
    updates["resources.captain.acceleratedLoadingActive"]  = false;
    updates["resources.captain.coreCount"]                 = 0;
    updates["resources.engineer.actionChoices"]           = [];
    updates["resources.engineer.extraActions"]            = 0;

    // ── Stance promotion: pendingStance → stance (atomic with all other captain resets) ──
    const pendingStanceVal = data.resources?.captain?.pendingStance ?? "";
    if (pendingStanceVal) {
      updates["resources.captain.stance"]        = pendingStanceVal;
      updates["resources.captain.pendingStance"] = "";
    }

    // ── Ordnance Master: tick down crew commitments, return crew ──
    const acceleratedLoading = data.resources?.captain?.acceleratedLoadingActive ?? false;
    const prevCommitments = data.resources?.ordnance?.commitments ?? [];
    const storedManpowerMax = data.resources?.ordnance?.manpowerMax ?? 0;
    // Initialize manpowerMax from component if not yet set
    const componentManpower = this.getOrdnanceBayStats().manpower;
    const manpowerMax = storedManpowerMax > 0 ? storedManpowerMax : componentManpower;
    if (storedManpowerMax === 0 && componentManpower > 0) {
      updates["resources.ordnance.manpowerMax"] = componentManpower;
      updates["resources.ordnance.manpower"]    = componentManpower;
    }
    let   manpoolReturn   = 0;
    const nextCommitments = [];
    const completedActions = [];
    for (const c of prevCommitments) {
      const remaining = (c.turnsRemaining ?? 1) - (acceleratedLoading ? 2 : 1);
      if (remaining <= 0) {
        manpoolReturn += c.crewCount ?? 0;
        completedActions.push(c.action);
      } else {
        nextCommitments.push({ ...c, turnsRemaining: remaining });
      }
    }
    updates["resources.ordnance.commitments"] = nextCommitments;
    const prevMan = data.resources?.ordnance?.manpower ?? 0;
    updates["resources.ordnance.manpower"] = Math.min(manpowerMax, prevMan + manpoolReturn);

    // ── Ordnance Master commitment completion side effects ──
    for (const actionId of completedActions) {
      if (actionId === "damageControl") {
        const fire = data.internalFire ?? 0;
        if (fire > 0) {
          updates.internalFire = Math.max(0, (updates.internalFire ?? fire) - 1);
        }
      }
      if (actionId === "hullRepairParty") {
        const hullSys     = SystemAdapter.current.getShipData(this.ship)?.hull;
        const hullCurrent = hullSys?.value ?? 0;
        const hullMax     = hullSys?.max   ?? 0;
        const isHPMode    = SystemAdapter.current.hullDisplayMode === "hpRemaining";
        const isDamaged   = isHPMode ? hullCurrent < hullMax : hullCurrent > 0;
        if (isDamaged) {
          const repairAmt = 2;
          const current   = updates["hull.value"] ?? hullCurrent;
          updates["hull.value"] = isHPMode
            ? Math.min(hullMax, current + repairAmt)
            : Math.max(0, current - repairAmt);
        }
      }
      if (actionId === "loadAmmo") {
        const gunAmmo = data.resources?.gunner?.ammo ?? 0;
        const ammoCap = this.getOrdnanceBayStats().ammoCapacity ?? 0;
        const reloadAmt = Math.ceil(ammoCap * 0.2);
        updates["resources.gunner.ammo"] = Math.min(ammoCap, (updates["resources.gunner.ammo"] ?? gunAmmo) + reloadAmt);
      }
      if (actionId === "armTorpedo") {
        const armed = data.resources?.ordnance?.armedTorpedoes ?? 0;
        updates["resources.ordnance.armedTorpedoes"] = (updates["resources.ordnance.armedTorpedoes"] ?? armed) + 1;
      }
      if (actionId === "armCraft") {
        const armed = data.resources?.ordnance?.armedCraft ?? 0;
        updates["resources.ordnance.armedCraft"] = (updates["resources.ordnance.armedCraft"] ?? armed) + 1;
      }
      if (actionId === "loadPayload") {
        const avail = data.resources?.ordnance?.availablePayloads ?? 0;
        updates["resources.ordnance.availablePayloads"] = (updates["resources.ordnance.availablePayloads"] ?? avail) + 1;
      }
      if (actionId === "generatePower") {
        const reactorStats = this.getReactorStats();
        const auxCap       = reactorStats.auxPowerCapacity;
        const currentAux   = data.resources?.engineer?.auxiliaryPower ?? 0;
        // AP Shutdown (Core Systems High): AP cannot increase
        if (data.conditions?.coreSystems?.tier !== "high") {
          updates["resources.engineer.auxiliaryPower"] = Math.min(auxCap, (updates["resources.engineer.auxiliaryPower"] ?? currentAux) + reactorStats.reserveMultiplier);
        }
      }
      if (actionId === "recallCraft") {
        const recovering = data.resources?.ordnance?.craftRecovering ?? 0;
        if (recovering > 0) {
          updates["resources.ordnance.craftRecovering"] = (updates["resources.ordnance.craftRecovering"] ?? recovering) - 1;
          const armed = data.resources?.ordnance?.armedCraft ?? 0;
          updates["resources.ordnance.armedCraft"] = (updates["resources.ordnance.armedCraft"] ?? armed) + 1;
        }
      }
      if (actionId === "bayOptimization") {
        // Accelerate all remaining commitments by 1 extra turn
        const nextCommitments = updates["resources.ordnance.commitments"] ?? [...(data.resources?.ordnance?.commitments ?? [])];
        updates["resources.ordnance.commitments"] = nextCommitments.map(c => ({
          ...c,
          turnsRemaining: Math.max(0, (c.turnsRemaining ?? 1) - 1),
        }));
      }
    }

    // ── Crew casualty: internal fire reduces manpower max ──
    const holdTheLineActive = data.resources?.captain?.holdTheLineActive ?? false;
    const internalFire = data.internalFire ?? 0;
    if (internalFire > 0 && !holdTheLineActive) {
      const currentMax = data.resources?.ordnance?.manpowerMax ?? 0;
      const newMax = Math.max(0, currentMax - internalFire);
      updates["resources.ordnance.manpowerMax"] = newMax;
      // Clamp manpower to the new reduced max
      const currentManpower = updates["resources.ordnance.manpower"] ?? data.resources?.ordnance?.manpower ?? 0;
      if (currentManpower > newMax) {
        updates["resources.ordnance.manpower"] = newMax;
      }
    }

    // ── Lock Stabilizer payload: freeze decay timers ──
    const sensorPayload = data.resources?.sensors?.payload ?? "";
    if (sensorPayload === "lockStabilizer") {
      const stabilizedLocks = (updates["resources.sensors.locks"] ?? prevLocks).map(l => {
        return { ...l, decayRounds: LOCK_DECAY_ROUNDS[l.tier] ?? 1 };
      });
      updates["resources.sensors.locks"] = stabilizedLocks;
    }

    // ── Clear all role payloads at end of round (payloads last 1 round) ──
    const roleIds = ["gunner", "pilot", "sensors", "engineer", "captain"];
    for (const rid of roleIds) {
      if (data.resources?.[rid]?.payload) {
        updates[`resources.${rid}.payload`] = "";
      }
    }

    // ── Captain: trim hand to base cap (6) when Inspire bonus expires ──────────
    const captainHandNow = [...(data.resources?.captain?.hand ?? [])];
    const BASE_HAND_CAP = 6;
    const overcapCount  = captainHandNow.length - BASE_HAND_CAP;
    if (overcapCount > 0) {
      updates["resources.captain.hand"]        = captainHandNow.slice(0, BASE_HAND_CAP);
      updates["resources.captain.discardPile"] = [
        ...(data.resources?.captain?.discardPile ?? []),
        ...captainHandNow.slice(BASE_HAND_CAP),
      ];
    }

    // ── Auto-arm torpedo: every 3 rounds, a torpedo is armed for free ──
    const hasTorpConfig = (data.ordnanceActors?.torpedo ?? []).length > 0;
    if (hasTorpConfig) {
      const autoArmTimer = data.resources?.ordnance?.autoArmTimer ?? 3;
      const newTimer = autoArmTimer - 1;
      if (newTimer <= 0) {
        const armed = data.resources?.ordnance?.armedTorpedoes ?? 0;
        updates["resources.ordnance.armedTorpedoes"] = (updates["resources.ordnance.armedTorpedoes"] ?? armed) + 1;
        updates["resources.ordnance.autoArmTimer"] = 3;
      } else {
        updates["resources.ordnance.autoArmTimer"] = newTimer;
      }
    }

    // ── Auto-load payload: every 2 rounds, Ordnance Master loads a payload for free ──
    if (manpowerMax > 0) {
      const autoLoadTimer = data.resources?.ordnance?.autoLoadTimer ?? 2;
      const newLoadTimer = autoLoadTimer - 1;
      if (newLoadTimer <= 0) {
        const avail = data.resources?.ordnance?.availablePayloads ?? 0;
        updates["resources.ordnance.availablePayloads"] = (updates["resources.ordnance.availablePayloads"] ?? avail) + 1;
        updates["resources.ordnance.autoLoadTimer"] = 2;
      } else {
        updates["resources.ordnance.autoLoadTimer"] = newLoadTimer;
      }
    }

    await this.update(updates);

    if (overcapCount > 0) {
      await ChatMessage.create({
        content: `<p>${game.i18n.format("SHIPCOMBAT.Captain.InspireDiscard", { count: overcapCount })}</p>`,
        speaker: { alias: SystemAdapter.current.getShipData(this.ship)?.roleTitles?.captain || game.i18n.localize("SHIPCOMBAT.Role.Captain") },
        whisper: ChatMessage.getWhisperRecipients("GM"),
      });
    }
  }

  // ── Resources & sectors ───────────────────────────────────────────────────

  /**
   * Assign a component to a weapon slot position.
   * payload: { itemId, weaponPosition, weaponBay }
   */
  static async assignWeapon({ itemId, weaponPosition, weaponBay }) {
    if (!this.ship) return;
    const updates = [{ _id: itemId, "system.equipped": true, "system.weaponPosition": weaponPosition, "system.weaponBay": weaponBay }];
    return this.ship.updateEmbeddedDocuments("Item", updates);
  }

  /**
   * Unassign a component from its slot (set equipped = false).
   * payload: { itemId }
   */
  static async unassignComponent({ itemId }) {
    if (!this.ship) return;
    return this.ship.updateEmbeddedDocuments("Item", [{ _id: itemId, "system.equipped": false }]);
  }

  /**
   * Swap which equipment component is active in a given slot type.
   * payload: { slotId, newItemId }  — newItemId may be "" to unequip all
   */
  static async assignEquipment({ slotId, newItemId }) {
    if (!this.ship) return;
    const allOfType = this.ship.items.filter(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === slotId
    );
    const updates = allOfType.map(c => ({ _id: c.id, "system.equipped": c.id === newItemId }));
    if (updates.length) return this.ship.updateEmbeddedDocuments("Item", updates);
  }

  static async updateResource(roleId, key, value) {
    if (roleId === "hull") {
      return this.update({ [`hull.${key}`]: value });
    }
    if (roleId === "coreBank") {
      return this.update({ coreBank: value });
    }
    if (roleId.includes(".")) {
      return this.update({ [`${roleId}.${key}`]: value });
    }
    // When rolledInitiative is set (captain rolls initiative formula), update combatant initiative
    if (roleId === "captain" && key === "rolledInitiative") {
      if (game.combat) {
        const shipCombatant = game.combat.combatants.find(c => c.actor?.id === this.ship?.id);
        if (shipCombatant) {
          await game.combat.setInitiative(shipCombatant.id, Number(value));
        }
      }
      return this.update({ "resources.captain.rolledInitiative": value });
    }
    // When captain's allocResolve changes, sync triageCount by the same delta
    if (roleId === "captain" && key === "allocResolve") {
      const data = this.getData();
      const currentResolve = data.resources?.captain?.allocResolve ?? 0;
      const currentTriage  = data.resources?.captain?.triageCount  ?? 2;
      const delta = value - currentResolve;
      const newTriage = Math.max(0, currentTriage + delta);
      return this.update({
        "resources.captain.allocResolve": value,
        "resources.captain.triageCount":  newTriage,
      });
    }
    return this.update({ [`resources.${roleId}.${key}`]: value });
  }

  // ── Round management ──────────────────────────────────────────────────────

  /**
   * Process the end-of-turn lifecycle for all deployed ordnance tokens on the
   * current scene: reset turnComplete, apply auto-drift (realistic) or min-move
   * completion (simplified), burn fuel, and delete exhausted tokens.
   *
   * Called at the END of the parent ship's turn so ordnance moves at the same
   * time as the ship's own turn-end auto-drift — not at the start of the next turn.
   */
  static async processOrdnanceLifecycle() {
    if (!canvas?.scene) return;
    const isRealistic = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
    const tokensToDelete = [];
    for (const td of canvas.scene.tokens) {
      if (!isOrdnance(td.actor)) continue;

      // Capture turnComplete before resetting (needed for launch-turn detection)
      const wasTurnComplete = SystemAdapter.current.getShipData(td.actor)?.turnComplete ?? false;

      // Reset turn-complete flag for next round
      if (wasTurnComplete) {
        await td.actor.update({ [SystemAdapter.current.systemPath("turnComplete")]: false });
      }

      // ── Torpedo fuel & movement lifecycle ──
      if (isTorpedo(td.actor)) {
        const tSys = SystemAdapter.current.getShipData(td.actor);
        const fuel = tSys.fuel?.value ?? 0;
        // powerBoostActive doubles this torpedo's power maximum for the turn; no speed change
        const speed = tSys.movement?.speed ?? 0;
        const minMove = Math.ceil(speed / 2);
        const torpedoPowerMax = tSys.powerBoostActive ? 200 : 100;
        const minMovePct = Math.round(minMove / (minMove + speed) * torpedoPowerMax);
        const thrustPct  = tSys.helm?.thrustPct ?? 0;

        // Detect launch turn: torpedo was force-completed on spawn and hasn't moved
        const isLaunchTurn = wasTurnComplete
                           && thrustPct === 0
                           && (tSys.helm?.prevTurnMove ?? 0) === 0;

        const tUpdates = {
          [SystemAdapter.current.systemPath("helm.bearing")]:       0,
          [SystemAdapter.current.systemPath("helm.thrustPct")]:     0,
          [SystemAdapter.current.systemPath("helm.prevTurnMove")]:  0,
          [SystemAdapter.current.systemPath("helm.momentumUsed")]:  0,
          [SystemAdapter.current.systemPath("powerBoostActive")]:   false,
          [SystemAdapter.current.systemPath("designated")]:         false,
        };

        // Helper: drift torpedo token along its velocity vector by a fraction
        const _driftTorpedoByVelocity = async (fraction) => {
          if (fraction <= 0) return;
          const vx = tSys.helm?.velocityX ?? 0;
          const vy = tSys.helm?.velocityY ?? 0;
          if (vx === 0 && vy === 0) return;
          const token = td.object;
          if (!token) return;
          const gridSize = canvas.grid.size;
          const tokenW = td.width  * gridSize;
          const tokenH = td.height * gridSize;
          const cx = td.x + tokenW / 2;
          const cy = td.y + tokenH / 2;
          const newCx = cx + vx * gridSize * fraction;
          const newCy = cy + vy * gridSize * fraction;
          await td.update({ x: newCx - tokenW / 2, y: newCy - tokenH / 2 }, { animate: true });
        };

        // Helper: move torpedo token by deltaSq grid squares along bearingDeg (simplified mode)
        const _autoMoveTorpedo = async (deltaSq, bearingDeg) => {
          if (deltaSq <= 0) return;
          const token = td.object;
          if (!token) return;
          const thrustArg = deltaSq * 100 / (minMove + speed);
          const projected = HelmPreview.projectPosition(token, bearingDeg, thrustArg, speed, minMove);
          if (!projected) return;
          const waypoints = HelmPreview.projectWaypoints(token, bearingDeg, thrustArg, speed, minMove);
          if (waypoints?.length > 1) {
            for (let wi = 0; wi < waypoints.length; wi++) {
              const wp = waypoints[wi];
              await token.animate(
                { x: wp.x, y: wp.y, rotation: wp.rotation },
                { duration: 50, chain: wi > 0 },
              );
            }
            await td.update({ x: projected.x, y: projected.y, rotation: projected.rotation }, { animate: false });
          } else {
            await td.update({ x: projected.x, y: projected.y, rotation: projected.rotation }, { animate: true });
          }
        };

        if (isRealistic) {
          // ── Realistic: drift by remaining velocity fraction ──
          const momentumUsed   = tSys.helm?.momentumUsed ?? 0;
          const remainFraction = Math.max(0, 1 - momentumUsed / 100);
          if (isLaunchTurn) {
            // Launch turn: drift full velocity (no carry has been applied yet)
            await _driftTorpedoByVelocity(1);
            await td.actor.update(tUpdates);
          } else if (wasTurnComplete) {
            // Designated: skip drift, burn fuel
            const newFuel = Math.max(0, fuel - 1);
            tUpdates["system.fuel.value"] = newFuel;
            await td.actor.update(tUpdates);
            if (newFuel <= 0) tokensToDelete.push(td.id);
          } else {
            // Normal turn-end: drift by the uncommitted fraction of velocity
            await _driftTorpedoByVelocity(remainFraction);
            const newFuel = Math.max(0, fuel - 1);
            tUpdates["system.fuel.value"] = newFuel;
            await td.actor.update(tUpdates);
            if (newFuel <= 0) tokensToDelete.push(td.id);
          }
        } else {
          // ── Simplified: min-move drift ──
          if (isLaunchTurn) {
            // Launch turn: drift minMove forward, no fuel burn
            await _autoMoveTorpedo(minMove, 0);
            await td.actor.update(tUpdates);
          } else if (wasTurnComplete) {
            // Designated: skip auto-drift but burn fuel
            const newFuel = Math.max(0, fuel - 1);
            tUpdates["system.fuel.value"] = newFuel;
            await td.actor.update(tUpdates);
            if (newFuel <= 0) tokensToDelete.push(td.id);
          } else if (thrustPct >= minMovePct) {
            // Player committed at least minimum movement
            const newFuel = Math.max(0, fuel - 1);
            tUpdates["system.fuel.value"] = newFuel;
            await td.actor.update(tUpdates);
            if (newFuel <= 0) tokensToDelete.push(td.id);
          } else {
            // Player committed less than minimum: auto-complete to minMove
            const committedSq   = thrustPct / torpedoPowerMax * (minMove + speed);
            const deltaSq       = minMove - committedSq;
            const storedBearing = tSys.helm?.bearing ?? 0;
            const newFuel       = Math.max(0, fuel - 1);
            tUpdates["system.fuel.value"] = newFuel;
            await _autoMoveTorpedo(deltaSq, storedBearing);
            await td.actor.update(tUpdates);
            if (newFuel <= 0) tokensToDelete.push(td.id);
          }
        }
      }

      // ── Strike craft movement lifecycle ──
      if (isStrikeCraft(td.actor)) {
        const cSys = SystemAdapter.current.getShipData(td.actor);
        const speed = cSys.movement?.speed ?? 0;
        const minMove = Math.ceil(speed / 2);
        const minMovePct    = Math.round(minMove / (minMove + speed) * 100);
        const thrustPct     = cSys.helm?.thrustPct ?? 0;
        const storedBearing = cSys.helm?.bearing ?? 0;

        const cUpdates = {
          [SystemAdapter.current.systemPath("helm.bearing")]:      0,
          [SystemAdapter.current.systemPath("helm.thrustPct")]:    0,
          [SystemAdapter.current.systemPath("helm.prevTurnMove")]: 0,
          [SystemAdapter.current.systemPath("helm.momentumUsed")]: 0,
        };

        if (isRealistic) {
          // ── Realistic: drift by remaining velocity fraction ──
          const cVx = cSys.helm?.velocityX ?? 0;
          const cVy = cSys.helm?.velocityY ?? 0;
          const momentumUsed   = cSys.helm?.momentumUsed ?? 0;
          const remainFraction = Math.max(0, 1 - momentumUsed / 100);
          if (remainFraction > 0 && (cVx !== 0 || cVy !== 0)) {
            const token = td.object;
            if (token) {
              const gridSize = canvas.grid.size;
              const tokenW = td.width  * gridSize;
              const tokenH = td.height * gridSize;
              const cx = td.x + tokenW / 2;
              const cy = td.y + tokenH / 2;
              const newCx = cx + cVx * gridSize * remainFraction;
              const newCy = cy + cVy * gridSize * remainFraction;
              await td.update({ x: newCx - tokenW / 2, y: newCy - tokenH / 2 }, { animate: true });
            }
          }
        } else if (thrustPct < minMovePct && minMove > 0) {
          // ── Simplified: auto-complete to minMove ──
          const committedSq = thrustPct / 100 * (minMove + speed);
          const deltaSq     = minMove - committedSq;
          if (deltaSq > 0) {
            const token = td.object;
            if (token) {
              const thrustArg = deltaSq * 100 / (minMove + speed);
              const projected = HelmPreview.projectPosition(token, storedBearing, thrustArg, speed, minMove);
              if (projected) {
                const waypoints = HelmPreview.projectWaypoints(token, storedBearing, thrustArg, speed, minMove);
                if (waypoints?.length > 1) {
                  for (let wi = 0; wi < waypoints.length; wi++) {
                    const wp = waypoints[wi];
                    await token.animate(
                      { x: wp.x, y: wp.y, rotation: wp.rotation },
                      { duration: 50, chain: wi > 0 },
                    );
                  }
                  await td.update({ x: projected.x, y: projected.y, rotation: projected.rotation }, { animate: false });
                } else {
                  await td.update({ x: projected.x, y: projected.y, rotation: projected.rotation }, { animate: true });
                }
              }
            }
          }
        }

        await td.actor.update(cUpdates);
        // ── Strike craft per-turn fuel burn ──
        const fuel = cSys.fuel?.value ?? 0;
        if (fuel > 0) {
          const newFuel = Math.max(0, fuel - 1);
          await td.actor.update({ [SystemAdapter.current.systemPath("fuel.value")]: newFuel });
          if (newFuel <= 0) tokensToDelete.push(td.id);
        } else {
          // Already at 0 — delete immediately
          tokensToDelete.push(td.id);
        }
        // ── Clear per-turn attacked-targets tracking ──
        const attackedFlag = td.actor.getFlag(MODULE_ID, "attackedThisTurn");
        if (attackedFlag?.length) {
          await td.actor.unsetFlag(MODULE_ID, "attackedThisTurn");
        }
      }
    }

    // Auto-detonate fuel-exhausted torpedoes (delete tokens → triggers deleteToken hook)
    if (tokensToDelete.length > 0) {
      await canvas.scene.deleteEmbeddedDocuments("Token", tokensToDelete);
    }
  }

  static async resetHelmState() {
    const data        = this.getData();
    const prevResetId = data.resources?.pilot?.helmResetId ?? 0;

    // Compute prevTurnMove from the fuel and drift consumed this turn so it
    // correctly reflects what the ship actually moved.  Reading these values
    // BEFORE zeroing them gives us the last-turn total that every caller
    // needs for the stable minMove calculation throughout the new turn.
    const fuelBurned  = data.resources?.pilot?.fuelBurned  ?? 0;
    const driftBurned = data.resources?.pilot?.driftBurned ?? 0;
    const allocSpeed  = data.resources?.pilot?.allocSpeed  ?? 0;
    const baseSpeed   = data.movement?.speed ?? 0;
    const effSpeed    = baseSpeed + allocSpeed;
    const prevTurnMove = fuelBurned > 0
      ? (fuelBurned / 100) * effSpeed + driftBurned
      : (data.resources?.pilot?.prevTurnMove ?? 0);

    return this.update({
      "resources.pilot.fuelBurned":        0,
      "resources.pilot.driftBurned":       0,
      "resources.pilot.pilotingSL":         0,
      "resources.pilot.allocSpeed":         0,
      "resources.pilot.allocMano":          0,
      "resources.pilot.allocEvasion":       0,
      "resources.pilot.pilotingMessageId": "",
      "resources.pilot.helmResetId":        prevResetId + 1,
      "resources.pilot.bearing":            0,
      "resources.pilot.prowGunLocked":      false,
      "resources.pilot.ramAllocLocked":     false,
      "resources.pilot.bearingUsed":        0,
      "resources.pilot.momentumUsed":       0,
      "resources.pilot.prevTurnMove":       prevTurnMove,
    });
  }

  static async fullReset() {
    const data = this.getData();
    const prevResetId = data.resources?.pilot?.helmResetId ?? 0;
    const shieldCfg   = this.getShieldStats();
    const reactor     = this.getReactorStats();
    const ordnance    = this.getOrdnanceBayStats();
    const updates = {
      "resources.pilot.fuelBurned":        0,
      "resources.pilot.driftBurned":       0,
      "resources.pilot.pilotingSL":         0,
      "resources.pilot.allocSpeed":         0,
      "resources.pilot.allocMano":          0,
      "resources.pilot.allocEvasion":       0,
      "resources.pilot.pilotingMessageId": "",
      "resources.pilot.helmResetId":        prevResetId + 1,
      "resources.pilot.bearing":            0,
      "resources.pilot.prevTurnMove":       SystemAdapter.current.getShipData(this.ship)?.movement?.speed ?? 0,
      "resources.pilot.bearingUsed":        0,
      "resources.pilot.momentumUsed":       0,
      "resources.pilot.velocityX":          (() => {
        const token = this.ship?.getActiveTokens?.()?.[0];
        const rot   = token?.document?.rotation ?? 0;
        const h0    = (rot - 90) * (Math.PI / 180);
        const spd   = SystemAdapter.current.getShipData(this.ship)?.movement?.speed ?? 6;
        return Math.cos(h0) * (spd / 2);
      })(),
      "resources.pilot.velocityY":          (() => {
        const token = this.ship?.getActiveTokens?.()?.[0];
        const rot   = token?.document?.rotation ?? 0;
        const h0    = (rot - 90) * (Math.PI / 180);
        const spd   = SystemAdapter.current.getShipData(this.ship)?.movement?.speed ?? 6;
        return Math.sin(h0) * (spd / 2);
      })(),
      "resources.engineer.actionChoices":  [],
      "resources.engineer.extraActions":   0,
      "resources.engineer.heat":          0,
      "resources.engineer.auxiliaryPower": Math.floor(reactor.auxPowerCapacity / 2),
      "resources.gunner.ammo":             Math.floor(ordnance.ammoCapacity / 4),
      "resources.ordnance.manpower":       ordnance.manpower,
      "resources.ordnance.manpowerMax":    ordnance.manpower,
      "resources.ordnance.armedTorpedoes": 0,
      "resources.ordnance.armedCraft": 0,
      "resources.ordnance.craftDestroyed": 0,
      "resources.ordnance.craftRecovering": 0,
      "resources.ordnance.craftPartialRecovery": 0,

      "resources.ordnance.availablePayloads": 0,
      "resources.ordnance.stagedPayloads": {},
      "resources.ordnance.commitments": [],
      "resources.ordnance.actionUsed": false,
      "resources.ordnance.coreActionUsed": false,
      "resources.ordnance.bosunSL": 0,
      "resources.ordnance.bosunRolled": false,
      "resources.gunner.payload": "",
      "resources.pilot.payload": "",
      "resources.sensors.payload": "",
      "resources.sensors.locks": [],
      "resources.sensors.effects": [],
      "resources.sensors.actionUsed": false,
      "resources.sensors.coreActionUsed": false,
      "resources.sensors.bdaAvailable": false,
      "resources.sensors.bdaCorrectionPending": false,
      "resources.sensors.bdaResultSL": 0,
      "resources.sensors.bdaTargetTokenId": null,
      "resources.sensors.fireCorrection": null,
      "resources.engineer.payload": "",
      internalFire: 0,
      "shieldPool.current":   shieldCfg.maxVoidFlux,
      "shieldPool.committed": 0,
      coreBank: 0,
      ventLocked: false,
      ventPending: false,
    };
    for (const sector of ["bow", "stern", "port", "starboard"]) {
      updates[`shields.${sector}`] = shieldCfg.zoneThresholds?.[sector] ?? 0;
    }
    for (const sector of ["bow", "stern", "port", "starboard"]) {
      updates[`armourRend.${sector}`] = 0;
    }
    for (const uid of Object.keys(data.resources?.engineer?.stagedCores ?? {})) {
      updates[`resources.engineer.stagedCores.${uid}`] = false;
    }
    updates["resources.engineer.stagedShieldCores"] = 0;
    updates["resources.engineer.stagedAuxCores"] = 0;
    updates["resources.engineer.committedAuxCores"] = 0;
    // ── Reset power cores to max ──
    updates["resources.engineer.powerCores"] = reactor.coreOutput;
    // ── Clear overchargeUsed / turnDone / assignedCores ──
    for (const roleId of Object.keys(data.turnDone ?? {})) {
      updates[`turnDone.${roleId}`] = false;
    }
    for (const roleId of Object.keys(data.overchargeUsed ?? {})) {
      updates[`overchargeUsed.${roleId}`] = false;
    }
    for (const uid of Object.keys(data.assignedCores ?? {})) {
      updates[`assignedCores.${uid}`] = false;
    }
    // ── Gunner per-round tracking ──
    updates["resources.gunner.ordnanceSL"]        = 0;
    updates["resources.gunner.allocAccuracy"]     = 0;
    updates["resources.gunner.allocPenetration"]  = 0;
    updates["resources.gunner.allocFirepower"]    = 0;
    updates["resources.gunner.slLocked"]          = false;
    updates["resources.gunner.firedWeaponIds"]    = [];
    updates["resources.gunner.ordnanceRolled"]    = false;
    updates["resources.gunner.arcOverlayActive"]  = false;
    updates["resources.gunner.sensorBandExpanded"] = false;
    updates["resources.gunner.chooseCritLocation"] = false;
    updates["resources.gunner.critLocationChoice"] = null;
    updates["resources.gunner.captainHitBonus"]   = 0;
    // ── Pilot per-round tracking ──
    updates["resources.pilot.overdrive"]          = false;
    updates["resources.pilot.apThrustBonus"]      = 0;
    updates["resources.pilot.hardOverActive"]     = false;
    updates["resources.pilot.prowGunLocked"]      = false;
    updates["resources.pilot.ramAllocLocked"]     = false;
    // ── Sensors per-round tracking ──
    updates["resources.sensors.sensorPriorityActive"]  = false;
    // ── Ordnance per-round tracking ──
    updates["resources.ordnance.allocEfficiency"]      = 0;
    updates["resources.ordnance.allocExpedience"]      = 0;
    // ── Per-role power core count + played actions ──
    for (const roleId of ["gunner", "pilot", "sensors", "ordnance"]) {
      updates[`resources.${roleId}.coreCount`]         = 0;
      updates[`resources.${roleId}.coreActionsPlayed`] = [];
    }
    updates["resources.captain.payload"]               = "";
    // ── Conditions: clear all (must use explicit null per field, not {}, due to Foundry merge semantics) ──
    const condClear = { tier: null, lockedRole: null, blindedSectionId: null };
    updates["conditions.hull"]           = { ...condClear };
    updates["conditions.engines"]        = { ...condClear };
    updates["conditions.manoeuvring"]    = { ...condClear };
    updates["conditions.coreSystems"]    = { ...condClear };
    updates["conditions.weaponsSensors"] = { ...condClear };
    // ── Captain: re-initialize deck and triage ──
    const _excl5man = (data.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (data.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
    const _exclCards = (data.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
    const captainDeck = buildCaptainDeck(_excl5man, _exclCards);
    const captainHand = captainDeck.splice(0, 3);
    updates["resources.captain.stance"]               = "none";
    updates["resources.captain.pendingStance"]        = "";
    updates["resources.captain.hand"]                 = captainHand;
    updates["resources.captain.drawPile"]             = captainDeck;
    updates["resources.captain.discardPile"]          = [];
    updates["resources.captain.triageCount"]          = 2;
    updates["resources.captain.triageConditionsUsed"] = [];
    updates["resources.captain.payload"]              = "";
    updates["resources.captain.leadershipRolled"]     = false;
    updates["resources.captain.leadershipSL"]         = 0;
    updates["resources.captain.rolledInitiative"]     = 0;
    updates["resources.captain.allocInspire"]         = 0;
    updates["resources.captain.allocResolve"]         = 0;
    updates["resources.captain.allocInitiative"]      = 0;
    updates["resources.captain.playedCards"]          = [];
    updates["resources.captain.holdTheLineActive"]    = false;
    updates["resources.captain.hardenedShields"]      = false;
    updates["resources.captain.mulliganUsed"]         = false;
    updates["resources.captain.coreActionUsed"]           = false;
    updates["resources.captain.selectedCoreAction"]       = null;
    updates["resources.captain.priorityTargetId"]         = null;
    updates["resources.captain.acceleratedLoadingActive"] = false;
    updates["resources.captain.handCapBonus"]             = 0;
    updates["resources.captain.coreCount"]                = 0;
    updates["resources.engineer.actionChoices"]          = [];
    updates["resources.engineer.extraActions"]           = 0;
    updates["round"]                                      = 0;
    // ── Ordnance: start fresh with 1 armed torp/craft (if configured), 1 payload, reset timer ──
    const ordRefFR = data.ordnanceActors ?? {};
    if ((ordRefFR.torpedo ?? []).length > 0) {
      updates["resources.ordnance.armedTorpedoes"] = 1;
    }
    if ((ordRefFR.strikeCraft ?? []).length > 0) {
      updates["resources.ordnance.armedCraft"] = 1;
    }
    updates["resources.ordnance.availablePayloads"] = 1;
    updates["resources.ordnance.autoArmTimer"] = 3;
    updates["resources.ordnance.autoLoadTimer"] = 2;
    await this.update(updates);
    // ── Clear conditions on all NPC ships in the scene ──
    if (canvas?.scene) {
      const npcCondClear = { tier: null, lockedRole: null, blindedSectionId: null };
      for (const td of canvas.scene.tokens) {
        if (td.actor?.type !== `${MODULE_ID}.npcShip`) continue;
        const npcUpdate = {
          [SystemAdapter.current.systemPath("conditions.hull")]:           { ...npcCondClear },
          [SystemAdapter.current.systemPath("conditions.engines")]:        { ...npcCondClear },
          [SystemAdapter.current.systemPath("conditions.manoeuvring")]:    { ...npcCondClear },
          [SystemAdapter.current.systemPath("conditions.coreSystems")]:    { ...npcCondClear },
          [SystemAdapter.current.systemPath("conditions.weaponsSensors")]: { ...npcCondClear },
        };
        for (const sector of ["bow", "stern", "port", "starboard"]) {
          npcUpdate[`system.armourRend.${sector}`] = 0;
        }
        await td.actor.update(npcUpdate);
      }
    }
    // ── Delete all deployed ordnance (torpedo/strike craft) tokens ──────────
    if (canvas?.scene) {
      const ordnanceTokenIds = canvas.scene.tokens
        .filter(td => isOrdnance(td.actor))
        .map(td => td.id);
      if (ordnanceTokenIds.length > 0) {
        ShipCombatState._suppressDestroyTracking = true;
        try {
          await canvas.scene.deleteEmbeddedDocuments("Token", ordnanceTokenIds);
        } finally {
          ShipCombatState._suppressDestroyTracking = false;
        }
      }
    }
  }

  static async advanceRound() {
    const data = this.getData();

    await this.update({
      round: (data.round ?? 0) + 1,
      "resources.pilot.bearing": 0,
    });

    // ── Stance: derive active stance from snapshot (promotion happens atomically in resetActions) ──
    const pendingStance = data.resources?.captain?.pendingStance ?? "";
    const activeStance  = pendingStance || (data.resources?.captain?.stance ?? "none");

    // ── Per-round condition effects (player ship) ─────────────────────────────
    const conditions  = data.conditions ?? {};
    const condUpdates = {};
    const hullVal     = data.hull?.value ?? 0;
    const hullMax     = data.hull?.max ?? 50;
    // Capture fire BEFORE condition updates so Hull High doesn't double-apply this round
    const fireBefore  = data.internalFire ?? 0;

    const hullTier = conditions.hull?.tier;
    if (hullTier) {
      const dmgMap = { low: 1, medium: 2, high: 3 };
      const hullBreachDmg = dmgMap[hullTier] ?? 0;
      condUpdates["hull.value"] = SystemAdapter.current.hullDisplayMode === "hpRemaining"
        ? Math.max(0, hullVal - hullBreachDmg)
        : Math.min(hullMax, hullVal + hullBreachDmg);
      if (hullTier === "high") {
        // Critical Breach: +5 internal fire per round (deals hull damage starting next round)
        condUpdates.internalFire = fireBefore + 5;
      }
    }

    // Heat Surge: +5 heat per round (Core Systems Medium+)
    if (conditions.coreSystems?.tier === "medium" || conditions.coreSystems?.tier === "high") {
      const currentHeat = data.resources?.engineer?.heat ?? 0;
      condUpdates["resources.engineer.heat"] = currentHeat + 5;
    }

    if (Object.keys(condUpdates).length > 0) {
      await this.update(condUpdates);
    }

    const holdTheLineActive = data.resources?.captain?.holdTheLineActive ?? false;
    if (fireBefore > 0 && !holdTheLineActive) {
      const hull    = SystemAdapter.current.getShipData(this.ship)?.hull ?? {};
      const hullMax = hull.max ?? 50;
      const hullVal = hull.value ?? 0;
      const newHull = SystemAdapter.current.hullDisplayMode === "hpRemaining"
        ? Math.max(0, hullVal - fireBefore)
        : Math.min(hullMax, hullVal + fireBefore);
      await this.update({ "hull.value": newHull });
    }

    await this.processOrdnanceLifecycle();
    await this.resetHelmState();
    await this.resetActions();

    // ── Red Alert stance: +5 internal fire + grant 1 free core to each role ──────
    if (activeStance === "redAlert") {
      const fresh = this.getData();
      const redAlertUpdates = {
        internalFire: (fresh.internalFire ?? 0) + 5,
      };
      for (const roleId of ["gunner", "pilot", "sensors", "ordnance", "captain"]) {
        redAlertUpdates[`resources.${roleId}.coreCount`] = (fresh.resources?.[roleId]?.coreCount ?? 0) + 1;
      }
      await this.update(redAlertUpdates);
    }

    // ── Captain: auto-draw up to 3 cards (respecting hand cap of 5) ──────────
    await this.drawCards({ count: 3 });

    // ── NPC per-round resource replenishment (25% of max, rounded down) ────────
    if (canvas?.scene) {
      for (const td of canvas.scene.tokens) {
        if (td.actor?.type !== `${MODULE_ID}.npcShip`) continue;
        const npcSys   = SystemAdapter.current.getShipData(td.actor);
        const ammoMax  = npcSys.resources?.gunner?.ammoMax  ?? 20;
        const powerMax = npcSys.resources?.gunner?.powerMax ?? 20;
        const ammoGain  = Math.floor(ammoMax  * 0.25);
        const powerGain = Math.floor(powerMax * 0.25);
        const npcRoundUpdates = {
          [SystemAdapter.current.systemPath("resources.gunner.ammo")]:  Math.min(ammoMax,  (npcSys.resources?.gunner?.ammo  ?? 0) + ammoGain),
          [SystemAdapter.current.systemPath("resources.gunner.power")]: Math.min(powerMax, (npcSys.resources?.gunner?.power ?? 0) + powerGain),
        };
        // Core Systems (any tier): −1 Speed per round (replaces player-side core distribution lock)
        const npcCoreTier = npcSys.conditions?.coreSystems?.tier;
        if (npcCoreTier) {
          const currentSpeed = npcSys.movement?.speed ?? 6;
          npcRoundUpdates["system.movement.speed"] = Math.max(1, currentSpeed - 1);
        }
        await td.actor.update(npcRoundUpdates);
      }
    }
  }

  static async startCombat() {
    if (!this.ship) {
      ui.notifications.error(game.i18n.localize("SHIPCOMBAT.Warning.NoShip"));
      return;
    }
    const data = this.getData();
    const max = this.getReactorStats().coreOutput;
    const shieldCfg = this.getShieldStats();
    const _excl5man = (data.crewSize ?? 6) <= 4 ? ["ordnance", "sensors"] : (data.crewSize ?? 6) <= 5 ? ["ordnance"] : [];
    const _exclCards = (data.crewSize ?? 6) <= 3 ? ["pressTheAttack"] : [];
    const captainDeck = buildCaptainDeck(_excl5man, _exclCards);
    const captainHand = captainDeck.splice(0, 3);
    const updates = {
      active: true, round: 1, internalFire: 0,
      "resources.pilot.prevTurnMove": 0,
      "resources.engineer.powerCores": max,
      "resources.engineer.heat": 0,
      "resources.engineer.actionChoices": [],
      "resources.engineer.extraActions":  0,
      "shieldPool.current":   shieldCfg.maxVoidFlux,
      "shieldPool.committed": 0,
      coreBank: 0,
      ventLocked: false,
      ventPending: false,
      // ── Conditions: clear all at start of combat ──
      "conditions.hull":           { tier: null, lockedRole: null, blindedSectionId: null },
      "conditions.engines":        { tier: null, lockedRole: null, blindedSectionId: null },
      "conditions.manoeuvring":    { tier: null, lockedRole: null, blindedSectionId: null },
      "conditions.coreSystems":    { tier: null, lockedRole: null, blindedSectionId: null },
      "conditions.weaponsSensors": { tier: null, lockedRole: null, blindedSectionId: null },
      // ── Captain: initialize deck and triage ──
      "resources.captain.stance":                "none",
      "resources.captain.pendingStance":         "",
      "resources.captain.hand":                  captainHand,
      "resources.captain.drawPile":              captainDeck,
      "resources.captain.discardPile":           [],
      "resources.captain.triageCount":           2,
      "resources.captain.triageConditionsUsed":  [],
      "resources.captain.payload":               "",
      "resources.captain.leadershipRolled":      false,
      "resources.captain.leadershipSL":          0,
      "resources.captain.rolledInitiative":      0,
      "resources.captain.allocInspire":          0,
      "resources.captain.allocResolve":          0,
    };
    for (const roleId of Object.keys(data.turnDone ?? {})) updates[`turnDone.${roleId}`] = false;
    for (const roleId of Object.keys(data.overchargeUsed ?? {})) updates[`overchargeUsed.${roleId}`] = false;
    for (const uid of Object.keys(data.assignedCores ?? {})) updates[`assignedCores.${uid}`] = false;
    for (const uid of Object.keys(data.reactions ?? {})) updates[`reactions.${uid}`] = false;
    for (const uid of Object.keys(data.resources?.engineer?.stagedCores ?? {})) {
      updates[`resources.engineer.stagedCores.${uid}`] = false;
    }

    // ── Ordnance Master: start with 1 armed torpedo / strike craft if allocated in config ──
    const ordnanceActors = data.ordnanceActors ?? {};
    if ((ordnanceActors.torpedo ?? []).length > 0) {
      updates["resources.ordnance.armedTorpedoes"] = 1;
    }
    if ((ordnanceActors.strikeCraft ?? []).length > 0) {
      updates["resources.ordnance.armedCraft"] = 1;
    }
    updates["resources.ordnance.availablePayloads"] = 1;
    updates["resources.ordnance.autoArmTimer"] = 3;
    updates["resources.ordnance.autoLoadTimer"] = 2;

    await this.update(updates);
  }

  static async endCombat() {
    return this.update({ active: false });
  }

  /**
   * Advance the Foundry combat tracker by one turn (ends this ship's turn).
   * Should only be called when all active roles have marked turnDone.
   */
  static async endShipTurn() {
    if (!game.combat) return;
    await game.combat.nextTurn();
  }


  // ── Helpers ───────────────────────────────────────────────────────────────

  static getUserByRole(roleId) {
    const data = this.getData();
    const entry = Object.entries(data.roles ?? {}).find(([, r]) => r === roleId);
    return entry ? game.users.get(entry[0]) : null;
  }

  // ── Component stat helpers ────────────────────────────────────────────────

  static getReactorStats(shipActor) {
    const ship = shipActor ?? this.ship;
    if (!ship) return { coreOutput: 0, shieldStrengthPerCore: 0, heatCapacity: 0, auxPowerCapacity: 0, reserveMultiplier: 0 };
    const reactor = ship.items.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "reactor" && i.system.equipped !== false);
    return {
      coreOutput:            reactor?.system?.rating ?? 0,
      shieldStrengthPerCore: reactor?.system?.shieldStrengthPerCore ?? 0,
      heatCapacity:          reactor?.system?.heatCapacity ?? 0,
      auxPowerCapacity:      reactor?.system?.bankCapacity ?? 0,
      reserveMultiplier:     reactor?.system?.reserveMultiplier ?? 0,
    };
  }

  static getOrdnanceBayStats(shipActor) {
    const ship = shipActor ?? this.ship;
    if (!ship) return { ammoCapacity: 0, chargeCapacity: 0, manpower: 0, torpedoCapacity: 4, strikeCraftCapacity: 6 };
    const bay = ship.items.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "weaponsBay" && i.system.equipped !== false);
    return {
      ammoCapacity:          bay?.system?.bayAmmoCapacity ?? 0,
      chargeCapacity:        bay?.system?.bayChargeCapacity ?? 0,
      manpower:              bay?.system?.bayManpower ?? 0,
      torpedoCapacity:       bay?.system?.bayTorpedoCapacity ?? 4,
      maxFlights:            bay?.system?.bayMaxFlights ?? 2,
      strikeCraftCapacity:   bay?.system?.bayStrikeCraftCapacity ?? 6,
    };
  }

  static getShieldStats(shipActor) {
    const ship = shipActor ?? this.ship;
    const _default = { maxVoidFlux: 20, fluxToAPRate: 1, zoneThresholds: { bow: 8, stern: 8, port: 8, starboard: 8 } };
    if (!ship) return _default;
    const shield = ship.items.find(i => i.type === `${MODULE_ID}.component` && i.system.slot === "shields" && i.system.equipped !== false);
    if (!shield) return _default;
    const zt = shield.system.zoneThresholds;
    return {
      maxVoidFlux:    shield.system.maxVoidFlux ?? 0,
      fluxToAPRate:   shield.system.fluxToAPRate ?? 1,
      zoneThresholds: {
        bow:       zt?.bow       ?? 0,
        stern:     zt?.stern     ?? 0,
        port:      zt?.port      ?? 0,
        starboard: zt?.starboard ?? 0,
      },
    };
  }

  static getSensorStats(shipActor) {
    const ship = shipActor ?? this.ship;
    if (!ship) return { rating: 0, bandSize: 0, autoScanRange: 0, maxRange: 0, apCostMultiplier: 1 };
    const sensor = ship.items.find(
      i => i.type === `${MODULE_ID}.component` && i.system.slot === "sensor" && i.system.equipped !== false
    );
    const sys = SystemAdapter.current.getShipData(ship) ?? {};
    const scanRange = (sensor?.system?.autoScanRange ?? 0) || (sys.autoScanRange ?? 0);
    const rangeAmpActive = (sys.resources?.sensors?.effects ?? []).some(e => e.actionId === "rangeAmplifier");
    const effectiveScanRange = rangeAmpActive ? scanRange * 2 : scanRange;
    const bandExpanded     = !!(SystemAdapter.current.getShipData(ship)?.resources?.gunner?.sensorBandExpanded);
    const rawBandSize      = sensor?.system?.bandSize ?? sys.sensorBandSize ?? 0;
    return {
      rating:           sensor?.system?.rating ?? sys.sensorRating ?? 0,
      bandSize:         bandExpanded ? rawBandSize * 2 : rawBandSize,
      autoScanRange:    effectiveScanRange,
      maxRange:         sensor?.system?.maxRange ?? 0,
      apCostMultiplier: sensor?.system?.apCostMultiplier ?? 1,
    };
  }

  /**
   * Strike craft attack: roll accuracy, then apply shield/armour/hull damage
   * through the same resolution path as the gunner.
   * Called via socket from StrikeCraftAttackPopup._onConfirmAttack.
   */
  static async strikeCraftAttack({ craftName, craftImg, targetTokenId, hitQuadrant, accuracy, damage, payloadDiceCount, payloadDiceSize, traits, salvoSize = 1, payloadDamageType = null }) {
    const targetTok   = canvas.tokens.get(targetTokenId);
    const targetActor = targetTok?.document?.actor ?? null;
    if (!targetActor) return;

    const sys              = SystemAdapter.current.getShipData(targetActor);
    const qLabel           = game.i18n.localize(
      "SHIPCOMBAT.Sector." + hitQuadrant.charAt(0).toUpperCase() + hitQuadrant.slice(1)
    );
    const fireModeLabel    = game.i18n.localize("SHIPCOMBAT.StrikeCraft.AttackRun");
    const templatePath     = `modules/${CORE_MODULE_ID}/templates/chat/strike-craft-result.hbs`;
    const isOrdnanceTarget = isOrdnance(targetActor);

    // ── Salvo resolution ──
    const _delay     = ms => new Promise(r => setTimeout(r, ms));
    const adapter    = SystemAdapter.current;
    const formula    = adapter.getRollFormula();
    const targetAC   = adapter.getTargetAC(targetActor);
    const salvoRolls = [];
    for (let i = 0; i < salvoSize; i++) {
      if (i > 0) await _delay(100);
      const roll = await new Roll(formula).evaluate();
      if (game.dice3d) game.dice3d.showForRoll(roll, game.user, true);
      const hit    = adapter.isHit(roll, accuracy, targetAC);
      const isCrit = hit && !isOrdnanceTarget && (adapter.isAutomaticCrit(roll) || adapter.isCriticalHit(roll, accuracy, targetAC, traits));
      salvoRolls.push({
        roll:        roll.total,
        target:      accuracy,
        hit,
        isCrit,
        isJam:       false,
        revealDelay: 0,
        dieStyle:    `animation-delay:${i * 100}ms`,
        batchBreak:  false,
      });
    }

    const totalHits = salvoRolls.filter(r => r.hit).length;
    const anyCrit   = salvoRolls.some(r => r.isCrit);

    const _baseData = () => ({
      weaponImg:        craftImg,
      weaponName:       craftName,
      fireModeLabel,
      targetName:       targetActor.name,
      hitQuadrantLabel: qLabel,
      accuracy,
      hit:              totalHits > 0,
      isCrit:           anyCrit,
      hasSalvoRolls:    true,
      salvoRolls,
      totalSalvo:       salvoSize,
      totalHits,
    });

    if (totalHits === 0) {
      const content = await renderTemplate(templatePath, {
        ..._baseData(),
        hasShieldResults: false,
        hasDamageResults: false,
        critResult:       { hasCrit: false },
      });
      ChatMessage.create({ content, speaker: ChatMessage.getSpeaker() });
      return;
    }

    // ── Ordnance targets (torpedo / strike craft): 1 HP per hit ──
    if (isOrdnanceTarget) {
      const currentHull = sys.hull?.value ?? 0;
      const hullMax     = sys.hull?.max ?? 1;
      const _isHP       = SystemAdapter.current.hullDisplayMode === "hpRemaining";
      const _newHull    = _isHP ? Math.max(0, currentHull - totalHits) : Math.min(hullMax, currentHull + totalHits);
      await targetActor.update({ [SystemAdapter.current.systemPath("hull.value")]: _newHull });
      const content = await renderTemplate(templatePath, {
        ..._baseData(),
        hasShieldResults: false,
        hasDamageResults: true,
        damageResults: { totalDamage: totalHits, rawDamagePerHit: 1, effectiveArmour: 0, ap: null, rendTotal: null },
        critResult: { hasCrit: false },
      });
      ChatMessage.create({ content, rolls: [], speaker: ChatMessage.getSpeaker() });
      return;
    }

    // ── Shields ──
    const rawDamage     = damage;
    const targetShields = sys.shields?.[hitQuadrant] ?? 0;
    let shieldsRemaining = targetShields;
    let hitsAbsorbed    = 0;
    let shieldCostTotal = 0;
    const hardenedShields = SystemAdapter.current.getShipData(targetActor)?.resources?.captain?.hardenedShields ?? false;
    const shieldBypass  = hardenedShields ? false : (traits?.shieldBypass ?? false);
    const shieldBurnVal = traits?.shieldBurn ?? 0;

    // ── Damage-type IWR ── immunity is checked before shields so immune
    // attacks do not consume void shields at all (mirrors gunner-state);
    // modifyDamageForType is a pass-through no-op on systems without IWR.
    const _iwrImmune = payloadDamageType
      ? SystemAdapter.current.modifyDamageForType(0, payloadDamageType, targetActor).immune
      : false;
    const _applyIwr = v => payloadDamageType
      ? SystemAdapter.current.modifyDamageForType(v, payloadDamageType, targetActor).finalDamage
      : v;

    if (_iwrImmune) {
      // Immune: no shield drain, no hull damage — hits pass through harmlessly.
    } else if (shieldBypass) {
      if (shieldBurnVal > 0 && shieldsRemaining > 0) {
        shieldsRemaining = Math.max(0, shieldsRemaining - shieldBurnVal * totalHits);
        shieldCostTotal  = targetShields - shieldsRemaining;
      }
    } else if (shieldsRemaining > 0) {
      const costPerHit = 1 + shieldBurnVal;
      for (let i = 0; i < totalHits; i++) {
        if (shieldsRemaining <= 0) break;
        shieldsRemaining = Math.max(0, shieldsRemaining - costPerHit);
        shieldCostTotal += costPerHit;
        hitsAbsorbed++;
      }
    }

    const hitsThroughShield = totalHits - hitsAbsorbed;

    // ── Armour & damage ──
    const sectorArmour    = sys.armour?.[hitQuadrant] ?? 0;
    const ap              = traits?.armourPenetration ?? 0;
    const effectiveArmour = Math.max(0, sectorArmour - ap);
    const rendVal         = traits?.rend ?? 0;
    const rendTotal       = rendVal > 0 ? rendVal * hitsThroughShield : 0;

    let totalDamage = 0;
    let strikeDiceBreakdown = null;
    if (hitsThroughShield > 0 && !_iwrImmune) {
      if (payloadDiceCount && payloadDiceSize) {
        // Roll scaled dice (one die-set per hit through shields).  Systems that
        // also carry a flat per-hit bonus (addsFlatBonusToDice) add it to the
        // total; SF2e overrides that flag to false (dice-only damage model).
        const dmgFormula = `${hitsThroughShield * payloadDiceCount}${payloadDiceSize}`;
        const dmgRoll = await new Roll(dmgFormula).evaluate();
        if (game.dice3d) game.dice3d.showForRoll(dmgRoll, game.user, true);
        const flatBonus = SystemAdapter.current.addsFlatBonusToDice
          ? (rawDamage ?? 0) * hitsThroughShield
          : 0;
        const preMitigation = dmgRoll.total + flatBonus;
        // Weaknesses/resistances applied to the pre-armour damage.
        totalDamage = Math.max(0, _applyIwr(preMitigation) - effectiveArmour);
        const diceResults = dmgRoll.terms?.[0]?.results?.map(r => r.result) ?? [];
        if (diceResults.length > 0) {
          const breakdownFormula = flatBonus > 0 ? `${dmgFormula} + ${flatBonus}` : dmgFormula;
          strikeDiceBreakdown = { formula: breakdownFormula, dice: diceResults, total: preMitigation };
        }
      } else {
        // Weaknesses/resistances applied per hit to the pre-armour damage.
        const damagePerHit = Math.max(0, _applyIwr(rawDamage) - effectiveArmour);
        totalDamage = hitsThroughShield * damagePerHit;
      }
    }

    // ── Apply to target ──
    const targetUpdates = {};
    if (shieldsRemaining !== targetShields) {
      targetUpdates[`system.shields.${hitQuadrant}`] = shieldsRemaining;
    }
    if (totalDamage > 0) {
      const currentHull = sys.hull?.value ?? 0;
      const hullMax     = sys.hull?.max ?? 50;
      const _isHP       = SystemAdapter.current.hullDisplayMode === "hpRemaining";
      targetUpdates["system.hull.value"] = _isHP
        ? Math.max(0, currentHull - totalDamage)
        : Math.min(hullMax, currentHull + totalDamage);
    }
    if (rendTotal > 0) {
      const currentRend = sys.armourRend?.[hitQuadrant] ?? 0;
      targetUpdates[`system.armourRend.${hitQuadrant}`] = currentRend + rendTotal;
      // For NPC ships, armour is stored as a direct current value (not derived from rend)
      if (targetActor.type === `${MODULE_ID}.npcShip`) {
        const currentArmour = sys.armour?.[hitQuadrant] ?? 0;
        targetUpdates[`system.armour.${hitQuadrant}`] = Math.max(0, currentArmour - rendTotal);
      }
    }
    if (Object.keys(targetUpdates).length) await targetActor.update(targetUpdates);

    // ── Crit ──
    const critResult = totalDamage > 0
      ? await CritState.rollCrit.call(ShipCombatState, targetActor, totalDamage, anyCrit)
      : null;

    // ── Chat ──
    const content = await renderTemplate(templatePath, {
      ..._baseData(),
      hasShieldResults: hitsAbsorbed > 0 || (shieldBypass && shieldCostTotal > 0),
      shieldResults: {
        bypassed:          shieldBypass,
        absorbed:          hitsAbsorbed,
        shieldCostTotal,
        hitsThroughShield,
      },
      hasDamageResults: hitsThroughShield > 0,
      damageResults: {
        totalDamage,
        rawDamagePerHit: rawDamage,
        effectiveArmour,
        ap:              ap > 0 ? ap : null,
        rendTotal:       rendTotal > 0 ? rendTotal : null,
        diceBreakdown:   strikeDiceBreakdown,
      },
      critResult: critResult ?? { hasCrit: false },
    });
    ChatMessage.create({
      content,
      rolls:   critResult?.critRolls ?? [],
      speaker: ChatMessage.getSpeaker(),
    });
    return { totalHits };
  }

  /**
   * Apply torpedo detonation damage to a ship.
   * Called via socket from TorpedoSheet._onDetonate.
   */
  static async torpedoDamage({ targetActorId, torName, torImg, damage, diceFormula, hitQuadrant, traits, payloadDamageType = null }) {
    const target = game.actors.get(targetActorId);
    if (!target) return;

    const sys             = SystemAdapter.current.getShipData(target);
    // Roll damage dice if a formula was provided.  Systems that also carry a
    // flat bonus (addsFlatBonusToDice) add it to the total; the bonus here is
    // already scaled by warhead count and distance decay in the caller.
    // SF2e overrides the flag to false (dice-only damage model).
    // The flat-only path is unchanged.
    let rawDamage;
    let diceBreakdown = null;
    if (diceFormula) {
      const dmgRoll = await new Roll(diceFormula).evaluate();
      if (game.dice3d) game.dice3d.showForRoll(dmgRoll, game.user, true);
      const flatBonus = SystemAdapter.current.addsFlatBonusToDice ? (damage ?? 0) : 0;
      rawDamage = dmgRoll.total + flatBonus;
      const diceResults = dmgRoll.terms?.[0]?.results?.map(r => r.result) ?? [];
      if (diceResults.length > 0) {
        const breakdownFormula = flatBonus > 0 ? `${diceFormula} + ${flatBonus}` : diceFormula;
        diceBreakdown = { formula: breakdownFormula, dice: diceResults, total: rawDamage };
      }
    } else {
      rawDamage = damage ?? 1;
    }

    // ── Damage-type IWR ── applied to the pre-armour damage, mirroring
    // gunner-state.  modifyDamageForType is a pass-through no-op on systems
    // whose adapter doesn't implement IWR.  Immunity zeroes rawDamage before
    // the shield block below, which also prevents shield absorption and
    // shield burn (both key off rawDamage > 0).
    if (payloadDamageType) {
      const iwr = SystemAdapter.current.modifyDamageForType(rawDamage, payloadDamageType, target);
      rawDamage = iwr.immune ? 0 : iwr.finalDamage;
    }

    const qLabel          = game.i18n.localize(
      "SHIPCOMBAT.Sector." + hitQuadrant.charAt(0).toUpperCase() + hitQuadrant.slice(1)
    );
    const hullUpdates = {};

    // Shield handling (same as gunner-state)
    let targetShields    = sys.shields?.[hitQuadrant] ?? 0;
    let shieldsRemaining = targetShields;
    let hitsAbsorbed     = 0;
    let costPerHit       = 0;
    const hardenedShields = SystemAdapter.current.getShipData(target)?.resources?.captain?.hardenedShields ?? false;
    const shieldBypass   = hardenedShields ? false : (traits?.shieldBypass ?? false);
    const shieldBurnVal  = Math.min(traits?.shieldBurn ?? 0, rawDamage);

    if (shieldBypass) {
      // Bypass: damage goes through, but shield burn still applies
      if (shieldBurnVal > 0) {
        shieldsRemaining = Math.max(0, targetShields - shieldBurnVal);
      }
    } else {
      // Normal shield absorption: 1 shield absorbs 1 hit, shield burn increases cost
      costPerHit = 1 + shieldBurnVal;
      if (targetShields >= costPerHit && rawDamage > 0) {
        hitsAbsorbed = 1; // torpedoes are single-hit
        shieldsRemaining = Math.max(0, targetShields - costPerHit);
        rawDamage = 0;
      }
    }

    if (shieldsRemaining !== targetShields) {
      hullUpdates[`system.shields.${hitQuadrant}`] = shieldsRemaining;
    }

    // Armour
    const sectorArmour    = sys.armour?.[hitQuadrant] ?? 0;
    const ap              = traits?.armourPenetration ?? 0;
    const effectiveArmour = Math.max(0, sectorArmour - ap);
    const appliedDamage   = Math.max(0, rawDamage - effectiveArmour);

    // Hull
    if (appliedDamage > 0) {
      const currentHull = sys.hull?.value ?? 0;
      const hullMax     = sys.hull?.max ?? 50;
      const _isHP       = SystemAdapter.current.hullDisplayMode === "hpRemaining";
      hullUpdates["system.hull.value"] = _isHP
        ? Math.max(0, currentHull - appliedDamage)
        : Math.min(hullMax, currentHull + appliedDamage);
    }

    // Rend  -  applies even if armour blocks all hull damage
    const rendVal = traits?.rend ?? 0;
    if (rendVal > 0) {
      const currentRend = sys.armourRend?.[hitQuadrant] ?? 0;
      hullUpdates[`system.armourRend.${hitQuadrant}`] = currentRend + rendVal;
      // For NPC ships, armour is stored as a direct current value (not derived from rend)
      if (target.type === `${MODULE_ID}.npcShip`) {
        const currentArmour = sys.armour?.[hitQuadrant] ?? 0;
        hullUpdates[`system.armour.${hitQuadrant}`] = Math.max(0, currentArmour - rendVal);
      }
    }

    if (Object.keys(hullUpdates).length) {
      await target.update(hullUpdates);
    }

    // Crit check  -  torpedo damage triggers crits like any other weapon
    const critResult = appliedDamage > 0
      ? await CritState.rollCrit.call(ShipCombatState, target, appliedDamage, false)
      : null;

    // Chat message
    const content = await renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/torpedo-result.hbs`,
      {
        weaponImg:        torImg,
        weaponName:       torName ?? game.i18n.localize("SHIPCOMBAT.TorpedoDamage.Title"),
        fireModeLabel:    game.i18n.localize("SHIPCOMBAT.TorpedoDamage.Title"),
        targetName:       target.name,
        hitQuadrantLabel: qLabel,
        hasShieldResults: hitsAbsorbed > 0 || (shieldBypass && shieldBurnVal > 0),
        shieldResults: {
          bypassed:          shieldBypass,
          absorbed:          hitsAbsorbed,
          shieldCostTotal:   costPerHit * hitsAbsorbed,
          hitsThroughShield: hitsAbsorbed > 0 ? 0 : 1,
        },
        hasDamageResults: hitsAbsorbed === 0,
        damageResults: {
          totalDamage:     appliedDamage,
          rawDamagePerHit: rawDamage,
          effectiveArmour,
          ap:              ap > 0 ? ap : null,
          rendTotal:       rendVal > 0 ? rendVal : null,
          diceBreakdown,
        },
        critResult: critResult ?? { hasCrit: false },
      }
    );
    ChatMessage.create({
      content,
      rolls:   critResult?.critRolls ?? [],
      speaker: ChatMessage.getSpeaker(),
    });
  }
}

// ── Attach domain methods as static properties ──────────────────────────────
// This preserves the public API: ShipCombatState.fireWeapon(...) etc.

// Gunner
ShipCombatState.fireWeapon      = GunnerState.fireWeapon;
ShipCombatState._fireWeaponChat = GunnerState._fireWeaponChat;

// Pilot / Helm
ShipCombatState.consumePilotCore = PilotState.consumePilotCore;
ShipCombatState.pilotRetrograde  = PilotState.pilotRetrograde;
ShipCombatState.pilotOverdrive   = PilotState.pilotOverdrive;
ShipCombatState.pilotStrafe      = PilotState.pilotStrafe;
ShipCombatState.pilotFlipAndBurn = PilotState.pilotFlipAndBurn;
ShipCombatState.pilotRam         = PilotState.pilotRam;
ShipCombatState.confirmMovement  = PilotState.confirmMovement;
ShipCombatState.apToThrust       = PilotState.apToThrust;

// Engineer (power cores, heat/fire, shields, core bank, hull repair)
ShipCombatState.assignPowerCore     = EngineerState.assignPowerCore;
ShipCombatState.revokePowerCore     = EngineerState.revokePowerCore;
ShipCombatState.stagePowerCore      = EngineerState.stagePowerCore;
ShipCombatState.unstagePowerCore    = EngineerState.unstagePowerCore;
ShipCombatState.dispatchStagedCores = EngineerState.dispatchStagedCores;
ShipCombatState.hasPowerCore        = EngineerState.hasPowerCore;
ShipCombatState.emergencyVent       = EngineerState.emergencyVent;
ShipCombatState.reduceInternalFire  = EngineerState.reduceInternalFire;
ShipCombatState.setInternalFire     = EngineerState.setInternalFire;
ShipCombatState.spendBankedCores    = EngineerState.spendBankedCores;
ShipCombatState.commitShieldCores   = EngineerState.commitShieldCores;
ShipCombatState.uncommitShieldCore  = EngineerState.uncommitShieldCore;
ShipCombatState.commitAuxCore       = EngineerState.commitAuxCore;
ShipCombatState.uncommitAuxCore     = EngineerState.uncommitAuxCore;
ShipCombatState.adjustShieldZone    = EngineerState.adjustShieldZone;
ShipCombatState.repairHull          = EngineerState.repairHull;
ShipCombatState.fluxToCharge        = EngineerState.fluxToCharge;

// Sensors
ShipCombatState.addSensorEffect      = SensorsState.addSensorEffect;
ShipCombatState.stripQuadrantShields = SensorsState.stripQuadrantShields;
ShipCombatState.hasSensorEffectOn    = SensorsState.hasSensorEffectOn;
ShipCombatState.getDisruptionPenalty = SensorsState.getDisruptionPenalty;
ShipCombatState.upgradeLock          = SensorsState.upgradeLock;
ShipCombatState.getLockTier          = SensorsState.getLockTier;
ShipCombatState.getEffectiveLockTier = SensorsState.getEffectiveLockTier;
ShipCombatState.consumeLock          = SensorsState.consumeLock;
ShipCombatState.removeLock           = SensorsState.removeLock;
ShipCombatState.resolveBDA           = SensorsState.resolveBDA;
ShipCombatState.setFireCorrection    = SensorsState.setFireCorrection;
ShipCombatState.spendAP              = SensorsState.spendAP;

// Ordnance
ShipCombatState.spawnOrdnance             = OrdnanceState.spawnOrdnance;
ShipCombatState.setOrdnanceRtb            = OrdnanceState.setOrdnanceRtb;
ShipCombatState.setOrdnanceTurnDone       = OrdnanceState.setOrdnanceTurnDone;
ShipCombatState.designateHostileTorpedo   = OrdnanceState.designateHostileTorpedo;
ShipCombatState.torpedoPowerBoost         = OrdnanceState.torpedoPowerBoost;
ShipCombatState.blastOrdnance             = OrdnanceState.blastOrdnance;

// Crits
ShipCombatState.rollCrit = CritState.rollCrit;

// Captain
ShipCombatState.triageCondition  = CaptainState.triageCondition;
ShipCombatState.drawCards        = CaptainState.drawCards;
ShipCombatState.playCard         = CaptainState.playCard;
ShipCombatState.discardCard      = CaptainState.discardCard;
ShipCombatState.mulligan         = CaptainState.mulligan;
ShipCombatState.fullRedraw       = CaptainState.fullRedraw;
ShipCombatState.captainPayloadActivate = CaptainState.captainPayloadActivate;
ShipCombatState.captainCoreAction = CaptainState.captainCoreAction;
