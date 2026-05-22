import { MODULE_ID, WEAPON_FIRED_HOOK } from "./constants.js";

/**
 * animations.js — Optional Sequencer + JB2A Patreon animation layer for ship combat.
 *
 * Only activates when both "sequencer" and "jb2a_patreon" are active.
 * All calls are fire-and-forget; errors are caught and logged so a missing
 * asset never breaks gameplay.
 *
 * Hook surface:
 *   shipCombatWeaponFired  { weapon, weaponCategory, fireMode, firingActor,
 *                              targetToken, totalHits, isNpcFire }
 *
 * DB paths verified against jb2a_patreon/scripts/jb2a_sequencer.js.
 * Sequencer resolves the correct distance variant automatically when
 * `.stretchTo()` is used with a "_template: 'ranged'" entry.
 */

// ── Asset map ────────────────────────────────────────────────────────────────
// Each entry may have:
//   muzzle      – played at source location (concurrently with projectile)
//   projectile  – stretched from source → target, blocks until done
//   impact      – played at target after projectile lands (optional)
//
// All paths are JB2A Patreon Sequencer DB keys.

const CATEGORY_ASSETS = {
  macrocannon: {
    muzzle:     "jb2a.muzzle_flash.burst.01.yellow",
    projectile: "jb2a.fire_bolt.orange",   // FireBolt_01_Regular_Orange, distance-aware
    impact:     "jb2a.explosion.01.orange",
  },
  nova_cannon: {
    muzzle:     "jb2a.muzzle_flash.burst.01.yellow",
    projectile: "jb2a.bullet.02.orange",
    impact:     "jb2a.explosion.04.orange",
  },
  railgun: {
    // FireballBeam Blue — distance-aware heavy kinetic beam
    projectile: "jb2a.fireball.beam.blue",
    impact:     "jb2a.explosion.01.blue",
  },
  pdc_projectile: {
    muzzle:     "jb2a.muzzle_flash.single.01.yellow",
    projectile: "jb2a.bullet.01.orange",
    impact:     "jb2a.explosion.01.orange",
  },
  lance: {
    // Eldritch-blast style beam — single shot, distance-aware via stretchTo
    projectile: "jb2a.eldritch_blast.lightblue",
    beam: true,
  },
  laser_pdc: {
    // Fast pulse — no visible impact
    projectile: "jb2a.bullet.Snipe.red",
  },
  plasma: {
    // MagicMissile Blue — distance-aware, multiple visual variants per distance
    projectile: "jb2a.magic_missile.blue",
    impact:     "jb2a.explosion.01.blue",
  },
  missile: {
    projectile: "jb2a.pack_hound_missile.orange.01",
    impact:     "jb2a.explosion.04.orange",
  },
  // Torpedo detonation — pure stationary blast at the torpedo token
  torpedo_detonation: {
    impact: "jb2a.explosion.08.1200.orange",
  },
};

// Scale multiplier applied to all effects for a given category
const SCALE = {
  nova_cannon:    1.5,
  macrocannon:    1.0,
  railgun:        0.7,
  pdc_projectile: 0.5,
  laser_pdc:      0.5,
  lance:          1.0,
  plasma:         0.9,
  missile:        1.0,
  torpedo_detonation: 2.5,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the first active Token placeable for the given actor on the current
 * canvas. Works for both linked (scene) and unlinked (synthetic) actors.
 * Sequencer's .atLocation() and .stretchTo() require the placeable, not the document.
 */
function actorToken(actor) {
  if (!actor) return null;
  return actor.getActiveTokens()?.[0] ?? null;
}

// ── Main animation dispatcher ─────────────────────────────────────────────

// ms between successive shots in a salvo (default, and per-category overrides)
const SHOT_STAGGER = 180;
const CATEGORY_STAGGER = {
  missile:     550,
  macrocannon: 550,
  nova_cannon: 550,
  railgun:     550,
  lance:       550,
  plasma:      550,
};

async function playWeaponAnimation({ weaponCategory, firingActor, targetToken, totalHits, totalSalvo, blastRadius }) {
  if (!weaponCategory) return;
  const assets = CATEGORY_ASSETS[weaponCategory];
  if (!assets) return;

  const sourceToken = actorToken(firingActor);
  // Need at least one anchor point
  if (!sourceToken && !targetToken) return;

  const scale = SCALE[weaponCategory] ?? 1.0;

  // Beam weapons always fire as a single shot regardless of salvo size.
  // Other weapons fire totalSalvo shots, with hits going straight and misses deviating.
  // Torpedo detonation is always a single blast regardless of hit count.
  const isDetonation = weaponCategory === "torpedo_detonation";
  const shotCount = (assets.beam || isDetonation) ? 1 : Math.max(1, totalSalvo || totalHits || 1);
  const hitCount  = (assets.beam || isDetonation) ? 1 : Math.max(0, totalHits ?? 0);

  // For torpedo detonations, scale the explosion to cover the blast diameter.
  // jb2a.explosion.08.1200.orange is 1200px at scale 1.0; derive scale from radius.
  let effectiveScale = scale;
  if (isDetonation && blastRadius && canvas?.grid?.size) {
    const diameterPx = blastRadius * 2 * canvas.grid.size;
    effectiveScale = diameterPx / 1200;
  }

  try {
    const seq = new Sequence({ moduleName: MODULE_ID, softFail: true });

    for (let i = 0; i < shotCount; i++) {
      const isHit = i < hitCount;
      const d = i * (CATEGORY_STAGGER[weaponCategory] ?? SHOT_STAGGER);

      // ── Muzzle flash: rotated to face target ──
      if (assets.muzzle && sourceToken) {
        let muzzle = seq.effect()
          .file(assets.muzzle)
          .atLocation(sourceToken)
          .scale(scale * 0.6)
          .delay(d);
        if (targetToken) muzzle = muzzle.rotateTowards(targetToken);
      }

      // ── Projectile/beam: hits go straight, misses deviate ──
      if (assets.projectile && sourceToken && targetToken) {
        let proj = seq.effect()
          .file(assets.projectile)
          .atLocation(sourceToken)
          .scale(scale)
          .delay(d);
        proj = proj.stretchTo(targetToken);
        if (!isHit) {
          proj = proj.missed();
        } else if (assets.impact && i === hitCount - 1) {
          // Last hitting shot: wait until it lands before playing the impact
          proj = proj.waitUntilFinished(-100);
        }
      }
    }

    // ── Single impact at target after the last hitting shot ──
    // No delay needed — waitUntilFinished on the last projectile handles timing.
    if (assets.impact && targetToken && hitCount > 0) {
      seq.effect()
        .file(assets.impact)
        .atLocation(targetToken)
        .scale(effectiveScale);
    }

    await seq.play();
  } catch (err) {
    console.warn(`impmal-shipcombat | Animation failed for category "${weaponCategory}":`, err);
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerAnimations() {
  if (!game.modules.get("sequencer")?.active) return;
  if (!game.modules.get("jb2a_patreon")?.active) return;

  console.log("impmal-shipcombat | Sequencer + JB2A Patreon detected — registering weapon animations.");

  Hooks.on(WEAPON_FIRED_HOOK, (data) => {
    playWeaponAnimation(data);
  });
}
