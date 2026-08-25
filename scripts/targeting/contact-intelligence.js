import { MODULE_ID } from "../constants.js";

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
export function getContactDesignation(shipData, targetTokenId, { currentTier = 0, fallbackOrdinal = null } = {}) {
  const sensors = shipData?.resources?.sensors ?? {};
  const record = getContactRecord(shipData, targetTokenId);
  const locks = sensors.locks ?? [];
  const lockIndex = locks.findIndex(lock => lock.targetTokenId === targetTokenId);
  const ordinal = record?.ordinal ?? fallbackOrdinal ?? Math.max(1, lockIndex + 1);
  const mode = _designationMode();
  const suffix = _ordinalSuffix(ordinal, mode);

  if (mode.startsWith("naval")) {
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
  { currentTier = 0, realName = null, includeIdentity = true, fallbackOrdinal = null } = {},
) {
  const designation = getContactDesignation(shipData, targetTokenId, { currentTier, fallbackOrdinal });
  if (!includeIdentity) return designation;
  const record = getContactRecord(shipData, targetTokenId);
  const identifiedName = record?.identifiedName ?? ((currentTier >= 3 && realName) ? realName : null);
  return identifiedName ? `${designation}: ${identifiedName}` : designation;
}
