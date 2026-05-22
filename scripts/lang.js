/**
 * Lang token substitution.
 *
 * Lets lang values reference other lang keys with `{{Some.Key}}` syntax so
 * we don't have to repeat role names (or any other cross-referenced label)
 * in dozens of strings. Resolution happens once at "i18nInit" against the
 * merged translation tree, after every module's lang files have been
 * loaded — so an adapter override of `SHIPCOMBAT.Role.Pilot` propagates to every
 * string that mentions the pilot role.
 *
 * Tokens must be a fully-qualified dot path. Nested tokens are not
 * supported and unresolved tokens are left in place (so missing keys are
 * obvious in-game rather than silently erased).
 */

import { SystemAdapter } from "./systems/SystemAdapter.js";

// British-to-American spelling substitution table.
// Applied to every SHIPCOMBAT string value when the active adapter reports
// `englishVariant === "american"`.
const _BRITISH_TO_AMERICAN = [
  [/Armour/g,          "Armor"],
  [/armour/g,          "armor"],
  [/Manoeuvrability/g, "Maneuverability"],
  [/manoeuvrability/g, "maneuverability"],
  [/Manoeuvring/g,     "Maneuvering"],
  [/manoeuvring/g,     "maneuvering"],
  [/Manoeuvre/g,       "Maneuver"],
  [/manoeuvre/g,       "maneuver"],
];

function _applyAmericanEnglish(tree) {
  const shipcombat = tree.SHIPCOMBAT;
  if (!shipcombat) return;
  _applyVariants(shipcombat);
}

function _applyVariants(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      let s = v;
      for (const [rx, rep] of _BRITISH_TO_AMERICAN) s = s.replace(rx, rep);
      obj[k] = s;
    } else if (v && typeof v === "object") {
      _applyVariants(v);
    }
  }
}

const TOKEN_RX = /\{\{([\w.-]+)\}\}/g;

/** Walk `obj`, replacing `{{Some.Key}}` tokens in every string value. */
function _substituteTree(obj, root) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      if (v.includes("{{")) {
        obj[k] = v.replace(TOKEN_RX, (_, path) => _resolve(path, root) ?? `{{${path}}}`);
      }
    } else if (v && typeof v === "object") {
      _substituteTree(v, root);
    }
  }
}

function _resolve(path, root) {
  let node = root;
  for (const seg of path.split(".")) {
    if (node == null || typeof node !== "object") return null;
    node = node[seg];
  }
  return typeof node === "string" ? node : null;
}

/**
 * Wire token substitution into Foundry's i18n init. Call once during the
 * module's "init" hook.
 */
export function registerLangSubstitution() {
  Hooks.once("i18nInit", () => {
    const tree = game.i18n.translations;
    if (!tree) return;
    // Two passes: lets a token resolve to a string that itself contains a
    // token (one level of indirection is enough for everything we do).
    _substituteTree(tree, tree);
    _substituteTree(tree, tree);

    // Apply American English spelling variants if the active adapter requests it.
    // Runs after substitution so token-expanded strings are also normalised.
    if (SystemAdapter._current?.englishVariant === "american") {
      _applyAmericanEnglish(tree);
    }
  });
}
