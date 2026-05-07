/**
 * NpcShipSheetMixin – system-agnostic NPC ship actor sheet.
 *
 * Usage:
 *   import { NpcShipSheetMixin } from ".../NpcShipSheetMixin.js";
 *   export class NpcShipSheet extends NpcShipSheetMixin(SystemAdapter.current.SheetBaseClass) {}
 *
 * The mixin owns all layout, context, helm wiring, and action handlers.
 * DEFAULT_OPTIONS.classes is intentionally empty — the concrete class injects
 * system-specific CSS classes.
 */

import { MODULE_ID, CORE_MODULE_ID, MACRO_FIRE_TIERS, LANCE_CHARGE_TIERS, SHIP_CLASSIFICATIONS, buildChargeTiers, CRIT_CONDITIONS, CRIT_LOCATIONS } from "../../constants.js";
import { isTorpedo, isStrikeCraft } from "../ordnance/ordnance-types.js";
import { ShipCombatState } from "../../state/ShipCombatState.js";
import { HelmPreview } from "../../canvas/HelmPreview.js";
import { WeaponArcOverlay } from "../../canvas/WeaponArcOverlay.js";
import { buildHelmContext, helmUpdatePreview } from "../../roles/pilot.js";
import { heatColor } from "../../theme.js";
import { enrichWeaponForGunner } from "../../roles/gunner.js";
import { TargetingPopup } from "../../apps/TargetingPopup.js";
import { RecoverCraftPopup } from "../../apps/StrikeCraftPopups.js";
import { RamTargetPopup } from "../../apps/RamTargetPopup.js";
import { SystemAdapter } from "../../systems/SystemAdapter.js";

async function _animateTokenPath(token, waypoints, projected) {
  const canvasToken = token.object ?? token;
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    await canvasToken.animate(
      { x: wp.x, y: wp.y, rotation: wp.rotation },
      { duration: 50, chain: i > 0 },
    );
  }
  await token.document.update(
    { x: projected.x, y: projected.y, rotation: projected.rotation },
    { animate: false },
  );
}

const SECTORS = ["bow", "stern", "port", "starboard"];
const WEAPON_SECTIONS = [
  { id: "port",      label: "SHIPCOMBAT.Slot.Port" },
  { id: "starboard", label: "SHIPCOMBAT.Slot.Starboard" },
  { id: "prow",      label: "SHIPCOMBAT.Slot.Prow" },
  { id: "dorsal",    label: "SHIPCOMBAT.Slot.Dorsal" },
  { id: "stern",     label: "SHIPCOMBAT.Slot.Stern" },
];
const SECTOR_ABBR = { bow: "BOW", stern: "STN", port: "PRT", starboard: "STBD" };

