/** Instance-aware Captain cards. Legacy string entries are normalized lazily. */

function _randomId() {
  return globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function createCaptainCard(cardId, { salvaged = false } = {}) {
  return { instanceId: _randomId(), cardId, salvaged: !!salvaged };
}

export function normalizeCaptainCard(entry, fallbackKey = "legacy") {
  if (typeof entry === "string") {
    return { instanceId: `${fallbackKey}-${entry}`, cardId: entry, salvaged: false };
  }
  const cardId = entry?.cardId ?? entry?.id ?? "";
  return {
    ...entry,
    instanceId: entry?.instanceId ?? `${fallbackKey}-${cardId}`,
    cardId,
    salvaged: !!entry?.salvaged,
  };
}

export function normalizeCaptainZone(zone, zoneKey) {
  return (zone ?? []).map((entry, index) => normalizeCaptainCard(entry, `${zoneKey}-${index}`));
}

export function captainCardId(entry) {
  return typeof entry === "string" ? entry : (entry?.cardId ?? entry?.id ?? "");
}

export function shuffleCaptainCards(cards) {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

/** Predict the next-round hand count without mutating or shuffling any zones. */
export function projectCaptainHandCount({ hand, drawPile, discardPile, nextHandCap }) {
  const cap = Math.max(0, Number(nextHandCap) || 0);
  const retainedCount = Math.min(normalizeCaptainZone(hand, "hand").length, cap);
  const needed = cap - retainedCount;
  if (needed <= 0) return retainedCount;

  const drawCount = normalizeCaptainZone(drawPile, "draw").length;
  const availableCount = drawCount > 0
    ? drawCount
    : normalizeCaptainZone(discardPile, "discard").length;
  return retainedCount + Math.min(needed, availableCount);
}

/** Apply the next round's hand limit, then refill empty slots. */
export function prepareCaptainHandForRound({ hand, drawPile, discardPile, nextHandCap }) {
  const nextHand = normalizeCaptainZone(hand, "hand");
  let nextDrawPile = normalizeCaptainZone(drawPile, "draw");
  let nextDiscardPile = normalizeCaptainZone(discardPile, "discard");
  const cap = Math.max(0, Number(nextHandCap) || 0);

  const overflow = nextHand.splice(cap);
  let discardedOverflowCount = 0;
  for (const card of overflow) {
    if (card.salvaged) nextDrawPile.push({ ...card, salvaged: false });
    else {
      nextDiscardPile.push(card);
      discardedOverflowCount += 1;
    }
  }

  if (nextHand.length < cap && !nextDrawPile.length && nextDiscardPile.length) {
    nextDrawPile = shuffleCaptainCards(nextDiscardPile);
    nextDiscardPile = [];
  }

  // Do not reshuffle mid-draw. A partially depleted draw pile can leave one
  // round below the hand limit; recycling occurs next round when it starts empty.
  const drawCount = Math.min(cap - nextHand.length, nextDrawPile.length);
  nextHand.push(...nextDrawPile.splice(0, drawCount));

  return { hand: nextHand, drawPile: nextDrawPile, discardPile: nextDiscardPile, discardedOverflowCount };
}
