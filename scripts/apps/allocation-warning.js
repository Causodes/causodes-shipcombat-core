import { MODULE_ID } from "../constants.js";
import { getUnspentAllocation } from "../state/allocation-guard.js";
import { SystemAdapter } from "../systems/SystemAdapter.js";

const SETTING_KEY = "suppressedAllocationWarnings";

function _warningContent(allocation, actionLabel, checkboxId) {
  const body = allocation.state === "unrolled"
    ? game.i18n.format("SHIPCOMBAT.Dialog.UnrolledAllocationBody", {
        unit: SystemAdapter.current.formatAllocationUnit(2),
        action: foundry.utils.escapeHTML(actionLabel),
      })
    : game.i18n.format("SHIPCOMBAT.Dialog.UnspentAllocationBody", {
        count: allocation.remaining,
        unit: SystemAdapter.current.formatAllocationUnit(allocation.remaining),
        action: foundry.utils.escapeHTML(actionLabel),
      });
  return `
    <div class="shipcombat-tp-wrapper shipcombat-allocation-warning__body">
      <p>${body}</p>
      <label class="shipcombat-allocation-warning__suppress">
        <input type="checkbox" id="${checkboxId}">
        <span>${game.i18n.localize("SHIPCOMBAT.Dialog.UnspentAllocationSuppressTrigger")}</span>
      </label>
    </div>`;
}

function _showWarningV1(content, checkboxId) {
  return new Promise(resolve => {
    new foundry.appv1.api.Dialog({
      title: game.i18n.localize("SHIPCOMBAT.Dialog.UnspentAllocationTitle"),
      content,
      buttons: {
        cancel: {
          icon: "<i class='fa-solid fa-arrow-left'></i>",
          label: game.i18n.localize("Cancel"),
          callback: () => resolve({ proceed: false, suppress: false }),
        },
        continue: {
          icon: "<i class='fa-solid fa-check'></i>",
          label: game.i18n.localize("Continue"),
          callback: html => resolve({
            proceed: true,
            suppress: !!html.find(`#${checkboxId}`).prop("checked"),
          }),
        },
      },
      default: "cancel",
      close: () => resolve({ proceed: false, suppress: false }),
    }, {
      classes: ["shipcombat-targeting-popup", "shipcombat-allocation-warning"],
      width: 420,
      height: "auto",
    }).render(true);
  });
}

function _showWarningV2(content, checkboxId) {
  return new Promise(resolve => {
    new foundry.applications.api.DialogV2({
      classes: ["shipcombat-targeting-popup", "shipcombat-allocation-warning"],
      window: { title: game.i18n.localize("SHIPCOMBAT.Dialog.UnspentAllocationTitle") },
      position: { width: 420, height: "auto" },
      content,
      buttons: [
        { action: "cancel", label: game.i18n.localize("Cancel"), icon: "fa-solid fa-arrow-left" },
        { action: "continue", label: game.i18n.localize("Continue"), icon: "fa-solid fa-check" },
      ],
      close: () => resolve({ proceed: false, suppress: false }),
      submit: action => resolve({
        proceed: action === "continue",
        suppress: action === "continue" && !!document.getElementById(checkboxId)?.checked,
      }),
    }).render(true);
  });
}

export async function confirmAllocationCommit(data, roleId, trigger, actionLabel) {
  const allocation = getUnspentAllocation(data, roleId);
  if (!allocation) return true;

  const suppressed = game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
  if (suppressed[trigger]) return true;

  const checkboxId = `${MODULE_ID}-allocation-warning-${foundry.utils.randomID()}`;
  const content = _warningContent(allocation, actionLabel, checkboxId);
  const result = await (SystemAdapter.current.useApplicationV1
    ? _showWarningV1(content, checkboxId)
    : _showWarningV2(content, checkboxId));

  if (result.suppress) {
    await game.settings.set(MODULE_ID, SETTING_KEY, { ...suppressed, [trigger]: true });
  }
  return result.proceed;
}

export class AllocationWarningResetMenu extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-allocation-warning-reset`,
      classes: ["shipcombat-targeting-popup", "shipcombat-allocation-warning-reset"],
      title: game.i18n.localize("SHIPCOMBAT.Setting.ResetAllocationWarnings"),
      template: `modules/${MODULE_ID}/templates/apps/allocation-warning-reset.hbs`,
      width: 420,
      closeOnSubmit: true,
    });
  }

  async getData() {
    return {
      hint: game.i18n.localize("SHIPCOMBAT.Setting.ResetAllocationWarningsHint"),
      submitText: game.i18n.localize("SHIPCOMBAT.Setting.ResetAllocationWarningsButton"),
    };
  }

  async _updateObject() {
    await game.settings.set(MODULE_ID, SETTING_KEY, {});
    ui.notifications.info(game.i18n.localize("SHIPCOMBAT.Setting.ResetAllocationWarningsDone"));
  }
}

export { SETTING_KEY as ALLOCATION_WARNING_SETTING };