<script setup lang="ts">
import { computed, reactive, ref } from "vue"
import { ExternalLink, HelpCircle, ShieldAlert, X } from "lucide-vue-next"
import type { FormField, FormInfo, FormValue } from "@/api/types"
import { useApp } from "@/stores/app"
import { answersSettle, isVisible, needsSubmit, visibleFields } from "@/utils/form"

const app = useApp()
const { pendingPermissions, pendingForms } = app.chat
const { replyPermission, replyForm, cancelForm } = app

/* ------------------------------- permissions ------------------------------- */

function decide(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
  void replyPermission(sessionID, requestID, decision)
}

/* ---------------------------------- forms ---------------------------------- */

/** Draft answers, keyed `${formID}:${fieldKey}`. */
const answers = reactive<Record<string, string | number | string[] | boolean>>({})
const submitting = ref<string | null>(null)

function key(form: FormInfo, field: FormField) {
  return `${form.id}:${field.key}`
}

function answerText(form: FormInfo, field: FormField): string {
  const value = answers[key(form, field)]
  return typeof value === "string" ? value : ""
}

/** The draft answers of one form, for the helpers that read what it shows. */
function lookup(form: FormInfo) {
  return (key: string) => answers[`${form.id}:${key}`]
}

/** Whether a conditional field is visible given the current draft answers. */
function visible(form: FormInfo, field: FormField): boolean {
  return isVisible(field, lookup(form))
}

function formFields(form: FormInfo): FormField[] {
  return visibleFields(form, lookup(form))
}

/** Single-choice selection for a `string` field that has options. */
function picked(form: FormInfo, field: FormField, value: string): boolean {
  return answers[key(form, field)] === value
}

function pick(form: FormInfo, field: FormField, value: string) {
  answers[key(form, field)] = picked(form, field, value) ? "" : value
  submitIfSettled(form)
}

function toggled(form: FormInfo, field: FormField, value: string): boolean {
  const current = answers[key(form, field)]
  return Array.isArray(current) && current.includes(value)
}

function toggle(form: FormInfo, field: FormField, value: string) {
  const current = answers[key(form, field)]
  const list = Array.isArray(current) ? [...current] : []
  const index = list.indexOf(value)
  if (index === -1) list.push(value)
  else list.splice(index, 1)
  answers[key(form, field)] = list
  submitIfSettled(form)
}

/** A Yes/No click: the pair answers the field, and may land the form's last choice. */
function chooseBoolean(form: FormInfo, field: FormField, value: boolean) {
  setAnswer(form, field, value)
  submitIfSettled(form)
}

function optionValues(field: FormField): string[] {
  return ((field as { options?: Array<{ value: string }> }).options ?? []).map((option) => option.value)
}

/** Free text typed into a field that also offers options. */
function customText(form: FormInfo, field: FormField): string {
  const current = answers[key(form, field)]
  const options = optionValues(field)
  if (Array.isArray(current)) return current.find((item) => !options.includes(item)) ?? ""
  return typeof current === "string" && current && !options.includes(current) ? current : ""
}

/**
 * Write a custom answer: for a single-choice field it replaces the picked
 * option, for a multiselect it is kept alongside the checked options.
 */
function setCustom(form: FormInfo, field: FormField, value: string) {
  const options = optionValues(field)
  const current = answers[key(form, field)]
  if (Array.isArray(current)) {
    const kept = current.filter((item) => options.includes(item))
    answers[key(form, field)] = value ? [...kept, value] : kept
  } else {
    answers[key(form, field)] = value
  }
}

function setAnswer(form: FormInfo, field: FormField, value: string | string[] | boolean | number) {
  answers[key(form, field)] = value
}

function setText(form: FormInfo, field: FormField, value: string) {
  setAnswer(form, field, value)
}

function setNumber(form: FormInfo, field: FormField, value: string) {
  setAnswer(form, field, value === "" ? "" : Number(value))
}

function buildAnswer(form: FormInfo): Record<string, FormValue> {
  const answer: Record<string, FormValue> = {}
  for (const field of formFields(form)) {
    const value = answers[key(form, field)]
    if (value === undefined || value === "") continue
    if (Array.isArray(value) && value.length === 0) continue
    answer[field.key] = value as FormValue
  }
  return answer
}

function missingRequired(form: FormInfo): boolean {
  return formFields(form).some((field) => {
    if (!("required" in field && field.required)) return false
    const value = answers[key(form, field)]
    if (value === undefined || value === "") return true
    return Array.isArray(value) && value.length === 0
  })
}

async function submit(form: FormInfo) {
  if (submitting.value === form.id || missingRequired(form)) return
  submitting.value = form.id
  try {
    await replyForm(form, buildAnswer(form))
  } finally {
    submitting.value = null
  }
}

/** Answer a form the moment its last choice lands: the card keeps no Submit button. */
function submitIfSettled(form: FormInfo) {
  if (answersSettle(form, lookup(form))) void submit(form)
}

/** Whether the card keeps its Submit button: a form holding a field with no end to click. */
function showsSubmit(form: FormInfo): boolean {
  return needsSubmit(form, lookup(form))
}

function dismiss(form: FormInfo) {
  void cancelForm(form)
}

const isEmpty = computed(() => !pendingPermissions.value.length && !pendingForms.value.length)
</script>

