/**
 * Shared sheet utilities for AppV2 document sheets.
 */

/**
 * Coerce null values from empty `<input type="number">` (or range) fields to 0.
 *
 * Foundry's FormDataExtended stores `null` — not `""` — when a number input is
 * empty (see FormDataExtended#_getFieldValue: `if (field.value === "") return
 * null`). Foundry's NumberField validation then rejects the null with "must be a
 * number" when `required` is true.  Coercing here, before _processFormData calls
 * expandObject(), prevents the validation error without touching the schema.
 *
 * Must be called inside _processFormData (before super) so the coercion happens
 * before DocumentSheetV2._prepareSubmitData validates the expanded object.
 *
 * @param {HTMLFormElement|null} form
 * @param {FormDataExtended}    formData  Modified in-place.
 */
export function coerceEmptyNumberInputs(form, formData) {
  if (!form) return;
  for (const [key, value] of Object.entries(formData.object)) {
    if (value === null) {
      const el = form.querySelector(`[name="${CSS.escape(key)}"]`);
      if (el?.type === "number" || el?.type === "range") {
        formData.object[key] = 0;
      }
    }
  }
}
