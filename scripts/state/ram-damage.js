export function calculateRawRamDamage({
  rammingBase,
  targetBase,
  rammingBowArmour,
  angleModifier,
  thrustPct,
  coefficient = 2,
}) {
  const thrustMultiplier = Math.max(0, Number(thrustPct) || 0) / 100;
  const damageToRammed = Math.max(
    1,
    Math.round(rammingBase * thrustMultiplier * angleModifier * coefficient),
  );
  const rawDamageToRamming = Math.round(targetBase * thrustMultiplier * coefficient);
  const damageToRamming = Math.max(0, rawDamageToRamming - rammingBowArmour);

  return { damageToRammed, damageToRamming, thrustMultiplier };
}