<template>
  <div v-if="!isEmpty" class="dock">
    <div v-for="request in pendingPermissions" :key="request.id" class="card permission">
      <div class="card-head">
        <ShieldAlert :size="16" class="icon-warn" />
        <span>Permission required</span>
        <span class="perm-name">{{ request.action }}</span>
      </div>
      <p v-if="request.message" class="perm-message">{{ request.message }}</p>
      <div v-if="request.resources?.length" class="patterns">
        <code v-for="resource in request.resources" :key="resource">{{ resource }}</code>
      </div>
      <div class="actions">
        <button class="primary" @click="decide(request.sessionID, request.id, 'once')">Allow once</button>
        <button @click="decide(request.sessionID, request.id, 'always')">Always allow</button>
        <button class="danger" @click="decide(request.sessionID, request.id, 'reject')">Deny</button>
      </div>
    </div>

    <div v-for="form in pendingForms" :key="form.id" class="card question">
      <div class="card-head">
        <HelpCircle :size="16" class="icon-accent" />
        <span>{{ form.title }}</span>
        <button class="close" title="Cancel" @click="dismiss(form)"><X :size="15" /></button>
      </div>

      <div v-for="field in formFields(form)" :key="field.key" class="field">
        <p class="field-title">
          {{ field.title || field.key }}
          <span v-if="'required' in field && field.required" class="required">*</span>
        </p>
        <p v-if="field.description" class="field-desc">{{ field.description }}</p>

        <!-- single choice -->
        <div v-if="field.type === 'string' && field.options?.length" class="options">
          <button
            v-for="option in field.options"
            :key="option.value"
            class="option"
            :class="{ picked: picked(form, field, option.value) }"
            @click="pick(form, field, option.value)"
          >
            <span class="option-label">{{ option.label }}</span>
            <span v-if="option.description" class="option-desc">{{ option.description }}</span>
          </button>
        </div>

        <!-- multi choice -->
        <div v-else-if="field.type === 'multiselect'" class="options">
          <button
            v-for="option in field.options"
            :key="option.value"
            class="option"
            :class="{ picked: toggled(form, field, option.value) }"
            @click="toggle(form, field, option.value)"
          >
            <span class="option-label">{{ option.label }}</span>
            <span v-if="option.description" class="option-desc">{{ option.description }}</span>
          </button>
        </div>

        <!-- yes / no -->
        <div v-else-if="field.type === 'boolean'" class="options row">
          <button
            class="option"
            :class="{ picked: answers[key(form, field)] === true }"
            @click="chooseBoolean(form, field, true)"
          >
            <span class="option-label">Yes</span>
          </button>
          <button
            class="option"
            :class="{ picked: answers[key(form, field)] === false }"
            @click="chooseBoolean(form, field, false)"
          >
            <span class="option-label">No</span>
          </button>
        </div>

        <!-- number / integer -->
        <input
          v-else-if="field.type === 'number' || field.type === 'integer'"
          :value="answerText(form, field)"
          class="custom"
          type="number"
          :step="field.type === 'integer' ? 1 : 'any'"
          :placeholder="field.title || field.key"
          @input="setNumber(form, field, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="submit(form)"
        />

        <!-- external link -->
        <a v-else-if="field.type === 'external'" class="external" :href="field.url" target="_blank" rel="noreferrer">
          <ExternalLink :size="13" /> {{ field.url }}
        </a>

        <!-- plain text -->
        <input
          v-else
          :value="answerText(form, field)"
          class="custom"
          :type="field.format === 'email' ? 'email' : 'text'"
          :placeholder="field.placeholder || 'Type your answer…'"
          @input="setText(form, field, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="submit(form)"
        />

        <input
          v-if="(field.type === 'string' || field.type === 'multiselect') && field.options?.length && field.custom"
          :value="customText(form, field)"
          class="custom"
          placeholder="Or type your own answer…"
          @input="setCustom(form, field, ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="submit(form)"
        />
      </div>

      <!-- A form that keeps its button: nothing on the card ends a multiple
           choice or a browser step, so those are sent by hand. -->
      <div v-if="showsSubmit(form)" class="actions">
        <button class="primary" :disabled="submitting === form.id || missingRequired(form)" @click="submit(form)">
          Submit
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dock {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: var(--content-width);
  /* Inset and centered like a message, so a question reads as the turn's own
     question rather than as a second input area above the composer. */
  margin: 6px auto 10px;
  width: 100%;
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 12px 14px;
}
.permission {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 8px;
}
.icon-warn,
.icon-accent {
  color: var(--accent);
}
.perm-name {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 400;
}
.perm-message {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-muted);
  display: inline-flex;
  padding: 2px;
}
.close:hover {
  color: var(--text);
}
.patterns {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.patterns code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  padding: 4px 7px;
  border-radius: var(--radius-sm);
  color: #d6deeb;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.actions button {
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  font-size: 13px;
}
.actions button:hover:not(:disabled) {
  background: var(--bg-hover);
}
.actions button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.actions button.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
.actions button.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.actions button.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
}
.field {
  margin-bottom: 12px;
}
.field-title {
  margin: 0 0 4px;
  font-size: 13.5px;
}
.field-desc {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.required {
  color: var(--accent);
}
.options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.options.row {
  flex-direction: row;
}
.option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 7px 11px;
  font-size: 13px;
}
.option:hover {
  background: var(--bg-hover);
}
.option.picked {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.option-label {
  font-weight: 500;
}
.option-desc {
  font-size: 11.5px;
  color: var(--text-muted);
}
.custom {
  margin-top: 6px;
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  outline: none;
  color: var(--text);
}
.custom:focus {
  border-color: var(--accent);
}
.external {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--accent);
  overflow-wrap: anywhere;
}
</style>
