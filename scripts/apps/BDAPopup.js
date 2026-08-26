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
import { resolveSensorsOperatorActor } from "../roles/crew-operators.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

function _getBdaAttacks(ship) {
  return SystemAdapter.current.getShipData(ship)?.resources?.sensors?.bdaAttacks ?? {};
}

function _nextBdaAttack(ship, status = null) {
  return Object.values(_getBdaAttacks(ship))
    .filter(attack => !status || attack.status === status)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0] ?? null;
}

async function _renderFireResult(attack, sl) {
  if (sl < 0 || !attack?.pendingFireResult) return null;
  try {
    const { templateData } = JSON.parse(attack.pendingFireResult);
    return renderTemplate(
      `modules/${CORE_MODULE_ID}/templates/chat/fire-result.hbs`,
      templateData,
    );
  } catch (e) {
    console.error(`${MODULE_ID} | Failed to render BDA attack ${attack?.attackId ?? "unknown"}`, e);
    return null;
  }
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
 * or from the Sensors tab when a pending per-attack record exists.
 *
 * @param {Actor}            ship    The ship actor.
 * @param {ChatMessage|null} message The BDA-pending chat message to update, or null.
 * @param {string|null}      attackId Stable per-attack identifier.
 */
export async function launchBDAFromChat(ship, message, attackId = null) {
  const sys = SystemAdapter.current.getShipData(ship);
  const requestedAttackId = attackId ?? message?.flags?.[MODULE_ID]?.attackId ?? null;
  attackId = requestedAttackId;
  let attack = requestedAttackId ? _getBdaAttacks(ship)[requestedAttackId] : null;
  const flaggedCreatedAt = message?.flags?.[MODULE_ID]?.attackCreatedAt ?? null;
  if (attack && flaggedCreatedAt !== null && attack.createdAt !== flaggedCreatedAt) {
    attack = null;
  }
  // Only legacy cards without an id may fall back to the oldest pending attack.
  // An expired exact card must never open a different shot's assessment.
  if (!requestedAttackId) {
    attack = _nextBdaAttack(ship, "pending");
    attackId = attack?.attackId ?? null;
  }
  if (!attack || !attackId) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.BDANotAvailable"));
    return;
  }

  if (!game.user.isGM && game.user.id !== attack.operatorUserId) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.BDAOperatorOnly"));
    return;
  }

  const crewActor = await resolveSensorsOperatorActor(ship);
  if (!crewActor) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoUserAssigned"));
    return;
  }

  if (!message && attack.messageId) message = game.messages.get(attack.messageId) ?? null;

  // Sensor Blind (weaponsSensors medium/high): −10 to Augur tests
  const wsCond    = sys.conditions?.weaponsSensors?.tier;
  const sensorMod = (wsCond === "medium" || wsCond === "high") ? -10 : 0;
  const result = await SystemAdapter.current.rollSkillTest(crewActor, sys.roleSkillOverrides?.sensors ?? "sensors", sensorMod ? { modifier: sensorMod } : {});
  if (!result) return; // Cancelled by user

  const rawSL            = result.SL ?? 0;
  const targetTokenId    = attack.targetTokenId ?? null;
  const originalLockTier = attack.originalLockTier ?? 4;
  const flags            = message?.flags?.[MODULE_ID] ?? {};
  const targetName       = attack.targetName ?? flags.targetName ?? "Unknown";

  // Render the full fire-result card HTML from the pending data (available before GM clears it).
  // Shown for any non-negative SL (SL 0 = marginal pass  -  lock lost but data gathered).
  const fireResultHtml = await _renderFireResult(attack, rawSL);

  // Notify GM - resolves only this attack's lock retention and state.
  emitToGM("resolveBDA", { attackId, sl: rawSL, messageId: message?.id ?? null });

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
      ship, attackId, targetTokenId, sl: rawSL,
      messageId: message?.id ?? null,
      targetName, fireResultHtml,
      originalLockTier,
    });
    popup.render(true);
  }
}

