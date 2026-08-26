import { MODULE_ID } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const GREEK = "αβγδεζηθικλμνξοπρστυφχψω";

function _designationMode() {
  try {
    return game.settings.get(MODULE_ID, "contactDesignation") ?? "naval-greek";
  } catch {
    return "naval-greek";
  }
}

function _ordinalSuffix(ordinal, mode) {
  const value = Math.max(1, Number(ordinal) || 1);
  const useGreek = mode.includes("greek") || mode === "naval-greek";
  // Greek has only 24 distinct letters. Fall back to the ordinal afterwards
  // instead of wrapping and producing a duplicate Bandit-α.
  return useGreek && value <= GREEK.length ? GREEK[value - 1] : String(value);
}

export function getContactRecord(shipData, targetTokenId) {
  return shipData?.resources?.sensors?.contacts?.[targetTokenId] ?? null;
}

function _dispositions() {
  return globalThis.CONST?.TOKEN_DISPOSITIONS ?? { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 };
}

/** Resolve ordnance allegiance from its parent ship instead of its neutral token default. */
export function getEffectiveTokenDisposition(token) {
  const tokenDoc = token?.document ?? token;
  const actor = tokenDoc?.actor ?? token?.actor ?? null;
  const parentShipTokenId = SystemAdapter.current.getShipData(actor)?.parentShipTokenId ?? null;
  const parent = parentShipTokenId ? canvas?.tokens?.get(parentShipTokenId) : null;
  return parent?.document?.disposition ?? tokenDoc?.disposition ?? _dispositions().NEUTRAL;
}

export function isFriendlyContactToken(token) {
  return getEffectiveTokenDisposition(token) === _dispositions().FRIENDLY;
}

/** Shared eligibility rule relative to the acting ship's token disposition. */
export function isTargetableContactToken(token, ownActor, { requireVisible = true } = {}) {
  const actor = token?.document?.actor ?? token?.actor ?? null;
  if (!actor) return false;
  if (requireVisible && token.visible === false) return false;
  if (ownActor && actor.id === ownActor.id) return false;
  const ownTokenIds = new Set((ownActor?.getActiveTokens?.() ?? []).map(own => own.id));
  if (ownTokenIds.has(token.id ?? token.document?.id)) return false;

  const disposition = getEffectiveTokenDisposition(token);
  const { HOSTILE, NEUTRAL, FRIENDLY } = _dispositions();
  if (disposition === NEUTRAL) return true;

  const ownToken = ownActor?.getActiveTokens?.()?.[0] ?? null;
  const ownDisposition = ownToken
    ? getEffectiveTokenDisposition(ownToken)
    : FRIENDLY;
  if (ownDisposition === HOSTILE) return disposition === FRIENDLY;
  if (ownDisposition === FRIENDLY) return disposition === HOSTILE;
  return disposition === HOSTILE || disposition === FRIENDLY;
}

/**
 * Return an updated contact registry and stable ordinal for a target. Contact
 * identity survives lock consumption; only live targeting quality lives in the
 * lock array.
 */
export function ensureContactRecord(shipData, targetTokenId, { tier = 0, realName = null } = {}) {
  const sensors = shipData?.resources?.sensors ?? {};
  const contacts = foundry.utils.deepClone(sensors.contacts ?? {});
  const existing = contacts[targetTokenId] ?? null;
  const maxOrdinal = Math.max(0, ...Object.values(contacts).map(contact => Number(contact?.ordinal) || 0));
  const nextOrdinal = Math.max(Number(sensors.nextContactOrdinal) || 1, maxOrdinal + 1);
  const ordinal = existing?.ordinal ?? nextOrdinal;
  const identifiedName = existing?.identifiedName
    ?? ((tier >= 3 && realName) ? realName : null);

  contacts[targetTokenId] = {
    ...existing,
    ordinal,
    confirmed: !!existing?.confirmed || tier >= 1,
    identifiedName,
  };

  return {
    contacts,
    nextContactOrdinal: existing ? nextOrdinal : ordinal + 1,
    record: contacts[targetTokenId],
  };
}

/** Stable crew-facing designation, independent of the current lock tier. */
export function getContactDesignation(shipData, targetTokenId, { currentTier = 0, fallbackOrdinal = null, disposition = null } = {}) {
  const sensors = shipData?.resources?.sensors ?? {};
  const record = getContactRecord(shipData, targetTokenId);
  const locks = sensors.locks ?? [];
  const lockIndex = locks.findIndex(lock => lock.targetTokenId === targetTokenId);
  const ordinal = record?.ordinal ?? fallbackOrdinal ?? Math.max(1, lockIndex + 1);
  const mode = _designationMode();
  const suffix = _ordinalSuffix(ordinal, mode);

  if (mode.startsWith("naval")) {
    const resolvedDisposition = disposition ?? getEffectiveTokenDisposition(canvas?.tokens?.get(targetTokenId));
    const { HOSTILE, NEUTRAL, FRIENDLY } = _dispositions();
    if (resolvedDisposition === HOSTILE) return `Bandit-${suffix}`;
    if (resolvedDisposition === NEUTRAL) return `Bogey-${suffix}`;
    if (resolvedDisposition === FRIENDLY) return `Friendly-${suffix}`;
    const confirmed = !!record?.confirmed || currentTier >= 1;
    return `${confirmed ? "Bandit" : "Bogey"}-${suffix}`;
  }
  return `Contact-${suffix}`;
}

/**
 * Shared label for radar, Captain, Gunner, Pilot, Ordnance, BDA, and overlays.
 * A Deep Scan permanently remembers the real identity, while the designation
 * remains available after the live lock is lost.
 */
export function getContactDisplayName(
  shipData,
  targetTokenId,
  { currentTier = 0, realName = null, includeIdentity = true, fallbackOrdinal = null, disposition = null } = {},
) {
  const designation = getContactDesignation(shipData, targetTokenId, { currentTier, fallbackOrdinal, disposition });
  if (!includeIdentity) return designation;
  const record = getContactRecord(shipData, targetTokenId);
  const identifiedName = record?.identifiedName ?? ((currentTier >= 3 && realName) ? realName : null);
  return identifiedName ? `${designation}: ${identifiedName}` : designation;
}
