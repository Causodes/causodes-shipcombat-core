import { MODULE_ID } from "../../constants.js";

export const EQUIPMENT_COMPONENT_SLOTS = Object.freeze([
  "shields", "armour", "engine", "sensor", "reactor", "weaponsBay",
]);

/** Build the persistent component fields implied by a rendered slot target. */
export function componentSlotUpdates(targetSlot, targetPosition = null) {
  if (!targetSlot) return {};
  const updates = { "system.slot": targetSlot };
  if (targetSlot !== "weapon" || !targetPosition) return updates;
  if (targetPosition === "port" || targetPosition === "starboard") {
    updates["system.weaponPosition"] = "flank";
    updates["system.weaponBay"] = targetPosition;
  } else {
    updates["system.weaponPosition"] = targetPosition;
  }
  return updates;
}

/** Apply slot-target fields to raw Item creation data. */
export function applyComponentSlotToItemData(itemData, targetSlot, targetPosition = null) {
  itemData.system ??= {};
  for (const [path, value] of Object.entries(componentSlotUpdates(targetSlot, targetPosition))) {
    itemData.system[path.slice("system.".length)] = value;
  }
  return itemData;
}

export function playerComponentDropError(item, moduleId = MODULE_ID) {
  return item?.type === `${moduleId}.component`
    ? null
    : "SHIPCOMBAT.Warning.OnlyComponents";
}

/**
 * Validate the deliberately narrower NPC component contract.
 * NPC sheets accept weapon components only, and only in their authored arc.
 * Returns a localization key on rejection and null on success.
 */
export function npcComponentDropError(item, targetSlot, targetPosition, moduleId = MODULE_ID) {
  const playerError = playerComponentDropError(item, moduleId);
  if (playerError) return playerError;
  if (item.system?.slot !== "weapon") return "SHIPCOMBAT.Warning.NpcWeaponsOnly";
  if (targetSlot !== "weapon" || !targetPosition) return null;
  const itemPosition = item.system?.weaponPosition ?? "prow";
  const valid = itemPosition === "flank"
    ? targetPosition === "port" || targetPosition === "starboard"
    : itemPosition === targetPosition;
  return valid ? null : "SHIPCOMBAT.Warning.WrongWeaponSlot";
}

/**
 * Decide whether an imported component can be installed within current slot
 * capacity. When full, retain the Item as inventory by setting equipped=false.
 */
export function prepareImportedComponentPlacement(
  shipData,
  existingItems,
  itemData,
  { explicitWeaponPosition = false, moduleId = MODULE_ID } = {},
) {
  const system = itemData.system ??= {};
  if (system.equipped === false) return true;
  const components = [...(existingItems ?? [])].filter(item =>
    item.type === `${moduleId}.component` && item.system?.equipped !== false
  );

  if (system.slot === "weapon") {
    const position = system.weaponPosition ?? "prow";
    if (position === "flank" && !explicitWeaponPosition) {
      const bays = ["port", "starboard"].map((id, index) => {
        const capacity = Math.max(0, Number(shipData?.weaponSlots?.[id] ?? 0));
        const used = components.filter(item =>
          item.system?.slot === "weapon"
          && (item.system?.weaponPosition ?? "prow") === "flank"
          && (item.system?.weaponBay ?? "port") === id
        ).length;
        return { id, index, capacity, used };
      }).filter(bay => bay.capacity > 0 && bay.used < bay.capacity);

      bays.sort((left, right) =>
        (left.used / left.capacity) - (right.used / right.capacity) || left.index - right.index
      );
      if (bays.length > 0) {
        system.weaponBay = bays[0].id;
        return true;
      }
    } else {
      const section = position === "flank" ? (system.weaponBay ?? "port") : position;
      const capacity = Math.max(0, Number(shipData?.weaponSlots?.[section] ?? 0));
      const used = components.filter(item => {
        if (item.system?.slot !== "weapon") return false;
        const itemPosition = item.system?.weaponPosition ?? "prow";
        const itemSection = itemPosition === "flank"
          ? (item.system?.weaponBay ?? "port")
          : itemPosition;
        return itemSection === section;
      }).length;
      if (used < capacity) return true;
    }
  } else if (EQUIPMENT_COMPONENT_SLOTS.includes(system.slot)) {
    const capacity = Math.max(0, Number(shipData?.equipmentSlots?.[system.slot] ?? 0));
    const used = components.filter(item => item.system?.slot === system.slot).length;
    if (used < capacity) return true;
  } else {
    return true;
  }

  system.equipped = false;
  return false;
}
