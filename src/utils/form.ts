/**
 * Helpers shared by the question card and the composer.
 *
 * A question reaches the UI as a v2 form. The card owns everything that is
 * *chosen* — options, checkboxes, numbers — while a free-form answer can be
 * typed into the usual composer, so a question never grows a second input area.
 */

import type { FormField, FormInfo, FormValue } from "@/api/types"

/** The answer a field has so far, looked up by key. */
export type FieldValues = (key: string) => unknown

/** A form's answers as the server reads them. */
export type FormAnswerBody = Record<string, FormValue>

/** The value a field starts from when nothing has been picked or typed. */
export function fieldDefault(field: FormField): FormValue {
  if ("default" in field && field.default !== undefined) return field.default as FormValue
  if (field.type === "multiselect") return []
  if (field.type === "boolean") return false
  return ""
}

/** Whether a conditional field applies, given the values of the fields it depends on. */
export function isVisible(field: FormField, values: FieldValues): boolean {
  if ("hidden" in field && field.hidden) return false
  if (!("when" in field) || !field.when?.length) return true
  return field.when.every((condition) => {
    const current = values(condition.key)
    const matches = Array.isArray(current) ? current.includes(String(condition.value)) : current === condition.value
    return condition.op === "eq" ? matches : !matches
  })
}

/** The fields a person actually sees; a hidden one only contributes its default. */
export function visibleFields(form: FormInfo, values: FieldValues): FormField[] {
  return form.fields.filter((field) => isVisible(field, values))
}

/** The values a form starts from, before anything is picked or typed. */
export function defaultValues(form: FormInfo): FormAnswerBody {
  const values: FormAnswerBody = {}
  for (const field of form.fields) values[field.key] = fieldDefault(field)
  return values
}

/** Coerce a raw value to the shape the field's type expects. */
export function normalizeValue(field: FormField, value: unknown): FormValue {
  if (field.type === "multiselect") return Array.isArray(value) ? (value as string[]) : []
  if (field.type === "boolean") return value === true || value === "true"
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "string") return value as FormValue
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  return typeof value === "string" ? value : String(value ?? "")
}

/**
 * Whether a line typed in the composer can answer this field.
 *
 * A field that offers options only takes one of them — unless it also invites a
 * custom answer — while a Yes/No or an external link has nothing a typed line
 * could fill. A multiselect is no different once it invites a custom answer: the
 * line becomes the list's one entry, rather than the field being turned away
 * because a list usually arrives as clicks.
 */
export function acceptsText(field: FormField): boolean {
  if (field.type === "boolean" || field.type === "external") return false
  if ("options" in field && field.options?.length) return field.custom === true
  return true
}

/**
 * Whether the card should answer this form on its own.
 *
 * True once every field it shows has an answer, so the click that lands the last
 * choice sends the form instead of waiting for a Submit press. A form holding a
 * field with no end to click never settles and keeps its button.
 */
export function answersSettle(form: FormInfo, values: FieldValues): boolean {
  const fields = visibleFields(form, values)
  return fields.length > 0 && fields.every((field) => settled(field, values(field.key)))
}

/** Whether one field is done with: an answer in hand, or nothing left to answer here. */
function settled(field: FormField, value: unknown): boolean {
  if (hasNoEnd(field)) return false
  if (hasAnswer(field, value)) return true
  // A choice still to make. The question tool never marks a question required,
  // yet every one of them waits for a pick.
  if (field.type === "boolean" || (field.type === "string" && field.options?.length)) return false
  // What is left is typed: an empty optional input is not worth sitting on.
  return !("required" in field && field.required)
}

/** Whether a field holds an answer: false is one, so an untouched Yes/No holds none. */
function hasAnswer(field: FormField, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean"
  if (field.type === "number" || field.type === "integer") return typeof value === "number" && Number.isFinite(value)
  if (Array.isArray(value)) return value.length > 0
  return typeof value === "string" && value.trim() !== ""
}

/** The fields that leave a form no click to end on: a multiple choice and a browser step. */
function hasNoEnd(field: FormField): boolean {
  return field.type === "multiselect" || field.type === "external"
}

/** Whether the card keeps its Submit button: a form holding a field with no end to click. */
export function needsSubmit(form: FormInfo, values: FieldValues): boolean {
  return visibleFields(form, values).some(hasNoEnd)
}

/**
 * The answer a line typed in the composer gives a pending question.
 *
 * The text lands on the first field that can take it — a question usually has a
 * single free-form one — and every other field keeps its default, because the
 * server reads the answer as a whole. Returns null when no visible field could
 * take typed text, so the caller can fall back to sending a normal message
 * rather than answering a question nobody asked.
 */
export function answerFromText(form: FormInfo, text: string): FormAnswerBody | null {
  const body = text.trim()
  if (!body) return null
  const values = defaultValues(form)
  const fields = visibleFields(form, (key) => values[key])
  const target = fields.find(acceptsText)
  if (!target) return null
  const answer: FormAnswerBody = {}
  for (const field of fields) {
    // A multiselect's answer is a list, and a typed custom answer is its one entry.
    if (field === target && field.type === "multiselect") answer[field.key] = [body]
    else answer[field.key] = normalizeValue(field, field === target ? body : values[field.key])
  }
  return answer
}
