/**
 * Bound duplicate delivery of state-changing work to one execution.
 * Successful results remain cached; failures are evicted so callers can retry.
 */
export class IdempotencyGate {
  constructor({ maxEntries = 500 } = {}) {
    this.maxEntries = Math.max(1, maxEntries);
    this.entries = new Map();
  }

  run(key, operation) {
    if (!key) return Promise.resolve().then(operation);
    if (this.entries.has(key)) return this.entries.get(key).promise;

    const pending = Promise.resolve().then(operation);
    const entry = { promise: pending, settled: false };
    this.entries.set(key, entry);
    pending.then(
      () => {
        entry.settled = true;
        this._prune();
      },
      () => {},
    );
    pending.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this._prune();
    return pending;
  }

  _prune() {
    while (this.entries.size > this.maxEntries) {
      const settledKey = [...this.entries].find(([, value]) => value.settled)?.[0];
      if (!settledKey) break;
      this.entries.delete(settledKey);
    }
  }

  clear() {
    this.entries.clear();
  }
}

export function combatTransitionKey(combat, changes = {}) {
  if (!combat?.id || (!("round" in changes) && !("turn" in changes))) return null;
  return [
    combat.id,
    combat._stats?.modifiedTime ?? combat._source?._stats?.modifiedTime ?? "",
    combat.round ?? "",
    combat.turn ?? "",
    combat.previous?.combatantId ?? "",
    combat.combatant?.id ?? "",
  ].join(":");
}
