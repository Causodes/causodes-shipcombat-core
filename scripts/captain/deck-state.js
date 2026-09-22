import { buildCaptainDeck } from "../constants.js";
import { getCaptainDeckExclusions } from "./card-instances.js";

/** Build every Captain zone from the shared crew-layout eligibility rules. */
export function buildInitialCaptainZones(crewSize = 6, handSize = 3) {
  const exclusions = getCaptainDeckExclusions(crewSize);
  const drawPile = buildCaptainDeck(exclusions.roles, exclusions.cards);
  const hand = drawPile.splice(0, Math.max(0, Number(handSize) || 0));
  return { hand, drawPile, discardPile: [] };
}

export function buildCaptainDeckForCrew(crewSize = 6) {
  return buildInitialCaptainZones(crewSize, 0).drawPile;
}
