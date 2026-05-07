/**
 * BDAPopup  -  Battle Damage Assessment corrections popup for the Augur operator.
 *
 * The BDA roll is now triggered directly from the chat card (no intermediate popup).
 * This popup opens automatically after a successful roll (SL >= 1) and lets the
 * Augur choose a fire correction.  When a correction is chosen, the originating
 * BDA-pending chat card is updated with the full result.
 */
import { MODULE_ID, CORE_MODULE_ID, BDA_CORRECTIONS } from "../constants.js";
import { emitToGM } from "../socket.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function _resolveSensorsActorFromShip(shipActor) {
  const sys = shipActor.system;
  const ref = sys.crewActors?.sensors;
  if (ref?.uuid) {
    try { return await fromUuid(ref.uuid); } catch { /* ignore */ }
  }
  const entry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "sensors");
  if (entry) {
    const user = game.users.get(entry[0]);
    return user?.character ?? null;
  }
  // Fallback: in 4-man mode the captain handles the Augur role.
  const captainRef = sys.crewActors?.captain;
  if (captainRef?.uuid) {
    try { return await fromUuid(captainRef.uuid); } catch { /* ignore */ }
  }
  const captainEntry = Object.entries(sys.roles ?? {}).find(([, r]) => r === "captain");
  if (captainEntry) {
    const captainUser = game.users.get(captainEntry[0]);
    return captainUser?.character ?? null;
  }
  return null;
}

function _lockRetainDesc(sl, originalTier = 4) {
  const tier    = SystemAdapter.current.getLockTierForSL(sl);
  const clamped = Math.min(tier, originalTier);
  if (clamped >= 4) return game.i18n.localize("SHIPCOMBAT.BDA.LockRetain4");
  if (clamped >= 3) return game.i18n.localize("SHIPCOMBAT.BDA.LockRetain3");
  if (clamped >= 2) return game.i18n.localize("SHIPCOMBAT.BDA.LockRetain2");
  if (clamped >= 1) return game.i18n.localize("SHIPCOMBAT.BDA.LockRetain1");
  return game.i18n.localize("SHIPCOMBAT.BDA.LockLost");
}

// ── Direct-from-chat-card BDA entry point ──────────────────────────────────────

/**
 * Launch the BDA roll directly, skipping the intermediate popup.
 * Called when the Augur clicks "Launch Assessment" in the BDA-pending chat card,
 * or from the Sensors tab when bdaAvailable is true.
 *
 * @param {Actor}            ship    The ship actor.
 * @param {ChatMessage|null} message The BDA-pending chat message to update, or null.
 */