export const NpcShipSheetMixin = (BaseClass) => {
  class NpcShipSheetBase extends BaseClass {

    static DEFAULT_OPTIONS = {
      // classes intentionally empty — concrete class provides system-specific classes
      classes: [],
      actions: {
        npcAdjustShield:    _onAdjustShield,
        npcSuppressFire:    _onSuppressFire,
        npcReduceHeat:      _onReduceHeat,
        npcFullReset:       _onFullReset,
        npcRefillShields:   _onRefillShields,
        npcFluxToCharge:    _onFluxToCharge,
        npcRollPiloting:    _onNpcRollPiloting,
        npcRollInitiative:  _onNpcRollInitiative,
        npcAllocBonus:      _onNpcAllocBonus,
        npcConfirmHelm:     _onNpcConfirmHelm,
        npcRam:             _onNpcRam,
        npcRollOrdnance:     _onNpcRollOrdnance,
        npcAllocGunnerSL:    _onNpcAllocGunnerSL,
        npcFireWeapon:       _onNpcFireWeapon,
        npcLaunchTorpedo:    _onNpcLaunchTorpedo,
        npcLaunchStrikeCraft: _onNpcLaunchStrikeCraft,
        npcOpenOrdTemplate:  _onNpcOpenOrdTemplate,
        npcRemoveOrdTemplate: _onNpcRemoveOrdTemplate,
        panToOrdnance:       _onNpcPanToOrdnance,
        npcRTB:              _onNpcRTB,
        npcStepCondition:    _onNpcStepCondition,
      },
      position: { width: 640, height: 720 },
      defaultTab: "main",
    };

    static PARTS = {
      header:   { template: `modules/${CORE_MODULE_ID}/templates/actor/partials/npc-ship-header.hbs`,    classes: ["vehicle-header"], scrollable: [""] },
      tabs:     { template: "templates/generic/tab-navigation.hbs" },
      main:     { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-body.hbs`,      scrollable: [""] },
      movement: { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-movement.hbs`,  scrollable: [""] },
      gunner:   { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-gunner.hbs`,    scrollable: [""] },
      ordnance: { template: `modules/${CORE_MODULE_ID}/templates/actor/tabs/npc/npc-ship-ordnance.hbs`,  scrollable: [""] },
    };

    static TABS = {
      main:     { id: "main",     group: "primary", label: "SHIPCOMBAT.Tab.Overview"  },
      movement: { id: "movement", group: "primary", label: "SHIPCOMBAT.Tab.Movement" },
      gunner:   { id: "gunner",   group: "primary", label: "SHIPCOMBAT.Tab.NpcWeapons" },
      ordnance: { id: "ordnance", group: "primary", label: "SHIPCOMBAT.NpcShip.OrdnanceTab" },
    };

    get isEditable() { return true; }

    async _preparePartContext(partId, context) {
      context = await super._preparePartContext(partId, context);
      const sys = this.actor.system;

      const shields = {};
      for (const s of SECTORS) {
        const val = sys.shields?.[s] ?? 0;
        const max = sys.shieldMax?.[s] ?? 0;
        shields[s] = { val, max, pct: max > 0 ? Math.round((val / max) * 100) : 0, over: val > max };
      }

      const hullPct = sys.hull.max > 0
        ? Math.round(((sys.hull.max - sys.hull.value) / sys.hull.max) * 100)
        : 100;

      const components = this.actor.items.filter(i => i.type === `${MODULE_ID}.component`);
      const weaponComponents = components.filter(c => c.system.slot === "weapon");
      const gunnerCtx = _buildNpcGunnerContext(sys);

      const weaponSections = WEAPON_SECTIONS.map(def => {
        const sectionItems = weaponComponents.filter(item => {
          const pos = item.system?.weaponPosition ?? "prow";
          return pos === "flank" ? (item.system?.weaponBay ?? "port") === def.id : pos === def.id;
        });
        const slotCount = Math.max(0, Number(sys.weaponSlots?.[def.id] ?? 0));
        return {
          ...def,
          labelLocalized: game.i18n.localize(def.label),
          slotCount,
          emptySlots: Math.max(0, slotCount - sectionItems.length),
          items: sectionItems.map(item => enrichWeaponForGunner(item, gunnerCtx)),
        };
      });

      const ammoTracks = ["a", "b", "c"].map(k => ({
        key: k,
        ...(sys.ammoTracks?.[k] ?? { label: "", value: 0, max: 10 }),
        pct: (sys.ammoTracks?.[k]?.max ?? 10) > 0
          ? Math.round(((sys.ammoTracks?.[k]?.value ?? 0) / (sys.ammoTracks?.[k]?.max ?? 10)) * 100)
          : 0,
      }));

      const allEffects = Array.from(this.actor.effects ?? []);
      const effects = {
        temporary: allEffects.filter(e => !e.disabled && e.isTemporary),
        passive:   allEffects.filter(e => !e.disabled && !e.isTemporary),
        disabled:  allEffects.filter(e => e.disabled),
      };

      const npcShipToken = this.actor.getActiveTokens()?.[0];
      const helm = buildHelmContext(sys, {
        velocityBearingMode: this._velocityBearingMode ?? "relative",
        shipRotation: npcShipToken?.document?.rotation ?? 0,
      });
      helm.hasRamTargets = (() => {
        if (!canvas?.ready) return false;
        const token = this.actor.getActiveTokens()?.[0];
        if (!token) return false;
        const isRealistic  = game.settings.get(MODULE_ID, "movementMode") === "realistic";
        const fuelBurned   = sys.resources?.pilot?.fuelBurned ?? 0;
        const baseSpeed    = sys.movement?.speed ?? 6;
        const allocSpeed   = sys.resources?.pilot?.allocSpeed ?? 0;
        const effSpeed     = Math.max(0, baseSpeed + allocSpeed);
        const overdrive    = sys.resources?.pilot?.overdrive ?? false;
        const apBonus      = sys.resources?.pilot?.apThrustBonus ?? 0;
        const powerMax     = (overdrive ? 200 : 100) + apBonus;
        const powerRemaining = Math.max(0, powerMax - fuelBurned);
        const baseMano     = sys.movement?.maneuverability ?? 2;
        const allocMano    = sys.resources?.pilot?.allocMano ?? 0;
        const maxBearingDeg = Math.max(0, baseMano + allocMano) * 15;
        const vx = isRealistic ? (sys.resources?.pilot?.velocityX ?? 0) : 0;
        const vy = isRealistic ? (sys.resources?.pilot?.velocityY ?? 0) : 0;
        const prevTurnMove = sys.resources?.pilot?.prevTurnMove ?? 0;
        const minMove      = Math.ceil(prevTurnMove / 2);
        const minMovePx    = (!isRealistic && fuelBurned === 0) ? minMove : 0;
        const shipBasis    = HelmPreview._tokenBasis(token);
        const gridSize     = canvas.grid.size;
        return canvas.tokens.placeables.some(t => {
          if (t === token || t.document.hidden || !t.document.actor) return false;
          const tW = t.document.width  * gridSize;
          const tH = t.document.height * gridSize;
          const tx = t.document.x + tW / 2;
          const ty = t.document.y + tH / 2;
          const reach = isRealistic
            ? HelmPreview.canReachRealistic(shipBasis, tx, ty, effSpeed, maxBearingDeg, powerRemaining, powerMax, vx, vy, 0)
            : HelmPreview.canReach(shipBasis, tx, ty, effSpeed, maxBearingDeg, powerRemaining, powerMax, minMovePx);
          if (!reach) return false;
          const cx = token.document.x + token.document.width  * gridSize / 2;
          const cy = token.document.y + token.document.height * gridSize / 2;
          const dist = Math.hypot((tx - cx) / gridSize, (ty - cy) / gridSize);
          return ShipCombatState.getEffectiveLockTier(t.id, dist) >= 1;
        });
      })();

      Object.assign(context, {
        sys,
        shields,
        hullPct,
        weaponSections,
        ammoTracks,
        effects,
        helm,
        gunnerCtx,
        sectors: SECTORS.map(s => ({
          id: s,
          abbr:        SECTOR_ABBR[s] ?? s.toUpperCase(),
          label: game.i18n.localize(`SHIPCOMBAT.Sector.${s[0].toUpperCase() + s.slice(1)}`),
          shield:      sys.shields?.[s] ?? 0,
          shieldMax:   sys.shieldMax?.[s] ?? 0,
          armour:      sys.armour?.[s] ?? 0,
          armourBase:  sys.armourBase?.[s] ?? 0,
        })),
        conditionsList: CRIT_LOCATIONS.map(loc => {
          const cond = sys.conditions?.[loc.id] ?? {};
          const tier = cond.tier ?? null;
          return {
            locId:          loc.id,
            tier,
            hasCondition:   !!tier,
            locLabel:       game.i18n.localize(`SHIPCOMBAT.Crit.Location.${loc.id}`),
            conditionName:  tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Condition.${loc.id}.${tier}`) : "",
            conditionEffect: tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Effect.${loc.id}.${tier}`) : "",
            tierLabel:      tier ? game.i18n.localize(`SHIPCOMBAT.Crit.Tier.${tier.charAt(0).toUpperCase() + tier.slice(1)}`) : "",
            tierClass:     tier ? `shipcombat-crit-tier--${tier}` : "",
          };
        }),
        hasAnyCondition: CRIT_LOCATIONS.some(loc => !!(sys.conditions?.[loc.id]?.tier)),
        shipClassifications: SHIP_CLASSIFICATIONS,
        useStrikeCraft: true,
        ordnanceLaunchSides: (() => {
          const SIDE_LABELS = {
            bow: game.i18n.localize("SHIPCOMBAT.Sector.Bow"),
            port: game.i18n.localize("SHIPCOMBAT.Sector.Port"),
            starboard: game.i18n.localize("SHIPCOMBAT.Sector.Starboard"),
            stern: game.i18n.localize("SHIPCOMBAT.Sector.Stern"),
          };
          const SIDE_ICONS = { bow: "fa-arrow-up", port: "fa-arrow-left", starboard: "fa-arrow-right", stern: "fa-arrow-down" };
          const toArr = src => Object.entries(SIDE_LABELS).map(([key, label]) => ({
            key, label, icon: SIDE_ICONS[key], value: src?.[key] ?? true,
          }));
          return {
            torpedo:    toArr(sys.ordnanceLaunchSides?.torpedo),
            strikeCraft: toArr(sys.ordnanceLaunchSides?.strikeCraft),
          };
        })(),
      });

      if (partId === "ordnance") {
        const shipToken = canvas?.scene?.tokens?.find(t => t.actor?.id === this.actor.id);
        const parentShipTokenId = shipToken?.id ?? null;
        const allTokens = parentShipTokenId ? [...(canvas.scene.tokens ?? [])] : [];
        const deployedTorpedoes = allTokens.filter(t =>
          isTorpedo(t.actor) &&
          t.actor?.system?.parentShipTokenId === parentShipTokenId,
        );
        const deployedCraft = allTokens.filter(t =>
          isStrikeCraft(t.actor) &&
          t.actor?.system?.parentShipTokenId === parentShipTokenId,
        );
        Object.assign(context, {
          torpedoTemplates: (sys.ordnanceActors?.torpedo ?? []).map(t => ({
            ...t,
            torpedoCount: t.actorData?.system?.hull?.max ?? 1,
          })),
          craftTemplates:   (sys.ordnanceActors?.strikeCraft ?? []).map(t => ({
            ...t,
            squadronSize:  t.actorData?.system?.hull?.max ?? 1,
          })),
          deployedTorpedoes: deployedTorpedoes.map(t => ({
            tokenId:      t.id, name: t.name, img: t.actor?.img,
            turnComplete: t.actor?.system?.turnComplete ?? false,
            hull:         t.actor?.system?.hull ?? { value: 1, max: 1 },
          })),
          deployedCraft: deployedCraft.map(t => ({
            tokenId:      t.id, name: t.name, img: t.actor?.img,
            turnComplete: t.actor?.system?.turnComplete ?? false,
            rtb:          t.actor?.system?.rtb ?? false,
            hull:         t.actor?.system?.hull ?? { value: 0, max: 0 },
          })),
          deployedCount: deployedTorpedoes.length + deployedCraft.length,
        });
      }

      return context;
    }

    _onRender(context, options) {
      super._onRender?.(context, options);

      _npcHelmOnRender(this);

      this.element.querySelectorAll("[data-launch-side][data-launch-dir]").forEach(cb => {
        cb.addEventListener("change", async ev => {
          const side = ev.currentTarget.dataset.launchSide;
          const dir  = ev.currentTarget.dataset.launchDir;
          await this.actor.update({
            [`system.ordnanceLaunchSides.${side}.${dir}`]: ev.currentTarget.checked,
          });
        });
      });

      this.element.querySelectorAll(".shipcombat-arc-val[data-sector]").forEach(el => {
        el.addEventListener("click", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          _adjustShieldSector(this, el.dataset.sector, 1);
        });
        el.addEventListener("contextmenu", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          _adjustShieldSector(this, el.dataset.sector, -1);
        });
        el.addEventListener("wheel", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          _adjustShieldSector(this, el.dataset.sector, ev.deltaY < 0 ? 1 : -1);
        }, { passive: false });
      });

      this.element.querySelectorAll("[data-weapon-arc]").forEach(row => {
        row.addEventListener("mouseenter", () => WeaponArcOverlay.showHover(row.dataset.weaponArc));
        row.addEventListener("mouseleave", () => WeaponArcOverlay.hideHover());
      });
      this.element.querySelectorAll("[data-pin-weapon]").forEach(btn => {
        btn.addEventListener("click", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          const pinned = WeaponArcOverlay.togglePin(btn.dataset.pinWeapon);
          btn.classList.toggle("shipcombat-pin-active", pinned);
        });
        if (WeaponArcOverlay.isPinned(btn.dataset.pinWeapon)) {
          btn.classList.add("shipcombat-pin-active");
        }
      });

      this.element.querySelectorAll(".shipcombat-macro-tier-picker").forEach(picker => {
        const card      = picker.closest(".shipcombat-battery-card");
        const fireBtn   = card?.querySelector(".shipcombat-fire--macro");
        const ammoVal   = card?.querySelector("[data-macro-stat-display='ammo'] .shipcombat-battery-stat-value");
        const hitVal    = card?.querySelector("[data-macro-stat-display='hit'] .shipcombat-battery-stat-value");
        const salvoVal  = card?.querySelector("[data-macro-stat-display='salvo'] .shipcombat-battery-stat-value");
        const fireLabel = fireBtn?.querySelector(".shipcombat-macro-fire-label");
        const pips      = [...picker.querySelectorAll(".shipcombat-macro-tier-pip")];

        function selectTier(pip) {
          pips.forEach(p => p.classList.remove("shipcombat-macro-pip-selected"));
          pip.classList.add("shipcombat-macro-pip-selected");
          const hit = parseInt(pip.dataset.tierHit) || 0;
          const hitStr = hit > 0 ? `+${hit}` : hit < 0 ? String(hit) : " - ";
          if (ammoVal)  ammoVal.textContent  = pip.dataset.tierAmmo;
          if (hitVal)   hitVal.textContent   = hitStr;
          if (salvoVal) salvoVal.textContent = pip.dataset.tierSalvo;
          if (fireBtn) {
            fireBtn.dataset.fireMode    = pip.dataset.tierId;
            fireBtn.dataset.weaponId    = card.dataset.id;
            fireBtn.disabled            = pip.dataset.canAfford !== "true";
            if (fireLabel) fireLabel.textContent = pip.querySelector(".shipcombat-macro-pip-label")?.textContent?.trim() ?? "";
          }
        }

        pips.forEach(pip => {
          pip.addEventListener("click", () => {
            if (pip.dataset.canAfford !== "true") return;
            selectTier(pip);
          });
        });

        const firstAffordable = pips.find(p => p.dataset.canAfford === "true");
        if (firstAffordable) selectTier(firstAffordable);
      });

      WeaponArcOverlay.activate(this.actor);

      this.element.querySelectorAll(".shipcombat-craft-stat-input").forEach(input => {
        input.addEventListener("change", async () => {
          const tokenId = input.dataset.craftTokenId;
          const field   = input.dataset.field;
          const value   = parseInt(input.value) || 0;
          const tokenDoc = canvas.scene?.tokens.get(tokenId);
          if (!tokenDoc?.actor) return;
          await tokenDoc.actor.update({ [field]: value });
        });
      });

      this.element.querySelectorAll("[data-action='npcRTB']").forEach(btn => {
        btn.addEventListener("mouseenter", () => {
          const shipToken = this.actor.getActiveTokens()?.[0];
          if (!shipToken || !canvas.stage) return;
          const gs = canvas.grid.size;
          const cx = shipToken.center?.x ?? (shipToken.x + gs / 2);
          const cy = shipToken.center?.y ?? (shipToken.y + gs / 2);
          if (this._rtbRangeGfx) this._rtbRangeGfx.destroy();
          const g = new PIXI.Graphics();
          g.beginFill(0x00ff88, 0.04);
          g.lineStyle(2, 0x00ff88, 0.5);
          g.drawCircle(cx, cy, 3 * gs);
          g.endFill();
          canvas.stage.addChild(g);
          this._rtbRangeGfx = g;
        });
        btn.addEventListener("mouseleave", () => {
          if (this._rtbRangeGfx) {
            this._rtbRangeGfx.destroy();
            this._rtbRangeGfx = null;
          }
        });
      });
    }

    _updateHelmPreview() {
      helmUpdatePreview(this);
    }

    changeTab(tab, group, options = {}) {
      super.changeTab(tab, group, options);
    }

    async _onDropItem(data, event) {
      const dropZone = event?.target?.closest?.("[data-component-slot]");
      const item = await Item.fromDropData(data);
      if (!item) return;

      if (item.type !== `${MODULE_ID}.component`) {
        return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.OnlyComponents"));
      }

      const targetSlot     = dropZone?.dataset.componentSlot;
      const targetPosition = dropZone?.dataset.componentPosition;

      // Guard: weapon components may only be dropped into the matching position
      // slot. Exception: "flank" weapons may go into port or starboard.
      if (targetSlot === "weapon" && targetPosition) {
        const itemPos = item.system?.weaponPosition ?? "prow";
        const isFlank = itemPos === "flank";
        const positionValid = isFlank
          ? (targetPosition === "port" || targetPosition === "starboard")
          : itemPos === targetPosition;
        if (!positionValid) {
          return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.WrongWeaponSlot"));
        }
      }

      const sameItem = this.actor.items.get(item.id);
      if (sameItem) {
        if (targetSlot) {
          const update = { "system.slot": targetSlot };
          if (targetSlot === "weapon" && targetPosition) {
            if (targetPosition === "port" || targetPosition === "starboard") {
              update["system.weaponPosition"] = "flank";
              update["system.weaponBay"]      = targetPosition;
            } else {
              update["system.weaponPosition"] = targetPosition;
            }
          }
          await sameItem.update(update);
        }
        return;
      }

      const createData = item.toObject();
      delete createData._id;
      if (targetSlot) {
        createData.system.slot = targetSlot;
        if (targetSlot === "weapon" && targetPosition) {
          if (targetPosition === "port" || targetPosition === "starboard") {
            createData.system.weaponPosition = "flank";
            createData.system.weaponBay      = targetPosition;
          } else {
            createData.system.weaponPosition = targetPosition;
          }
        }
      }
      await this.actor.createEmbeddedDocuments("Item", [createData]);
    }

    async _onDropActor(data, event) {
      const dropZone = event?.target?.closest?.("[data-ordnance-drop]");
      if (!dropZone) return;
      const slotType = dropZone.dataset.ordnanceSlot;
      if (!slotType) return;
      const actor = await Actor.fromDropData(data);
      if (!actor) return;
      const expectedType = slotType === "strikeCraft" ? `${MODULE_ID}.strikeCraft` : `${MODULE_ID}.torpedo`;
      const isValidDrop = actor.type === expectedType
        || (actor.type === `${MODULE_ID}.shipOrdnance` && actor.system?.subtype === slotType);
      if (!isValidDrop) {
        return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.WrongOrdnanceType"));
      }
      const actorData = actor.toObject();
      const ref = {
        id: foundry.utils.randomID(),
        uuid: actor.uuid,
        name: actor.name,
        img: actor.img,
        actorData,
      };
      const existing = this.actor.system.ordnanceActors?.[slotType] ?? [];
      await this.actor.update({ [`system.ordnanceActors.${slotType}`]: [...existing, ref] });
    }

    close(options) {
      HelmPreview.hide();
      WeaponArcOverlay.deactivate();
      return super.close(options);
    }
  }

  return NpcShipSheetBase;
};

// ══════════════════════════════════════════════════════════════════════════════
// NPC gunner context
// ══════════════════════════════════════════════════════════════════════════════

const AMMO_MAX   = 20;
const POWER_MAX  = 20;
const HEAT_MAX   = 10;

function _buildNpcGunnerContext(sys) {
  const ammo     = sys.resources?.gunner?.ammo ?? 0;
  const power    = sys.resources?.gunner?.power ?? 0;
  const heat     = sys.heat ?? 0;
  const ammoMax  = sys.resources?.gunner?.ammoMax  ?? AMMO_MAX;
  const powerMax = sys.resources?.gunner?.powerMax ?? POWER_MAX;
  const heatMax  = sys.heatMax ?? HEAT_MAX;

  const ordnanceSL       = sys.resources?.gunner?.ordnanceSL ?? 0;
  const allocAccuracy    = sys.resources?.gunner?.allocAccuracy ?? 0;
  const allocPenetration = sys.resources?.gunner?.allocPenetration ?? 0;
  const allocFirepower   = sys.resources?.gunner?.allocFirepower ?? 0;
  const ordnanceRolled   = sys.resources?.gunner?.ordnanceRolled ?? false;
  const slLocked         = sys.resources?.gunner?.slLocked ?? false;
  const remainingSL      = ordnanceSL - allocAccuracy - allocPenetration - allocFirepower;

  return {
    ammo,
    ammoMax,
    ammoPct:    ammoMax > 0 ? Math.min(100, Math.round((ammo  / ammoMax)  * 100)) : 0,
    power,
    powerMax,
    powerPct:   powerMax > 0 ? Math.min(100, Math.round((power / powerMax) * 100)) : 0,
    heat,
    heatMax,
    heatPct:    heatMax > 0 ? Math.round((heat / heatMax) * 100) : 0,
    heatColor:  heatColor(heatMax > 0 ? Math.round((heat / heatMax) * 100) : 0),
    hasCoreAssigned: false,
    isCoreSpent:     false,
    canConsumeCore:  false,
    ordnanceSL,
    ordnanceRolled,
    allocAccuracy,
    allocPenetration,
    allocFirepower,
    slLocked,
    remainingSL,
    allocLocked:  slLocked || !ordnanceRolled,
    slLabel:   game.i18n.localize("SHIPCOMBAT.Gunner.OrdnanceSL"),
    rollLabel: game.i18n.localize("SHIPCOMBAT.Gunner.RollOrdnance"),
    slTooltip: game.i18n.localize("SHIPCOMBAT.Gunner.OrdnanceSLTooltip"),
    blindedSectionId: sys.conditions?.weaponsSensors?.blindedSectionId ?? null,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// NPC Helm wiring
// ══════════════════════════════════════════════════════════════════════════════

function _npcHelmOnRender(sheet) {
  const sys          = sheet.actor.system;
  const fuelBurned   = sys.resources?.pilot?.fuelBurned ?? 0;
  const currentRound = sys.round ?? 0;
  const helmResetId  = sys.resources?.pilot?.helmResetId ?? 0;
  const overdrive    = sys.resources?.pilot?.overdrive ?? false;
  const powerMax     = overdrive ? 200 : 100;

  const isRealistic   = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
  const baseMano      = sys.movement?.maneuverability ?? 2;
  const allocMano     = sys.resources?.pilot?.allocMano ?? 0;
  const effMano       = Math.max(0, baseMano + allocMano);
  const bearingMax    = effMano * 15;
  const bearingUsed   = sys.resources?.pilot?.bearingUsed  ?? 0;
  const momentumUsed  = sys.resources?.pilot?.momentumUsed ?? 0;
  const bearingRemain = Math.max(0, bearingMax - bearingUsed);
  const velocityMag   = isRealistic ? Math.floor(Math.hypot(
    sys.resources?.pilot?.velocityX ?? 0,
    sys.resources?.pilot?.velocityY ?? 0)) : 0;
  const momentumFloor = (isRealistic && velocityMag === 0) ? 100 : momentumUsed;

  if (!sheet._helmState
      || sheet._helmState.round !== currentRound
      || sheet._helmState.helmResetId !== helmResetId) {
    sheet._helmState = {
      round:      currentRound,
      helmResetId,
      bearing:    sys.resources?.pilot?.bearing ?? 0,
      fuelSlider: fuelBurned,
      carryPct:   momentumFloor,
    };
  } else {
    sheet._helmState.bearing = sys.resources?.pilot?.bearing ?? 0;
    if (sheet._helmState.fuelSlider < fuelBurned) sheet._helmState.fuelSlider = fuelBurned;
    if (sheet._helmState.fuelSlider > powerMax)   sheet._helmState.fuelSlider = powerMax;
    const momentumFloorElse = (isRealistic && velocityMag === 0) ? 100 : momentumUsed;
    if ((sheet._helmState.carryPct ?? 0) < momentumFloorElse) sheet._helmState.carryPct = momentumFloorElse;
  }

  const powerBarEl       = sheet.element.querySelector("[data-helm-power-bar]");
  const powerInput       = sheet.element.querySelector("[data-helm-fuel]");
  const bearingSlider    = sheet.element.querySelector("[data-helm-bearing]");
  const bearingDisp      = sheet.element.querySelector("[data-bearing-display]");
  const fuelDisp         = sheet.element.querySelector("[data-fuel-display]");
  const bearingBudgetBar = sheet.element.querySelector("[data-bearing-budget-bar]");
  const carryInput       = sheet.element.querySelector("[data-helm-carry]");
  const carryDisp        = sheet.element.querySelector("[data-carry-display]");
  const carryBarEl       = sheet.element.querySelector("[data-helm-carry-bar]");

  const _syncBearingBudgetBar = (bearingAbs) => {
    if (!bearingBudgetBar || !bearingMax) return;
    const committed = (bearingUsed / bearingMax) * 100;
    const extra     = (Math.min(bearingAbs, bearingRemain) / bearingMax) * 100;
    bearingBudgetBar.style.setProperty("--committed", `${committed}%`);
    bearingBudgetBar.style.setProperty("--extra",     `${extra}%`);
    bearingBudgetBar.style.setProperty("--minmove",   "0%");
    const bearingBudgetDisp = sheet.element.querySelector("[data-bearing-budget-display]");
    if (bearingBudgetDisp) {
      bearingBudgetDisp.textContent = `${Math.round(bearingUsed + Math.min(bearingAbs, bearingRemain))}°`;
    }
  };
  _syncBearingBudgetBar(Math.abs(sheet._helmState.bearing));

  if (bearingSlider) {
    if (isRealistic) {
      const sliderMax = Math.min(bearingRemain, 180);
      bearingSlider.min = String(-sliderMax);
      bearingSlider.max = String(sliderMax);
      const clampedBearing = Math.max(-sliderMax, Math.min(sliderMax, sheet._helmState.bearing));
      if (clampedBearing !== sheet._helmState.bearing) sheet._helmState.bearing = clampedBearing;
      const minLbl = sheet.element.querySelector("[data-bearing-min-label]");
      const maxLbl = sheet.element.querySelector("[data-bearing-max-label]");
      if (minLbl) minLbl.textContent = `\u2212${sliderMax}\u00b0`;
      if (maxLbl) maxLbl.textContent = `${sliderMax}\u00b0`;
    }
    bearingSlider.value = String(sheet._helmState.bearing);
    if (bearingDisp) bearingDisp.textContent = `${sheet._helmState.bearing}°`;
  }

  const minMovePct = parseInt(powerBarEl?.dataset?.minmovePct ?? "0") || 0;

  if (powerInput) {
    powerInput.max   = String(powerMax);
    powerInput.value = String(sheet._helmState.fuelSlider);
  }

  const _syncPowerBar = (selectedPct) => {
    const ratio     = 100 / powerMax;
    const committed = fuelBurned * ratio;
    const extra     = Math.max(0, selectedPct - fuelBurned) * ratio;
    if (powerBarEl) {
      const effectiveMinmove = (selectedPct * ratio) >= minMovePct ? 0 : minMovePct;
      powerBarEl.style.setProperty("--committed", `${committed}%`);
      powerBarEl.style.setProperty("--extra",     `${extra}%`);
      powerBarEl.style.setProperty("--minmove",   `${effectiveMinmove}%`);
      const line = powerBarEl.querySelector(".shipcombat-power-minmove-line");
      if (line) line.style.display = effectiveMinmove > 0 ? "" : "none";
    }
    if (fuelDisp) fuelDisp.textContent = `${selectedPct}%`;
  };

  _syncPowerBar(sheet._helmState.fuelSlider);

  if (powerInput) {
    powerInput.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
    powerInput.addEventListener("input", ev => {
      ev.stopPropagation();
      let val = Math.max(fuelBurned, Math.min(powerMax, Number(ev.target.value)));
      if (val !== Number(ev.target.value)) ev.target.value = String(val);
      sheet._helmState.fuelSlider = val;
      _syncPowerBar(val);
      sheet._updateHelmPreview();
    }, true);
  }

  if (bearingSlider) {
    bearingSlider.addEventListener("change", ev => ev.stopPropagation());
    bearingSlider.addEventListener("input", ev => {
      let val = Number(ev.target.value);
      if (isRealistic && bearingMax > 0) {
        if (Math.abs(val) > bearingRemain) {
          val = Math.sign(val || 1) * bearingRemain;
          ev.target.value = String(val);
        }
      }
      sheet._helmState.bearing = val;
      if (bearingDisp) bearingDisp.textContent = `${val}°`;
      _syncBearingBudgetBar(Math.abs(val));
      sheet._updateHelmPreview();
      clearTimeout(sheet._bearingDebounce);
      sheet._bearingDebounce = setTimeout(() => {
        sheet.actor.update({ "system.resources.pilot.bearing": val });
      }, 300);
    });
  }

  const _syncCarryBar = (carryPct) => {
    if (!carryBarEl) return;
    const committed = momentumUsed;
    const extra     = Math.max(0, carryPct - momentumUsed);
    carryBarEl.style.setProperty("--committed", `${committed}%`);
    carryBarEl.style.setProperty("--extra",     `${extra}%`);
    carryBarEl.style.setProperty("--minmove",   "0%");
    if (carryDisp) carryDisp.textContent = `${Math.round(carryPct)}%`;
  };

  if (carryInput) {
    carryInput.value = String(sheet._helmState.carryPct ?? momentumFloor);
    carryInput.addEventListener("change", ev => { ev.stopPropagation(); ev.preventDefault(); }, true);
    carryInput.addEventListener("input", ev => {
      ev.stopPropagation();
      const val = Math.max(momentumFloor, Math.min(100, Number(ev.target.value)));
      if (val !== Number(ev.target.value)) ev.target.value = String(val);
      sheet._helmState.carryPct = val;
      _syncCarryBar(val);
      sheet._updateHelmPreview();
    }, true);
  }
  _syncCarryBar(sheet._helmState.carryPct ?? momentumFloor);

  if (!sheet._velocityBearingMode) sheet._velocityBearingMode = "relative";
  const velBearingToggle = sheet.element.querySelector("[data-vel-bearing-toggle]");
  if (velBearingToggle) {
    velBearingToggle.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      sheet._velocityBearingMode = sheet._velocityBearingMode === "relative" ? "true" : "relative";
      sheet.render();
    });
  }

  sheet._updateHelmPreview();
}

// ══════════════════════════════════════════════════════════════════════════════
// Action handlers (standalone functions — assigned into DEFAULT_OPTIONS.actions)
// ══════════════════════════════════════════════════════════════════════════════

async function _onNpcRollPiloting() {
  const sys     = this.actor.system;
  const adapter = SystemAdapter.current;
  const target  = sys.attributes?.piloting ?? 40;
  const roll    = await new Roll(adapter.getRollFormula()).evaluate();
  const sl      = adapter.computeSuccessLevel(roll, target);
  const msg = await roll.toMessage({
    flavor: `${game.i18n.localize("SHIPCOMBAT.Helm.RollPiloting")} (${target})`,
  });
  await this.actor.update({
    "system.resources.pilot.pilotingSL": Math.max(0, sl),
    "system.resources.pilot.pilotingMessageId": msg.id,
  });
}

async function _onNpcRollInitiative() {
  const sys     = this.actor.system;
  const adapter = SystemAdapter.current;
  const piloting = sys.attributes?.piloting ?? 40;
  const { total, roll } = await adapter.rollShipInitiativeFromAttribute(
    piloting,
    game.i18n.localize("SHIPCOMBAT.NpcShip.RollInitiative"),
    { speaker: ChatMessage.getSpeaker({ actor: this.actor }) },
  );
  if (!game.combat) return;
  const token = this.actor.getActiveTokens()?.[0];
  const combatant = token
    ? game.combat.combatants.find(c => c.tokenId === token.id)
    : game.combat.combatants.find(c => c.actor?.id === this.actor.id);
  if (combatant) {
    await combatant.update({ initiative: adapter.toCombatantInitiative(total, this.actor) });
  }
}

function _onNpcAllocBonus(event, target) {
  const stat  = target.dataset.stat;
  const delta = parseInt(target.dataset.delta) || 0;
  const sys   = this.actor.system;
  const pilot = sys.resources?.pilot ?? {};
  const pilotingSL   = pilot.pilotingSL   ?? 0;
  const allocSpeed   = pilot.allocSpeed   ?? 0;
  const allocMano    = pilot.allocMano    ?? 0;
  const allocEvasion = pilot.allocEvasion ?? 0;
  if (delta > 0 && pilot.pilotingMessageId) {
    const totalAlloc = allocSpeed + allocMano + allocEvasion;
    if (totalAlloc >= pilotingSL) return;
  }
  if (stat === "speed") {
    this.actor.update({ "system.resources.pilot.allocSpeed":   Math.max(0, allocSpeed + delta) });
  } else if (stat === "mano") {
    this.actor.update({ "system.resources.pilot.allocMano":    Math.max(0, allocMano + delta) });
  } else if (stat === "evasion") {
    this.actor.update({ "system.resources.pilot.allocEvasion": Math.max(0, allocEvasion + delta) });
  }
}

async function _onNpcConfirmHelm() {
  const sys        = this.actor.system;
  const fuelBurned = sys.resources?.pilot?.fuelBurned ?? 0;
  const fuelSlider = this._helmState?.fuelSlider ?? fuelBurned;
  const bearing    = this._helmState?.bearing ?? 0;
  const speed      = (sys.movement?.speed ?? 0) + (sys.resources?.pilot?.allocSpeed ?? 0);
  const isRealistic = game.settings.get(MODULE_ID, "movementMode") === "realistic";

  if (isRealistic) {
    const vx = sys.resources?.pilot?.velocityX ?? 0;
    const vy = sys.resources?.pilot?.velocityY ?? 0;
    const thrustPct = fuelSlider - fuelBurned;
    const carryPct  = this._helmState?.carryPct ?? 0;
    const velMag = Math.hypot(vx, vy);
    if (thrustPct <= 0 && velMag === 0 && bearing === 0) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Helm.WarnNoFuel"));
    }
    const token = this.actor.getActiveTokens()?.[0];
    if (token && canvas?.ready) {
      const projected = HelmPreview.projectPositionRealistic(token, bearing, thrustPct, speed, vx, vy, carryPct);
      if (projected) {
        const waypoints = HelmPreview.projectWaypointsRealistic(token, bearing, thrustPct, speed, vx, vy, carryPct);
        if (waypoints?.length > 1) {
          await _animateTokenPath(token, waypoints, projected);
        } else {
          await token.document.update(
            { x: projected.x, y: projected.y, rotation: projected.rotation },
            { animate: true },
          );
        }
      }
    }
    const h0 = ((token?.document?.rotation ?? 0) - 90) * (Math.PI / 180);
    const thrustDir = h0 + bearing * (Math.PI / 180);
    const thrustMag = (thrustPct / 100) * speed;
    const newVx = vx + Math.cos(thrustDir) * thrustMag;
    const newVy = vy + Math.sin(thrustDir) * thrustMag;
    const totalMoved = Math.round(Math.hypot(newVx, newVy));
    await this.actor.update({
      "system.resources.pilot.fuelBurned":   fuelSlider,
      "system.resources.pilot.prevTurnMove": totalMoved,
      "system.resources.pilot.bearing":      bearing,
      "system.resources.pilot.velocityX":    newVx,
      "system.resources.pilot.velocityY":    newVy,
      "system.resources.pilot.bearingUsed":  (sys.resources?.pilot?.bearingUsed ?? 0) + Math.abs(bearing),
      "system.resources.pilot.momentumUsed": carryPct,
    });
    HelmPreview.hide();
    return;
  }

  if (fuelSlider <= fuelBurned) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Helm.WarnNoFuel"));
  }

  const prevTurnMove = sys.resources?.pilot?.prevTurnMove ?? 0;
  const minMove      = Math.ceil(prevTurnMove / 2);
  const isFirstCommit = fuelBurned === 0;
  const thrustPct     = fuelSlider - fuelBurned;
  const driftUnits    = isFirstCommit ? minMove : 0;

  const token = this.actor.getActiveTokens()?.[0];
  if (token && canvas?.ready) {
    const projected = HelmPreview.projectPosition(token, bearing, thrustPct, speed, driftUnits);
    if (projected) {
      const waypoints = HelmPreview.projectWaypoints(token, bearing, thrustPct, speed, driftUnits);
      if (waypoints?.length > 1) {
        await _animateTokenPath(token, waypoints, projected);
      } else {
        await token.document.update(
          { x: projected.x, y: projected.y, rotation: projected.rotation },
          { animate: true },
        );
      }
    }
  }

  const totalMoved = Math.round((fuelSlider / 100) * (speed + driftUnits));
  await this.actor.update({
    "system.resources.pilot.fuelBurned": fuelSlider,
    "system.resources.pilot.prevTurnMove": totalMoved,
    "system.resources.pilot.bearing": bearing,
  });

  HelmPreview.hide();
}

async function _onNpcRam() {
  const token = this.actor.getActiveTokens()?.[0];
  if (!token || !canvas?.ready) return;
  const sys = this.actor.system;
  const fuelBurned       = sys.resources?.pilot?.fuelBurned ?? 0;
  const prevTurnMove     = sys.resources?.pilot?.prevTurnMove ?? 0;
  const minMoveGridUnits = fuelBurned === 0 ? Math.ceil(prevTurnMove / 2) : 0;
  const baseSpeed   = sys.movement?.speed ?? 6;
  const allocSpeed  = sys.resources?.pilot?.allocSpeed ?? 0;
  const effSpeed    = Math.max(0, baseSpeed + allocSpeed);
  const powerMax    = 100;
  const powerRemaining = Math.max(0, powerMax - fuelBurned);
  const baseMano    = sys.movement?.maneuverability ?? 2;
  const allocMano   = sys.resources?.pilot?.allocMano ?? 0;
  const maxBearingDeg = Math.max(0, baseMano + allocMano) * 15;
  const shipBasis   = HelmPreview._tokenBasis(token);
  const popup = new RamTargetPopup({
    ship: this.actor,
    effSpeed, powerMax, powerRemaining,
    maxBearingDeg, minMoveGridUnits, fuelBurned, shipBasis,
  });
  popup.render(true);
}

async function _onNpcRollOrdnance() {
  const sys = this.actor.system;
  if (sys.resources?.gunner?.ordnanceRolled) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.AlreadyRolledOrdnance"));
  }
  const gunnery = sys.attributes?.gunnery ?? 40;
  const adapter = SystemAdapter.current;
  const roll    = await new Roll(adapter.getRollFormula()).evaluate();
  const sl      = Math.max(0, adapter.computeSuccessLevel(roll, gunnery));
  await roll.toMessage({
    flavor:  `${game.i18n.localize("SHIPCOMBAT.NpcShip.Gunnery")} (${gunnery})`,
    speaker: ChatMessage.getSpeaker({ actor: this.actor }),
  });
  await this.actor.update({
    "system.resources.gunner.ordnanceSL":       sl,
    "system.resources.gunner.ordnanceRolled":   true,
    "system.resources.gunner.allocAccuracy":    0,
    "system.resources.gunner.allocPenetration": 0,
    "system.resources.gunner.allocFirepower":   0,
    "system.resources.gunner.slLocked":         false,
  });
}

async function _onNpcAllocGunnerSL(event, target) {
  const sys    = this.actor.system;
  const gunner = sys.resources?.gunner ?? {};
  if (gunner.slLocked || !gunner.ordnanceRolled) return;
  const stat  = target.dataset.stat;
  const delta = Number(target.dataset.delta);
  const pool  = gunner.ordnanceSL ?? 0;
  const acc   = gunner.allocAccuracy ?? 0;
  const pen   = gunner.allocPenetration ?? 0;
  const fp    = gunner.allocFirepower ?? 0;
  let newAcc = acc, newPen = pen, newFp = fp;
  if (stat === "accuracy")    newAcc = Math.max(0, acc + delta);
  if (stat === "penetration") newPen = Math.max(0, pen + delta);
  if (stat === "firepower")   newFp  = Math.max(0, fp  + delta);
  if (newAcc + newPen + newFp > pool) return;
  const keyMap = { accuracy: "allocAccuracy", penetration: "allocPenetration", firepower: "allocFirepower" };
  await this.actor.update({ [`system.resources.gunner.${keyMap[stat]}`]: stat === "accuracy" ? newAcc : stat === "penetration" ? newPen : newFp });
}

async function _onNpcFireWeapon(event, target) {
  const weaponId = target.closest("[data-id]")?.dataset.id ?? target.dataset.weaponId;
  const fireMode = target.dataset.fireMode;
  if (!weaponId || !fireMode) return;
  const weapon = this.actor.items.get(weaponId);
  if (!weapon) return;
  const sys = this.actor.system;
  const weaponType = weapon.system.resourceType;
  if (weaponType === "ammo") {
    const tier = MACRO_FIRE_TIERS.find(t => t.id === fireMode);
    if (!tier) return;
    const ammo = sys.resources?.gunner?.ammo ?? 0;
    if (ammo < tier.ammo) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAmmo"));
    }
  } else if (weaponType === "heat") {
    if ((sys.heat ?? 0) >= (sys.heatMax ?? HEAT_MAX)) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.HeatMaxed"));
    }
  } else if (weaponType === "power") {
    if ((sys.resources?.gunner?.power ?? 0) <= 0) {
      return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.InsufficientAP"));
    }
  }
  const popup = new TargetingPopup({ weapon, fireMode });
  popup.render(true);
}

function _adjustShieldSector(sheet, sector, delta) {
  const sys = sheet.actor.system;
  const cur = sys.shields?.[sector] ?? 0;
  const newVal = Math.max(0, cur + delta);
  const actualDelta = newVal - cur;
  if (actualDelta === 0) return;
  const updates = {
    [`system.shields.${sector}`]: newVal,
    "system.voidshieldFluxRemaining": (sys.voidshieldFluxRemaining ?? 0) - actualDelta,
  };
  sheet.actor.update(updates);
}

async function _onNpcStepCondition(event, target) {
  const locId = target.dataset.locId;
  if (!locId) return;
  const cond     = this.actor.toObject()?.system?.conditions?.[locId] ?? {};
  const nextTier = cond.tier === "high" ? "medium"
    : cond.tier === "medium" ? "low"
    : null;
  await this.actor.update({
    [`system.conditions.${locId}`]: nextTier ? { ...cond, tier: nextTier } : { tier: null },
  });
}

function _onAdjustShield(event, target) {
  const sector = target.dataset.sector;
  const delta  = parseInt(target.dataset.delta) || 0;
  if (!sector || !delta) return;
  const sys = this.actor.system;
  const cur = sys.shields?.[sector] ?? 0;
  const newVal = Math.max(0, cur + delta);
  const actualDelta = newVal - cur;
  const updates = { [`system.shields.${sector}`]: newVal };
  if (actualDelta !== 0) {
    updates["system.voidshieldFluxRemaining"] = (sys.voidshieldFluxRemaining ?? 0) - actualDelta;
  }
  this.actor.update(updates);
}

async function _onSuppressFire() {
  const sys = this.actor.system;
  if (sys.engActionUsed) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.EngActionUsed"));
  if ((sys.internalFire ?? 0) <= 0) return;
  const target  = sys.attributes?.tech ?? 40;
  const adapter = SystemAdapter.current;
  const roll    = await new Roll(adapter.getRollFormula()).evaluate();
  const sl      = adapter.computeSuccessLevel(roll, target);
  const newFire = Math.max(0, (sys.internalFire ?? 0) - Math.max(0, 5 + sl));
  await roll.toMessage({ flavor: `${game.i18n.localize("SHIPCOMBAT.NpcShip.SuppressFire")} (${game.i18n.localize("SHIPCOMBAT.NpcShip.Tech")} ${target})` });
  await this.actor.update({ "system.internalFire": newFire, "system.engActionUsed": true });
}

async function _onReduceHeat() {
  const sys = this.actor.system;
  if (sys.engActionUsed) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.EngActionUsed"));
  if ((sys.heat ?? 0) <= 0) return;
  const target  = sys.attributes?.tech ?? 40;
  const adapter = SystemAdapter.current;
  const roll    = await new Roll(adapter.getRollFormula()).evaluate();
  const sl      = adapter.computeSuccessLevel(roll, target);
  const newHeat = Math.max(0, (sys.heat ?? 0) - Math.max(0, 5 + sl));
  await roll.toMessage({ flavor: `${game.i18n.localize("SHIPCOMBAT.NpcShip.ReduceHeat")} (${game.i18n.localize("SHIPCOMBAT.NpcShip.Tech")} ${target})` });
  await this.actor.update({ "system.heat": newHeat, "system.engActionUsed": true });
}

async function _onFullReset() {
  const sys = this.actor.system;
  const helmResetId = (sys.resources?.pilot?.helmResetId ?? 0) + 1;
  const isRealistic = game.settings?.get(MODULE_ID, "movementMode") === "realistic";
  const baseSpeed   = sys.movement?.baseSpeed ?? sys.movement?.speed ?? 6;
  const updates = {
    "system.active": false,
    "system.round": 0,
    "system.hull.value": 0,
    "system.internalFire": 0,
    "system.engActionUsed": false,
    "system.resources.pilot.pilotingSL": 0,
    "system.resources.pilot.allocSpeed": 0,
    "system.resources.pilot.allocMano": 0,
    "system.resources.pilot.allocEvasion": 0,
    "system.resources.pilot.fuelBurned": 0,
    "system.resources.pilot.bearing": 0,
    "system.resources.pilot.overdrive": false,
    "system.resources.pilot.helmResetId": helmResetId,
    "system.resources.pilot.pilotingMessageId": "",
    "system.resources.pilot.bearingUsed": 0,
    "system.resources.pilot.momentumUsed": 0,
    "system.resources.gunner.ammo": Math.round((sys.resources?.gunner?.ammoMax ?? 20) * 0.25),
    "system.resources.gunner.power": Math.round((sys.resources?.gunner?.powerMax ?? 20) * 0.5),
    "system.resources.gunner.ordnanceSL":       0,
    "system.resources.gunner.ordnanceRolled":   false,
    "system.resources.gunner.allocAccuracy":    0,
    "system.resources.gunner.allocPenetration": 0,
    "system.resources.gunner.allocFirepower":   0,
    "system.resources.gunner.slLocked":         false,
    "system.heat": 0,
  };
  if (isRealistic) {
    const token    = this.actor.getActiveTokens()?.[0];
    const rotation = token?.document?.rotation ?? 0;
    const θ = rotation * Math.PI / 180;
    updates["system.resources.pilot.velocityX"] = Math.sin(θ) * (baseSpeed / 2);
    updates["system.resources.pilot.velocityY"] = -Math.cos(θ) * (baseSpeed / 2);
  } else {
    updates["system.resources.pilot.prevTurnMove"] = baseSpeed;
  }
  for (const s of SECTORS) updates[`system.shields.${s}`] = sys.shieldMax?.[s] ?? 0;
  for (const s of SECTORS) updates[`system.armour.${s}`] = sys.armourBase?.[s] ?? 0;
  for (const s of SECTORS) updates[`system.armourRend.${s}`] = 0;
  for (const k of ["a", "b", "c"]) updates[`system.ammoTracks.${k}.value`] = sys.ammoTracks?.[k]?.max ?? 10;
  updates["system.voidshieldFluxRemaining"] = sys.voidshieldFlux ?? 0;
  const condClear = { tier: null, lockedRole: null, blindedSectionId: null };
  updates["system.conditions.hull"]           = { ...condClear };
  updates["system.conditions.engines"]        = { ...condClear };
  updates["system.conditions.manoeuvring"]    = { ...condClear };
  updates["system.conditions.coreSystems"]    = { ...condClear };
  updates["system.conditions.weaponsSensors"] = { ...condClear };
  await this.actor.update(updates);
  HelmPreview.hide();
  if (canvas?.scene) {
    const shipTokenId = this.actor.getActiveTokens?.()?.[0]?.id;
    const toDelete = canvas.scene.tokens
      .filter(td =>
        (isTorpedo(td.actor) || isStrikeCraft(td.actor)) &&
        (!shipTokenId || td.actor?.system?.parentShipTokenId === shipTokenId)
      )
      .map(td => td.id);
    if (toDelete.length > 0) {
      await canvas.scene.deleteEmbeddedDocuments("Token", toDelete);
    }
  }
}

function _onRefillShields() {
  const sys = this.actor.system;
  const updates = {};
  let totalAdded = 0;
  for (const s of SECTORS) {
    const cur = sys.shields?.[s] ?? 0;
    const max = sys.shieldMax?.[s] ?? 0;
    updates[`system.shields.${s}`] = max;
    totalAdded += Math.max(0, max - cur);
  }
  if (totalAdded > 0) {
    updates["system.voidshieldFluxRemaining"] = (sys.voidshieldFluxRemaining ?? 0) - totalAdded;
  }
  this.actor.update(updates);
}

function _onFluxToCharge() {
  const sys = this.actor.system;
  const flux = sys.voidshieldFluxRemaining ?? 0;
  if (flux <= 0) return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.NoFluxRemaining"));
  const power = sys.resources?.gunner?.power ?? 0;
  this.actor.update({
    "system.voidshieldFluxRemaining":   flux - 1,
    "system.resources.gunner.power":  power + 1,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Ordnance tab action handlers
// ══════════════════════════════════════════════════════════════════════════════

async function _promptNpcSide(allowedSides) {
  const ALL_SIDES = [
    { key: "port",      label: game.i18n.localize("SHIPCOMBAT.Sector.Port"),      icon: "fa-solid fa-arrow-left" },
    { key: "bow",       label: game.i18n.localize("SHIPCOMBAT.Sector.Bow"),        icon: "fa-solid fa-arrow-up" },
    { key: "starboard", label: game.i18n.localize("SHIPCOMBAT.Sector.Starboard"), icon: "fa-solid fa-arrow-right" },
    { key: "stern",     label: game.i18n.localize("SHIPCOMBAT.Sector.Stern"),      icon: "fa-solid fa-arrow-down" },
  ];
  let filtered;
  if (!allowedSides) {
    filtered = ALL_SIDES;
  } else {
    filtered = ALL_SIDES.filter(s => allowedSides[s.key] === true);
  }
  if (filtered.length === 0) {
    ui.notifications.error(game.i18n.localize("SHIPCOMBAT.Ordnance.NoLaunchSides"));
    return null;
  }
  if (filtered.length === 1) return filtered[0].key;
  return new Promise(resolve => {
    const d = new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize("SHIPCOMBAT.Ordnance.ChooseSide") },
      content: `<p>${game.i18n.localize("SHIPCOMBAT.Ordnance.ChooseSideDesc")}</p>`,
      buttons: filtered.map(s => ({ action: s.key, label: s.label, icon: s.icon })),
      close: () => resolve(null),
      submit: result => resolve(result),
    });
    d.render(true);
  });
}

function _npcComputePerpendicularSpawn(token, side) {
  if (!token) return { x: 0, y: 0, rotation: 0 };
  const grid = canvas.grid?.size ?? 100;
  const offset = grid * 1.5;
  const shipRotDeg = token.document?.rotation ?? 0;
  const headingRad = (shipRotDeg - 90) * (Math.PI / 180);
  const perpRad = side === "port" ? headingRad - Math.PI / 2 : headingRad + Math.PI / 2;
  const cx = token.center?.x ?? (token.x + grid / 2);
  const cy = token.center?.y ?? (token.y + grid / 2);
  return {
    x:        Math.round(cx + Math.cos(perpRad) * offset - grid / 2),
    y:        Math.round(cy + Math.sin(perpRad) * offset - grid / 2),
    rotation: shipRotDeg + (side === "port" ? -90 : 90),
  };
}

function _npcComputeBowSpawn(token) {
  if (!token) return { x: 0, y: 0, rotation: 0 };
  const grid = canvas.grid?.size ?? 100;
  const offset = grid * 1.5;
  const shipRotDeg = token.document?.rotation ?? 0;
  const headingRad = (shipRotDeg - 90) * (Math.PI / 180);
  const cx = token.center?.x ?? (token.x + grid / 2);
  const cy = token.center?.y ?? (token.y + grid / 2);
  return {
    x:        Math.round(cx + Math.cos(headingRad) * offset - grid * 0.25),
    y:        Math.round(cy + Math.sin(headingRad) * offset - grid * 0.25),
    rotation: shipRotDeg,
  };
}

function _npcComputeSternSpawn(token) {
  if (!token) return { x: 0, y: 0, rotation: 0 };
  const grid = canvas.grid?.size ?? 100;
  const offset = grid * 1.5;
  const shipRotDeg = token.document?.rotation ?? 0;
  const headingRad = (shipRotDeg - 90) * (Math.PI / 180);
  const sternRad = headingRad + Math.PI;
  const cx = token.center?.x ?? (token.x + grid / 2);
  const cy = token.center?.y ?? (token.y + grid / 2);
  return {
    x:        Math.round(cx + Math.cos(sternRad) * offset - grid / 2),
    y:        Math.round(cy + Math.sin(sternRad) * offset - grid / 2),
    rotation: (shipRotDeg + 180) % 360,
  };
}

async function _onNpcLaunchTorpedo()     { await _npcLaunchOrdnance.call(this, "torpedo"); }
async function _onNpcLaunchStrikeCraft() { await _npcLaunchOrdnance.call(this, "strikeCraft"); }

async function _onNpcPanToOrdnance(event, target) {
  const tokenId = target.dataset.tokenId;
  if (!tokenId || !canvas.scene) return;
  const token = canvas.tokens.get(tokenId);
  if (!token) return;
  canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
  token.actor?.sheet?.render(true);
}

async function _onNpcRTB() {
  if (!canvas.scene) return;
  const shipToken = this.actor.getActiveTokens()?.[0];
  if (!shipToken) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Warning.NoShipToken"));
    return;
  }
  const gs = canvas.grid.size;
  const shipCx = shipToken.center?.x ?? (shipToken.x + (shipToken.document.width  ?? 1) * gs / 2);
  const shipCy = shipToken.center?.y ?? (shipToken.y + (shipToken.document.height ?? 1) * gs / 2);
  const maxDist = 3 * gs;
  const nearbyCraft = [];
  for (const td of canvas.scene.tokens) {
    if (!isStrikeCraft(td.actor)) continue;
    if (td.actor?.system?.parentShipTokenId !== shipToken.id) continue;
    const cx = (td.x ?? 0) + (td.document?.width  ?? 1) * gs / 2;
    const cy = (td.y ?? 0) + (td.document?.height ?? 1) * gs / 2;
    const dist = Math.sqrt((shipCx - cx) ** 2 + (shipCy - cy) ** 2);
    if (dist > maxDist) continue;
    nearbyCraft.push({
      tokenId:  td.id,
      name:     td.name,
      img:      td.texture?.src ?? td.actor?.img ?? "",
      distance: Math.round((dist / gs) * 10) / 10,
      targetX:  cx,
      targetY:  cy,
    });
  }
  if (!nearbyCraft.length) {
    ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ordnance.NoCraftInRange"));
    return;
  }
  const shipPos = { x: shipCx, y: shipCy };
  const popup = new RecoverCraftPopup({ nearbyCraft, shipPos });
  const selectedTokenId = await popup.show();
  if (!selectedTokenId) return;
  const tokenDoc = canvas.scene.tokens.get(selectedTokenId);
  if (tokenDoc?.actor) {
    await tokenDoc.actor.setFlag(MODULE_ID, "recovering", true);
  }
  await canvas.scene.deleteEmbeddedDocuments("Token", [selectedTokenId]);
}

async function _npcLaunchOrdnance(type) {
  const slotKey   = type === "strikeCraft" ? "strikeCraft" : "torpedo";
  const templates = this.actor.system.ordnanceActors?.[slotKey] ?? [];
  const tmpl      = templates[0];
  if (this.actor.system.resources?.pilot?.prowGunLocked) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.Ram.BowLaunchLocked"));
  }
  if (!tmpl) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.NoTemplate"));
  }
  const shipToken = this.actor.getActiveTokens()?.[0];
  if (!shipToken) {
    return ui.notifications.warn(game.i18n.localize("SHIPCOMBAT.NpcShip.NoTokenFound"));
  }
  const parentShipTokenId = shipToken.id;
  const allowedSides = this.actor.system.ordnanceLaunchSides?.[type === "strikeCraft" ? "strikeCraft" : "torpedo"];
  const side = await _promptNpcSide(allowedSides);
  if (!side) return;
  const spawn = side === "bow" ? _npcComputeBowSpawn(shipToken)
    : side === "stern" ? _npcComputeSternSpawn(shipToken)
    : _npcComputePerpendicularSpawn(shipToken, side);
  const actorData = foundry.utils.deepClone(tmpl.actorData);
  delete actorData._id;
  foundry.utils.setProperty(actorData, `flags.${MODULE_ID}.fromOrdnanceMaster`, true);
  foundry.utils.setProperty(actorData, "system.parentShipTokenId", parentShipTokenId);
  if (actorData.system) actorData.system.turnComplete = (type === "torpedo");
  if (actorData.system?.hull) actorData.system.hull.value = 0;
  if (game.settings?.get(MODULE_ID, "movementMode") === "realistic") {
    const launchSys  = this.actor.system;
    const shipVx     = launchSys.resources?.pilot?.velocityX ?? 0;
    const shipVy     = launchSys.resources?.pilot?.velocityY ?? 0;
    const ownSpeed   = actorData.system?.movement?.speed ?? 0;
    const headingRad = (spawn.rotation - 90) * (Math.PI / 180);
    foundry.utils.setProperty(actorData, "system.helm.velocityX", shipVx + Math.cos(headingRad) * (ownSpeed / 2));
    foundry.utils.setProperty(actorData, "system.helm.velocityY", shipVy + Math.sin(headingRad) * (ownSpeed / 2));
  }
  const actor = await Actor.create(actorData);
  if (!actor) return;
  const tokenDoc = await actor.getTokenDocument({
    x:           spawn.x,
    y:           spawn.y,
    rotation:    spawn.rotation,
    hidden:      false,
    disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
    width:       0.5,
    height:      0.5,
  });
  await canvas.scene.createEmbeddedDocuments("Token", [tokenDoc.toObject()]);
  this.render();
}

async function _onNpcOpenOrdTemplate(event, target) {
  const row        = target.closest("[data-template-id]");
  const slotType   = row?.dataset?.ordnanceSlot;
  const templateId = row?.dataset?.templateId;
  if (!slotType || !templateId) return;
  const templates = this.actor.system.ordnanceActors?.[slotType] ?? [];
  const ref       = templates.find(e => e.id === templateId);
  if (!ref?.actorData) return;
  const editData = foundry.utils.deepClone(ref.actorData);
  delete editData._id;
  foundry.utils.setProperty(editData, `flags.${MODULE_ID}.embeddedEdit`, true);
  foundry.utils.setProperty(editData, `flags.${MODULE_ID}.fromOrdnanceMaster`, true);
  const editActor = await Actor.create(editData);
  if (!editActor) return;
  const sheet = editActor.sheet;
  sheet.render(true);
  const shipActor = this.actor;
  const origClose = sheet.close.bind(sheet);
  let _closing = false;
  sheet.close = async (options) => {
    if (_closing) return origClose(options);
    _closing = true;
    const updatedData = editActor.toObject();
    delete updatedData._id;
    const currentTemplates = shipActor.system.ordnanceActors?.[slotType] ?? [];
    const newTemplates = currentTemplates.map(e =>
      e.id === templateId
        ? { ...e, actorData: updatedData, name: updatedData.name, img: updatedData.img }
        : e,
    );
    await shipActor.update({ [`system.ordnanceActors.${slotType}`]: newTemplates });
    if (game.actors.has(editActor.id)) await editActor.delete();
    return origClose(options);
  };
}

async function _onNpcRemoveOrdTemplate(event, target) {
  const row        = target.closest("[data-template-id]");
  const slotType   = row?.dataset?.ordnanceSlot;
  const templateId = row?.dataset?.templateId;
  if (!slotType || !templateId) return;
  const existing = this.actor.system.ordnanceActors?.[slotType] ?? [];
  await this.actor.update({
    [`system.ordnanceActors.${slotType}`]: existing.filter(e => e.id !== templateId),
  });
}
