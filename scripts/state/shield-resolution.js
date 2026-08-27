import { MODULE_ID } from "../constants.js";

export const SHIELD_RESOLUTION_SETTING = "shieldResolution";
export const SHIELD_RESOLUTION_MODES = Object.freeze({
  HIT_NEGATION: "hitNegation",
  DAMAGE_POOL: "damagePool",
});

export function usesDamagePoolShields() {
  return game.settings.get(MODULE_ID, SHIELD_RESOLUTION_SETTING) === SHIELD_RESOLUTION_MODES.DAMAGE_POOL;
}

/** Whether an attack bypasses shields after applying defender-side orders. */
export function attackBypassesShields(traits, targetData) {
  if (targetData?.resources?.captain?.hardenedShields) return false;
  return !!traits?.shieldBypass;
}

/** Resolve one hit against one shield facing using the configured shield model. */
export function resolveShieldHit({
  shields,
  incomingDamage,
  shieldBurn = 0,
  bypass = false,
  damagePool = false,
}) {
  const startingShields = Math.max(0, Number(shields) || 0);
  const damage = Math.max(0, Number(incomingDamage) || 0);
  const burn = Math.max(0, Number(shieldBurn) || 0);
  let remaining = startingShields;

  if (startingShields <= 0) {
    return {
      remaining,
      burnDrain: 0,
      damageAbsorbed: 0,
      damageThrough: damage,
      hitAbsorbed: false,
      shieldDrain: 0,
    };
  }

  if (!damagePool) {
    const burnDrain = Math.min(remaining, burn);
    if (bypass) {
      remaining -= burnDrain;
      return {
        remaining,
        burnDrain,
        damageAbsorbed: 0,
        damageThrough: damage,
        hitAbsorbed: false,
        shieldDrain: startingShields - remaining,
      };
    }
    const shieldDrain = Math.min(remaining, 1 + burn);
    remaining -= shieldDrain;
    return {
      remaining,
      burnDrain: Math.max(0, shieldDrain - 1),
      damageAbsorbed: damage,
      damageThrough: 0,
      hitAbsorbed: true,
      shieldDrain,
    };
  }

  const burnDrain = Math.min(remaining, burn);
  remaining -= burnDrain;
  if (!bypass && damage > 0 && remaining > 0) {
    const damageAbsorbed = Math.min(remaining, damage);
    remaining -= damageAbsorbed;
    return {
      remaining,
      burnDrain,
      damageAbsorbed,
      damageThrough: damage - damageAbsorbed,
      hitAbsorbed: damageAbsorbed === damage,
      shieldDrain: startingShields - remaining,
    };
  }

  return {
    remaining,
    burnDrain,
    damageAbsorbed: 0,
    damageThrough: damage,
    hitAbsorbed: false,
    shieldDrain: startingShields - remaining,
  };
}