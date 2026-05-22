/**
 * DeadReckoningPopup  -  reorder the top 12 draw pile cards via drag and drop.
 *
 * Replaces the old sequential DialogV2 loop with a single popup showing all
 * cards at once.  The player drags cards to set the draw order; position 1 is
 * drawn next.  On confirm the new pile order is emitted to the GM.
 */
import { MODULE_ID, CORE_MODULE_ID } from "../constants.js";
import { emitToGM }  from "../socket.js";

export class DeadReckoningPopup extends foundry.appv1.api.Application {

  constructor({ cards = [], rest = [] } = {}) {
    super({});
    this._cards = [...cards]; // mutable working copy (top N cards)
    this._rest  = rest;       // cards below the preview window (unchanged)
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "shipcombat-dead-reckoning-popup",
      classes:   ["shipcombat-dead-reckoning-popup"],
      title:     "Dead Reckoning — Set Draw Order",
      template:  `modules/${CORE_MODULE_ID}/templates/apps/dead-reckoning-popup.hbs`,
      width:     420,
      height:    "auto",
      resizable: false,
    });
  }

  async getData(options) {
    const context = await super.getData(options);
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

  activateListeners($html) {
    super.activateListeners($html);
    const html = $html[0];
    this._initDragDrop(html);

    // Wire confirm/cancel buttons (were static ACTIONS)
    html.querySelector("[data-action='confirmOrder']")?.addEventListener("click", ev => {
      ev.preventDefault();
      const newOrder = this._getCurrentOrder();
      const newPile  = [...newOrder, ...this._rest];
      emitToGM("captainCoreAction", { actionId: "deadReckoning", newPile });
      this.close();
    });
    html.querySelector("[data-action='cancelOrder']")?.addEventListener("click", ev => {
      ev.preventDefault();
      this.close();
    });
  }

  _initDragDrop(list_or_root) {
    const list = (list_or_root instanceof Element)
      ? list_or_root.querySelector(".shipcombat-dr-list")
      : (this.element[0] ?? this.element).querySelector(".shipcombat-dr-list");
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
    const root = this.element[0] ?? this.element;
    root?.querySelectorAll(".shipcombat-dr-card").forEach((card, i) => {
      const badge = card.querySelector(".shipcombat-dr-pos");
      if (badge) badge.textContent = String(i + 1);
    });
  }

  /** Read current card order from the DOM. */
  _getCurrentOrder() {
    const root = this.element[0] ?? this.element;
    return [...root.querySelectorAll(".shipcombat-dr-card")].map(el => el.dataset.cardId);
  }

  // Kept as static methods for reference; now wired in activateListeners above.
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