export async function launchBDAFromChat(ship, message) {
  const crewActor = await _resolveSensorsActorFromShip(ship);
  if (!crewActor) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoUserAssigned"));
    return;
  }

  // When launched from the Sensors tab (no chat card passed), try to find the
  // BDA-pending card that was stored in state when the weapon was fired.
  if (!message) {
    const storedId = ship.system.resources?.sensors?.bdaMessageId ?? null;
    if (storedId) message = game.messages.get(storedId) ?? null;
  }

  // Sensor Blind (weaponsSensors medium/high): −10 to Augur tests
  const wsCond    = ship.system.conditions?.weaponsSensors?.tier;
  const sensorMod = (wsCond === "medium" || wsCond === "high") ? -10 : 0;
  const result = await SystemAdapter.current.rollSkillTest(crewActor, ship.system.roleSkillOverrides?.sensors ?? "sensors", sensorMod ? { modifier: sensorMod } : {});
  if (!result) return; // Cancelled by user

  const rawSL            = result.SL ?? 0;
  const targetTokenId    = ship.system.resources?.sensors?.bdaTargetTokenId ?? null;
  const originalLockTier = ship.system.resources?.sensors?.bdaOriginalLockTier ?? 4;
  const flags            = message?.flags?.[MODULE_ID] ?? {};
  const targetName       = flags.targetName ?? "Unknown";

  // Render the full fire-result card HTML from the pending data (available before GM clears it).
  // Shown for any non-negative SL (SL 0 = marginal pass  -  lock lost but data gathered).
  let fireResultHtml = null;
  if (rawSL >= 0) {
    const pendingRaw = ship.system.resources?.sensors?.pendingFireResult ?? null;
    if (pendingRaw) {
      try {
        const { templateData: td } = JSON.parse(pendingRaw);
        fireResultHtml = await renderTemplate(
          `modules/${CORE_MODULE_ID}/templates/chat/fire-result.hbs`,
          td,
        );
      } catch (e) {
        console.error(`${MODULE_ID} | Failed to render pendingFireResult`, e);
      }
    }
  }

  // Notify GM  -  resolves lock retention + clears pendingFireResult
  emitToGM("resolveBDA", { targetTokenId, sl: rawSL, messageId: message?.id ?? null });

  // Update the BDA chat card with roll result + embedded fire result
  if (message) {
    const signedSL = rawSL >= 0 ? `+${rawSL}` : `${rawSL}`;
    const updatedContent = await renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/bda-pending.hbs`,
      {
        targetName,
        rolled:        true,
        success:       rawSL >= 1,
        hasFireResult: fireResultHtml !== null,
        fireResultHtml,
        sl:            rawSL,
        signedSL,
        outcome:       _lockRetainDesc(rawSL, originalLockTier),
        correctionChosen: false,
      }
    );
    await message.update({ content: updatedContent });
  }

  // Auto-open corrections popup only on a passing roll (SL ≥ 1)
  if (rawSL >= 1) {
    const popup = new BDAPopup({
      ship, targetTokenId, sl: rawSL,
      messageId: message?.id ?? null,
      targetName, fireResultHtml,
      originalLockTier,
    });
    popup.render(true);
  }
}

// ── Corrections-only popup ─────────────────────────────────────────────────────

export class BDAPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  ship          = null;
  targetTokenId    = null;
  /** SL result from the BDA roll */
  sl               = 0;
  /** ID of the originating BDA-pending chat message (may be null) */
  messageId        = null;
  /** Display name of the target */
  targetName       = null;
  /** Rendered HTML of the full fire-result card to embed in the BDA card (null on failed BDA) */
  fireResultHtml   = null;
  /** Pre-fire lock tier (for clamping the retain description) */
  originalLockTier = 4;

  constructor(options = {}) {
    super(options);
    this.ship             = options.ship;
    this.targetTokenId    = options.targetTokenId ?? null;
    this.sl               = options.sl ?? 0;
    this.messageId        = options.messageId ?? null;
    this.targetName       = options.targetName ?? null;
    this.fireResultHtml   = options.fireResultHtml ?? null;
    this.originalLockTier = options.originalLockTier ?? 4;
  }

  static DEFAULT_OPTIONS = {
    id: "shipcombat-bda-popup",
    classes: ["shipcombat-bda-popup"],
    window: { title: "SHIPCOMBAT.BDA.Title", resizable: false },
    position: { width: 420, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/bda-popup.hbs` },
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const corrections = BDA_CORRECTIONS.map(c => ({
      ...c,
      labelLocalized: game.i18n.localize(c.label),
      descLocalized:  game.i18n.localize(c.desc),
    }));
    return {
      ...context,
      resultSL:   this.sl,
      retainDesc: _lockRetainDesc(this.sl, this.originalLockTier),
      corrections,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelectorAll("[data-action='selectCorrection']").forEach(btn => {
      btn.addEventListener("click", async ev => {
        ev.preventDefault();
        await this._doSelectCorrection(btn.dataset.correctionId);
      });
    });
  }

  async _doSelectCorrection(correctionId) {
    const sys           = this.ship.system;
    const targetTokenId = this.targetTokenId ?? sys.resources?.sensors?.bdaTargetTokenId ?? null;
    const sl            = this.sl;

    const correction = BDA_CORRECTIONS.find(c => c.id === correctionId);
    if (!correction) return;

    if (correctionId === "ceaseFireSwitch") {
      // Grant 20% of max AP and drop the lock on the target to Lock 0
      const reactor = this.ship?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system?.slot === "reactor");
      const maxAP = reactor?.system?.bankCapacity ?? 0;
      const currentAP = this.ship?.system?.resources?.engineer?.auxiliaryPower ?? 0;
      const grant = Math.floor(maxAP * 0.2);
      emitToGM("updateResource", { roleId: "engineer", key: "auxiliaryPower", value: Math.min(maxAP, currentAP + grant) });
      if (targetTokenId) emitToGM("removeLock", { targetTokenId });
      emitToGM("updateResource", { roleId: "sensors", key: "bdaCorrectionPending", value: false });
    } else {
      emitToGM("setFireCorrection", {
        type:          correctionId,
        targetTokenId: targetTokenId ?? null,
        weaponId:      null,
        sl,
      });
      emitToGM("updateResource", { roleId: "sensors", key: "bdaCorrectionPending", value: false });
    }

    // Update the originating BDA chat card with the chosen correction
    if (this.messageId) {
      const message = game.messages.get(this.messageId);
      if (message) {
        const targetName = this.targetName ?? message.flags?.[MODULE_ID]?.targetName ?? "Unknown";
        const signedSL   = sl >= 0 ? `+${sl}` : `${sl}`;
        const updatedContent = await renderTemplate(
          `modules/${CORE_MODULE_ID}/templates/chat/bda-pending.hbs`,
          {
            targetName,
            rolled:           true,
            success:          sl >= 1,
            hasFireResult:    this.fireResultHtml !== null,
            fireResultHtml:   this.fireResultHtml,
            sl,
            signedSL,
            outcome:          _lockRetainDesc(sl, this.originalLockTier),
            correctionChosen: true,
            correctionIcon:   correction.icon,
            correctionLabel:  game.i18n.localize(correction.label),
            correctionDesc:   game.i18n.localize(correction.desc),
          }
        );
        await message.update({ content: updatedContent });
      }
    }

    this.close();
  }
}