// ── Corrections-only popup ─────────────────────────────────────────────────────

export class BDAPopup extends foundry.appv1.api.Application {
  ship          = null;
  attackId         = null;
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
    this.attackId         = options.attackId ?? null;
    this.targetTokenId    = options.targetTokenId ?? null;
    this.sl               = options.sl ?? 0;
    this.messageId        = options.messageId ?? null;
    this.targetName       = options.targetName ?? null;
    this.fireResultHtml   = options.fireResultHtml ?? null;
    this.originalLockTier = options.originalLockTier ?? 4;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "shipcombat-bda-popup",
      classes:   ["shipcombat-bda-popup"],
      title:     game.i18n.localize("SHIPCOMBAT.BDA.Title"),
      template:  `modules/${CORE_MODULE_ID}/templates/apps/bda-popup.hbs`,
      width:     420,
      height:    "auto",
      resizable: false,
    });
  }

  async getData(options) {
    const context = await super.getData(options);
    const corrections = BDA_CORRECTIONS.map(c => ({
      ...c,
      labelLocalized: game.i18n.localize(c.label),
      descLocalized:  game.i18n.localize(c.desc),
    }));
    return {
      ...context,
      resultLabel: SystemAdapter.current.formatAllocationUnit(this.sl, { capitalize: true }),
      resultValue: this.sl,
      retainDesc: _lockRetainDesc(this.sl, this.originalLockTier),
      corrections,
    };
  }

  activateListeners($html) {
    super.activateListeners($html);
    const html = $html[0];
    html.querySelectorAll("[data-action='selectCorrection']").forEach(btn => {
      btn.addEventListener("click", async ev => {
        ev.preventDefault();
        await this._doSelectCorrection(btn.dataset.correctionId);
      });
    });
  }

  async _doSelectCorrection(correctionId) {
    const sys           = SystemAdapter.current.getShipData(this.ship);
    const attack        = sys.resources?.sensors?.bdaAttacks?.[this.attackId] ?? null;
    const targetTokenId = this.targetTokenId ?? attack?.targetTokenId ?? null;
    const sl            = this.sl ?? attack?.sl ?? 0;

    const correction = BDA_CORRECTIONS.find(c => c.id === correctionId);
    if (!correction) return;

    if (correctionId === "ceaseFireSwitch") {
      // Grant 20% of max AP and drop the lock on the target to Lock 0
      const reactor = this.ship?.items?.find(i => i.type === `${MODULE_ID}.component` && i.system?.slot === "reactor");
      const maxAP = reactor?.system?.bankCapacity ?? 0;
      const currentAP = SystemAdapter.current.getShipData(this.ship)?.resources?.engineer?.auxiliaryPower ?? 0;
      const grant = Math.floor(maxAP * 0.2);
      emitToGM("updateResource", { roleId: "engineer", key: "auxiliaryPower", value: Math.min(maxAP, currentAP + grant) });
      if (targetTokenId) emitToGM("removeLock", { targetTokenId });
    } else {
      emitToGM("setFireCorrection", {
        type:          correctionId,
        targetTokenId: targetTokenId ?? null,
        weaponId:      null,
        sl,
      });
    }

    // Update the originating BDA chat card with the chosen correction
    const messageId = this.messageId ?? attack?.messageId ?? null;
    if (messageId) {
      const message = game.messages.get(messageId);
      if (message) {
        const targetName = this.targetName ?? message.flags?.[MODULE_ID]?.targetName ?? "Unknown";
        const signedSL   = sl >= 0 ? `+${sl}` : `${sl}`;
        const fireResultHtml = this.fireResultHtml ?? await _renderFireResult(attack, sl);
        const updatedContent = await renderTemplate(
          `modules/${CORE_MODULE_ID}/templates/chat/bda-pending.hbs`,
          {
            targetName,
            rolled:           true,
            success:          sl >= 1,
            hasFireResult:    fireResultHtml !== null,
            fireResultHtml,
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

    emitToGM("completeBDA", { attackId: this.attackId });
    this.close();
  }
}
