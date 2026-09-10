function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

/**
 * Build the left-to-right Power Core display.
 *
 * Committed cores stay anchored on the left, cores currently being staged
 * occupy the next slots, and unallocated cores remain on the right. This
 * means staging a newly overclocked core changes that rightmost pip in place
 * instead of moving it between older commitments.
 */
export function buildPowerCorePips({
  assigned = 0,
  shieldCommitted = 0,
  auxiliaryCommitted = 0,
  staged = 0,
  shieldStaged = 0,
  auxiliaryStaged = 0,
  available = 0,
} = {}) {
  const groups = [
    ["assigned", assigned],
    ["shield-committed", shieldCommitted],
    ["aux-committed", auxiliaryCommitted],
    ["staged", staged],
    ["shield-staged", shieldStaged],
    ["aux-staged", auxiliaryStaged],
    ["available", available],
  ];
  return groups.flatMap(([state, amount]) =>
    Array.from({ length: count(amount) }, () => ({ state })),
  );
}
