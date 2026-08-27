export function getWeaponSectionId(weapon) {
  const position = weapon?.system?.weaponPosition ?? "prow";
  return position === "flank" ? (weapon?.system?.weaponBay ?? "port") : position;
}

export function getDisabledWeaponSectionId(data, weapons = []) {
  const condition = data?.conditions?.weaponsSensors;
  if (!condition?.tier) return null;
  if (condition.blindedSectionId) return condition.blindedSectionId;
  return weapons.length > 0 ? getWeaponSectionId(weapons[0]) : null;
}