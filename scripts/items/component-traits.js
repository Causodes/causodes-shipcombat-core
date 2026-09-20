export const WEAPON_TRAITS = Object.freeze([
  { key: "shieldBypass", hasValue: false },
  { key: "unlimitedRof", hasValue: false },
  { key: "shieldBurn", hasValue: true, enabledKey: "shieldBurnEnabled" },
  { key: "rend", hasValue: true, enabledKey: "rendEnabled" },
  { key: "armourPenetration", hasValue: true, enabledKey: "armourPenetrationEnabled" },
  { key: "devastating", hasValue: true, enabledKey: "devastatingEnabled" },
  { key: "unreliable", hasValue: false },
  { key: "overcharge", hasValue: false },
  { key: "hitRatingModifier", hasValue: true, allowNegative: true, enabledKey: "hitRatingModifierEnabled" },
]);

export const ORDNANCE_TRAITS = Object.freeze([
  { key: "shieldBypass", hasValue: false },
  { key: "shieldBurn", hasValue: true, enabledKey: "shieldBurnEnabled" },
  { key: "rend", hasValue: true, enabledKey: "rendEnabled" },
  { key: "armourPenetration", hasValue: true, enabledKey: "armourPenetrationEnabled" },
]);

export function buildComponentTraitUpdates(slot, result = {}) {
  const ordnance = slot === "torpedo" || slot === "strikeCraft";
  const traitPath = slot === "torpedo"
    ? "system.torpedoTraits"
    : slot === "strikeCraft"
      ? "system.craftTraits"
      : "system.traits";
  const traitDefs = ordnance ? ORDNANCE_TRAITS : WEAPON_TRAITS;
  const updates = {};
  for (const def of traitDefs) {
    if (def.hasValue) {
      updates[`${traitPath}.${def.key}`] = Number(result[`${def.key}-value`] ?? 0);
      if (def.enabledKey) {
        updates[`${traitPath}.${def.enabledKey}`] = result[def.enabledKey] === true
          || result[def.enabledKey] === "on";
      }
    } else {
      updates[`${traitPath}.${def.key}`] = result[def.key] === true || result[def.key] === "on";
    }
  }
  return updates;
}
