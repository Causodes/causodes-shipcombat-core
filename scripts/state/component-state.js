import { MODULE_ID } from "../constants.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

export function assignWeaponComponent(ship, { itemId, weaponPosition, weaponBay }) {
  if (!ship) return undefined;
  return ship.updateEmbeddedDocuments("Item", [{
    _id: itemId,
    "system.equipped": true,
    "system.weaponPosition": weaponPosition,
    "system.weaponBay": weaponBay,
  }]);
}

export function unassignComponent(ship, { itemId }) {
  if (!ship) return undefined;
  return ship.updateEmbeddedDocuments("Item", [{ _id: itemId, "system.equipped": false }]);
}

export function assignEquipmentComponent(ship, { slotId, newItemId }) {
  if (!ship) return undefined;
  const allOfType = ship.items.filter(
    item => item.type === `${MODULE_ID}.component` && item.system.slot === slotId
  );
  const updates = allOfType.map(component => ({
    _id: component.id,
    "system.equipped": component.id === newItemId,
  }));
  return updates.length ? ship.updateEmbeddedDocuments("Item", updates) : undefined;
}

export function getReactorComponentStats(ship) {
  if (!ship) return {
    coreOutput: 0,
    shieldStrengthPerCore: 0,
    heatCapacity: 0,
    auxPowerCapacity: 0,
    reserveMultiplier: 0,
  };
  const reactor = ship.items.find(item =>
    item.type === `${MODULE_ID}.component`
    && item.system.slot === "reactor"
    && item.system.equipped !== false
  );
  return {
    coreOutput: reactor?.system?.coreOutput ?? reactor?.system?.rating ?? 0,
    shieldStrengthPerCore: reactor?.system?.shieldStrengthPerCore ?? 0,
    heatCapacity: reactor?.system?.heatCapacity ?? 0,
    auxPowerCapacity: reactor?.system?.bankCapacity ?? 0,
    reserveMultiplier: reactor?.system?.reserveMultiplier ?? 0,
  };
}

export function getOrdnanceBayComponentStats(ship) {
  if (!ship) return {
    ammoCapacity: 0,
    chargeCapacity: 0,
    manpower: 0,
    torpedoCapacity: 4,
    strikeCraftCapacity: 6,
  };
  const bay = ship.items.find(item =>
    item.type === `${MODULE_ID}.component`
    && item.system.slot === "weaponsBay"
    && item.system.equipped !== false
  );
  return {
    ammoCapacity: bay?.system?.bayAmmoCapacity ?? 0,
    chargeCapacity: bay?.system?.bayChargeCapacity ?? 0,
    manpower: bay?.system?.bayManpower ?? 0,
    torpedoCapacity: bay?.system?.bayTorpedoCapacity ?? 4,
    maxFlights: bay?.system?.bayMaxFlights ?? 2,
    strikeCraftCapacity: bay?.system?.bayStrikeCraftCapacity ?? 6,
  };
}

export function getShieldComponentStats(ship) {
  const fallback = {
    maxVoidFlux: 20,
    fluxToAPRate: 1,
    zoneThresholds: { bow: 8, stern: 8, port: 8, starboard: 8 },
  };
  if (!ship) return fallback;
  if (ship.type === `${MODULE_ID}.npcShip`) {
    const system = SystemAdapter.current.getShipData(ship) ?? {};
    return {
      maxVoidFlux: system.voidshieldFlux ?? 0,
      fluxToAPRate: 1,
      zoneThresholds: {
        bow: system.shieldMax?.bow ?? 0,
        stern: system.shieldMax?.stern ?? 0,
        port: system.shieldMax?.port ?? 0,
        starboard: system.shieldMax?.starboard ?? 0,
      },
    };
  }
  const shield = ship.items.find(item =>
    item.type === `${MODULE_ID}.component`
    && item.system.slot === "shields"
    && item.system.equipped !== false
  );
  if (!shield) return fallback;
  const thresholds = shield.system.zoneThresholds;
  return {
    maxVoidFlux: shield.system.maxVoidFlux ?? 0,
    fluxToAPRate: shield.system.fluxToAPRate ?? 1,
    zoneThresholds: {
      bow: thresholds?.bow ?? 0,
      stern: thresholds?.stern ?? 0,
      port: thresholds?.port ?? 0,
      starboard: thresholds?.starboard ?? 0,
    },
  };
}

export function getSensorComponentStats(ship) {
  if (!ship) return { rating: 0, bandSize: 0, autoScanRange: 0, maxRange: 0, apCostMultiplier: 1 };
  const system = SystemAdapter.current.getShipData(ship) ?? {};
  const sensor = ship.type === `${MODULE_ID}.npcShip` ? null : ship.items.find(item =>
    item.type === `${MODULE_ID}.component`
    && item.system.slot === "sensor"
    && item.system.equipped !== false
  );
  const scanRange = (sensor?.system?.autoScanRange ?? 0) || (system.autoScanRange ?? 0);
  const rangeAmpActive = (system.resources?.sensors?.effects ?? [])
    .some(effect => effect.actionId === "rangeAmplifier");
  const rawBandSize = sensor?.system?.bandSize ?? system.sensorBandSize ?? 0;
  return {
    rating: sensor?.system?.rating ?? system.sensorRating ?? 0,
    bandSize: system.resources?.gunner?.sensorBandExpanded ? rawBandSize * 2 : rawBandSize,
    autoScanRange: rangeAmpActive ? scanRange * 2 : scanRange,
    maxRange: sensor?.system?.maxRange ?? 0,
    apCostMultiplier: sensor?.system?.apCostMultiplier ?? 1,
  };
}
