/** Return true when a host sheet argument is the originating drop event. */
export function isDropEvent(value) {
  return typeof value?.preventDefault === "function"
    || !!value?.dataTransfer
    || typeof value?.target?.closest === "function";
}

/**
 * Normalize the opposite AppV2 drop contracts used by supported host systems.
 *
 * warhammer-lib: (dragData, event)
 * dnd5e:         (event, resolvedDocument)
 */
export function normalizeDropArguments(first, second) {
  return isDropEvent(first)
    ? { data: second, event: first }
    : { data: first, event: second };
}

/** Accept either an already-resolved Foundry document or raw drag data. */
export function resolveDroppedDocument(data, documentName, fromDropData) {
  const isDocument = data?.documentName === documentName
    || data?.constructor?.documentName === documentName;
  return isDocument ? data : fromDropData(data);
}
