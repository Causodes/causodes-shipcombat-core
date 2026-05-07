/**
 * DeadReckoningPopup  -  reorder the top 12 draw pile cards via drag and drop.
 *
 * Replaces the old sequential DialogV2 loop with a single popup showing all
 * cards at once.  The player drags cards to set the draw order; position 1 is
 * drawn next.  On confirm the new pile order is emitted to the GM.
 */
import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { emitToGM }  from "../socket.js";

export class DeadReckoningPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  constructor({ cards = [], rest = [] } = {}) {
    super({});
    this._cards = [...cards]; // mutable working copy (top N cards)
    this._rest  = rest;       // cards below the preview window (unchanged)
  }

  static DEFAULT_OPTIONS = {
    id: "shipcombat-dead-reckoning-popup",
    classes: ["shipcombat-dead-reckoning-popup"],
    tag: "div",
    window: {
      title: "Dead Reckoning  -  Set Draw Order",
      resizable: false,
    },
    position: { width: 420, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${CORE_MODULE_ID}/templates/apps/dead-reckoning-popup.hbs` },
  };

  static ACTIONS = {
    confirmOrder: DeadReckoningPopup._onConfirmOrder,
    cancelOrder:  DeadReckoningPopup._onCancelOrder,
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      cards: this._cards.map((id, i) => ({
        id,
        pos:   i + 1,
        label: game.i18n.localize(`SHIPCOMBAT.Captain.Card.${id}`),
      })),
      tailCount: this._rest.length,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._initDragDrop();
  }

  _initDragDrop() {
    const list = this.element.querySelector(".shipcombat-dr-list");
    if (!list) return;

    let dragSrcEl = null;

    list.querySelectorAll(".shipcombat-dr-card").forEach(card => {
      card.addEventListener("dragstart", ev => {
        dragSrcEl = card;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", card.dataset.cardId);
        // Slight delay so the ghost image doesn't include the drag-over highlight
        requestAnimationFrame(() => card.classList.add("shipcombat-dr-dragging"));
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("shipcombat-dr-dragging");
        list.querySelectorAll(".shipcombat-dr-drag-over").forEach(el => el.classList.remove("shipcombat-dr-drag-over"));
        dragSrcEl = null;
        this._syncPositionNumbers();
      });

      card.addEventListener("dragover", ev => {
        if (!dragSrcEl || dragSrcEl === card) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        list.querySelectorAll(".shipcombat-dr-drag-over").forEach(el => el.classList.remove("shipcombat-dr-drag-over"));
        card.classList.add("shipcombat-dr-drag-over");
      });

      card.addEventListener("dragleave", () => {
        card.classList.remove("shipcombat-dr-drag-over");
      });

      card.addEventListener("drop", ev => {
        ev.preventDefault();
        if (!dragSrcEl || dragSrcEl === card) return;
        list.insertBefore(dragSrcEl, card);
        card.classList.remove("shipcombat-dr-drag-over");
        this._syncPositionNumbers();
      });
    });
  }

  /** Update the numbered position badges to reflect DOM order. */
  _syncPositionNumbers() {
    this.element?.querySelectorAll(".shipcombat-dr-card").forEach((card, i) => {
      const badge = card.querySelector(".shipcombat-dr-pos");
      if (badge) badge.textContent = String(i + 1);
    });
  }

  /** Read current card order from the DOM. */
  _getCurrentOrder() {
    return [...this.element.querySelectorAll(".shipcombat-dr-card")].map(el => el.dataset.cardId);
  }

  static _onConfirmOrder(event, element) {
    const newOrder = this._getCurrentOrder();
    const newPile  = [...newOrder, ...this._rest];
    emitToGM("captainCoreAction", { actionId: "deadReckoning", newPile });
    this.close();
  }

  static _onCancelOrder(event, element) {
    this.close();
  }
}
