function _tierPenalty(tier) {
  return tier === "high" ? 4 : tier === "medium" ? 2 : tier === "low" ? 1 : 0;
}

export function getMovementConditionPenalties(data) {
  return {
    speed: _tierPenalty(data?.conditions?.engines?.tier),
    maneuverability: _tierPenalty(data?.conditions?.manoeuvring?.tier),
  };
}