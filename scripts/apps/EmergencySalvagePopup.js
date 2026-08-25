import { CORE_MODULE_ID } from "../constants.js";
import { emitToGM } from "../socket.js";

/** Full-effect discard browser for Emergency Salvage. */
export class EmergencySalvagePopup extends foundry.appv1.api.Application {
  constructor({ cards = [] } = {}) {
    super({});
    this.cards = cards;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "shipcombat-emergency-salvage-popup",
      classes: ["shipcombat-emergency-salvage-popup"],
      title: game.i18n.localize("SHIPCOMBAT.Captain.Core.ESTitle"),
      template: `modules/${CORE_MODULE_ID}/templates/apps/emergency-salvage-popup.hbs`,
      width: 520,
      height: "auto",
      resizable: true,
    });
  }

  async getData(options) {
    const context = await super.getData(options);
    return { ...context, cards: this.cards };
  }

  activateListeners($html) {
    super.activateListeners($html);
    $html[0].querySelectorAll("[data-action='salvageCard']").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const cardInstanceId = button.dataset.cardInstanceId;
        if (!cardInstanceId) return;
        emitToGM("captainCoreAction", { actionId: "emergencySalvage", cardInstanceId });
        this.close();
      });
    });
  }
}
