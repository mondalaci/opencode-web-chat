<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { ArrowUp, FileText, Images, Paperclip, Square, TriangleAlert, X } from "lucide-vue-next"
import ModelSelector from "./ModelSelector.vue"
import SlashMenu from "./SlashMenu.vue"
import Spinner from "./Spinner.vue"
import VariantSelector from "./VariantSelector.vue"
import { useApp } from "@/stores/app"
import { addFile, attachments, clearAttachments, composerFocusRequest, draft, removeAttachment } from "@/stores/draft"
import { openImage } from "@/stores/lightbox"
import { acceptsImages } from "@/api/types"
import type { FormInfo } from "@/api/types"
import { useServer } from "@/stores/server"
import { useMcp } from "@/stores/mcp"
import { usePhotos } from "@/stores/photos"
import { requestOpen, shortcutsVisible } from "@/stores/shortcuts"
import { openSearch } from "@/stores/search"
import { theme, toggleTheme } from "@/theme"
import {
  SLASH_MENU_ROWS,
  expandSlashCommands,
  parseSlash,
  rankSlashCommands,
  slashQuery,
  type SlashCommand,
} from "@/utils/slash"
import { acceptsText, answerFromText } from "@/utils/form"

const app = useApp()
const { sending, isBusy, awaitingUser, pendingForms } = app.chat
const { abort, compact, newChat, renameSession, runCommand, sendMessage } = app
const { commands, directory, selectedModelInfo, selectedModelVariants } = useServer()
const mcp = useMcp()
const photos = usePhotos()

/**
 * Open the MCP servers dialog, which is the one command here that needs the
 * server rather than just the UI.
 */
function openMcpServers() {
  const client = app.connection.client.value
  if (!client) return
  mcp.show(client, directory.value ?? undefined)
}

const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
/** Set while a typed line is being sent as an answer, so it cannot be sent twice. */
const answering = ref(false)

const isImage = (mime: string) => mime.startsWith("image/")

const attachmentsUnsupported = () =>
  attachments.value.length > 0 && selectedModelInfo.value != null && !acceptsImages(selectedModelInfo.value)

/**
 * The pending question this composer can answer, if any.
 *
 * A question card carries only what is *chosen*; a free-form answer is typed
 * here, so a question waiting on one turns the composer into its input.
 */
const answerableForm = computed<FormInfo | undefined>(() =>
  pendingForms.value.find((form) => form.fields.some(acceptsText)),
)
const placeholder = computed(() => (answerableForm.value ? "Type your answer…" : ""))

/* ---------------------------- slash commands ----------------------------- */

/**
 * The commands this app runs itself, mirroring the TUI's own `/` list.
 *
 * Only the ones that mean something here: the TUI's `/editor`, `/worktrees`,
 * `/plugins` and friends have no counterpart in a browser, so they are left
 * out rather than listed and then refused.
 */
const localCommands = computed<SlashCommand[]>(() => [
  { display: "/new", description: "Start a new conversation", run: () => newChat() },
  { display: "/models", description: "Switch model", run: () => requestOpen("model") },
  {
    display: "/sessions",
    description: "Open the conversation list",
    aliases: ["resume", "continue"],
    run: () => requestOpen("sessions"),
  },
  { display: "/search", description: "Search conversations", run: () => openSearch() },
  { display: "/mcps", description: "MCP servers", run: () => openMcpServers() },
  { display: "/connect", description: "Connect an integration", run: () => requestOpen("integrations") },
  // The one command of this app's own that takes an argument, as the TUI's
  // `/rename <title>` does: `run` is handed the text typed after the name.
  { display: "/rename", description: "Rename this conversation", insert: true, run: renameCurrent },
  { display: "/compact", description: "Compact the conversation", run: () => compact() },
  {
    display: "/theme",
    description: `Switch to ${theme.value === "dark" ? "light" : "dark"} mode`,
    run: () => toggleTheme(),
  },
  {
    display: "/clear",
    description: "Clear the draft",
    run: () => {
      draft.value = ""
    },
  },
  // The TUI only offers its variant command when the model has variants to
  // offer; the same rule keeps the row out of the list here.
  ...(selectedModelVariants.value.length
    ? [
        {
          display: "/variants",
          description: "Switch model variant",
          aliases: ["thinking", "effort"],
          run: () => requestOpen("effort"),
        },
      ]
    : []),
])

/**
 * The server's commands, as rows.
 *
 * Always inserted, never run from here: what a command expands to is the
 * server's business, and the text typed after it is its argument.
 */
const serverCommands = computed<SlashCommand[]>(() =>
  commands.value.map((command) => ({
    display: `/${command.name}`,
    description: command.description,
    insert: true,
  })),
)

/** Every row the menu can show, aliases and all. */
const slashRows = computed(() => expandSlashCommands([...localCommands.value, ...serverCommands.value]))

/** The filter text while the caret sits inside a leading `/` token. */
const slash = ref<string | null>(null)
/** Index of the highlighted row, into `slashItems`. */
const slashSelected = ref(0)
const menuOpen = computed(() => slash.value !== null)
const slashItems = computed(() => rankSlashCommands(slash.value ?? "", slashRows.value))

/**
 * Re-read the menu from the caret.
 *
 * The menu follows the caret, so every input, click and arrow key has to ask
 * the question again: is the caret still inside a leading `/` token? A query
 * that actually changed restarts the highlight, while a caret that moved
 * within the same text leaves it where it was.
 */
function syncMenu() {
  const el = textarea.value
  if (!el) return
  const next = slashQuery(el.value.slice(0, el.selectionStart ?? 0)) ?? null
  if (next === slash.value) return
  slash.value = next
  slashSelected.value = 0
}

/** Walk the highlight, wrapping at both ends. */
function moveSelection(delta: number) {
  const count = slashItems.value.length
  if (!count) return
  const next = (slashSelected.value + delta) % count
  slashSelected.value = next < 0 ? next + count : next
}

/**
 * Take a row.
 *
 * A row that only writes a command into the prompt leaves the caret after it,
 * so its arguments can be typed; one that acts on its own runs instead. Either
 * way the typed `/query` is consumed — a picker opened from `/models` must not
 * leave the word behind in the box.
 */
function acceptCommand(index = slashSelected.value) {
  const choice = slashItems.value[index]
  if (!choice) return
  slash.value = null
  if (!choice.insert) {
    draft.value = ""
    void nextTick(resize)
    void choice.run?.("")
    return
  }
  const text = `${choice.display} `
  draft.value = text
  void nextTick(() => {
    resize()
    const el = textarea.value
    if (!el) return
    el.focus()
    el.setSelectionRange(text.length, text.length)
  })
}

/**
 * Keys the command menu claims.
 *
 * While it is open the caret only ever moves through the list: Enter picks a
 * row instead of sending, and PageUp, PageDown, Home and End walk it. Escape
 * closes the menu and leaves the text alone.
 */
function handleMenuKey(event: KeyboardEvent): boolean {
  switch (event.key) {
    case "ArrowDown":
      moveSelection(1)
      break
    case "ArrowUp":
      moveSelection(-1)
      break
    case "PageDown":
      moveSelection(SLASH_MENU_ROWS)
      break
    case "PageUp":
      moveSelection(-SLASH_MENU_ROWS)
      break
    case "Home":
      slashSelected.value = 0
      break
    case "End":
      slashSelected.value = Math.max(0, slashItems.value.length - 1)
      break
    case "Tab":
      acceptCommand()
      break
    case "Enter":
      if (event.shiftKey || event.isComposing) return false
      acceptCommand()
      break
    case "Escape":
      slash.value = null
      break
    default:
      return false
  }
  event.preventDefault()
  return true
}

/** Rename the open conversation, for `/rename`. */
async function renameCurrent(title: string) {
  const sessionID = app.sessions.currentID.value
  if (!sessionID || !title.trim()) return
  await renameSession(sessionID, title.trim())
}

/* ----------------------------- google photos ------------------------------ */

/**
 * What the Google Photos button is doing, in one line.
 *
 * The picking happens in another tab, so this title is the only thing telling
 * the user why the composer's button is spinning.
 */
const photosTitle = computed(() => {
  switch (photos.phase.value) {
    case "authorizing":
      return "Waiting for the Google sign-in…"
    case "picking":
      return "Pick photos in the Google Photos tab…"
    case "attaching":
      return "Attaching the picked photos…"
    default:
      return photos.configured.value
        ? "Attach photos from Google Photos"
        : "Attach from Google Photos (no Google OAuth client found — see the README)"
  }
})

/** The same states, said in the strip under the input, where a Cancel button sits. */
const photosProgress = computed(() => {
  switch (photos.phase.value) {
    case "authorizing":
      return "Waiting for the Google sign-in in the tab that just opened…"
    case "picking":
      return "Pick photos in the Google Photos tab; they land here when you are done."
    case "attaching":
      return "Attaching the picked photos…"
    default:
      return ""
  }
})

/* ------------------------------- composer -------------------------------- */

function resize() {
  const el = textarea.value
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`
}

watch(draft, () => nextTick(resize))
watch(composerFocusRequest, () => nextTick(() => textarea.value?.focus()))
onMounted(() => {
  resize()
  // Focus the input by default when the chat UI opens.
  nextTick(() => textarea.value?.focus())
  // The Google Photos button appears only if the broker answers, so ask once.
  void photos.init()
})

function handleFiles(files: ArrayLike<File> | null | undefined) {
  if (!files) return
  for (const file of Array.from(files)) void addFile(file)
}

function pickFiles() {
  fileInput.value?.click()
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  handleFiles(input.files)
  input.value = ""
}

function onPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === "file") {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0) return
  event.preventDefault()
  handleFiles(files)
}

function onDrop(event: DragEvent) {
  dragging.value = false
  handleFiles(event.dataTransfer?.files)
}

async function submit() {
  // While the menu is open, sending picks a row — the same thing Enter does —
  // so clicking the arrow key beside a half-typed command completes it rather
  // than mailing `/mod` to the model.
  if (menuOpen.value) {
    acceptCommand()
    return
  }

  const text = draft.value
  const hasFiles = attachments.value.length > 0
  if ((!text.trim() && !hasFiles) || sending.value || answering.value) return

  // The v2 prompt API references attachments by URI; a self-contained
  // `data:` URL is accepted for files that only exist in the browser.
  const files = attachments.value.map((item) => ({ uri: item.url, name: item.filename }))

  const parsed = parseSlash(text)

  // A command of this app's own that takes an argument, as the TUI's
  // `/rename <title>` does. It never becomes a prompt: the action owns the
  // text after the name.
  const own = parsed
    ? slashRows.value.find((row) => row.display === `/${parsed.name}` && row.insert && row.run)
    : undefined
  if (parsed && own) {
    draft.value = ""
    clearAttachments()
    await nextTick(resize)
    await own.run?.(parsed.arguments)
    return
  }

  // A command the server knows. It expands the template itself, so the name
  // and the argument string are all that travel — and a name the server has
  // never heard of falls through to an ordinary prompt, which is what keeps a
  // mistyped `/modles` from being swallowed.
  if (parsed && commands.value.some((command) => command.name === parsed.name)) {
    const pending = [...attachments.value]
    draft.value = ""
    clearAttachments()
    await nextTick(resize)
    try {
      await runCommand(parsed.name, parsed.arguments, files)
    } catch {
      draft.value = text
      attachments.value = pending
    }
    return
  }

  // A pending question claims the line: replying to it is what frees the parked
  // run, and the card clears itself once the server has the answer. Attachments
  // mean a message rather than an answer, so they go the normal way.
  const form = hasFiles ? undefined : answerableForm.value
  const answer = form ? answerFromText(form, text) : null
  if (form && answer) {
    draft.value = ""
    await nextTick(resize)
    answering.value = true
    try {
      await app.replyForm(form, answer)
    } catch {
      draft.value = text
      await nextTick(resize)
    } finally {
      answering.value = false
    }
    return
  }

  const pending = [...attachments.value]

  draft.value = ""
  clearAttachments()
  await nextTick(resize)

  try {
    await sendMessage(text, files)
  } catch {
    draft.value = text
    attachments.value = pending
  }
}

async function stop() {
  await abort()
}

function onKeydown(event: KeyboardEvent) {
  if (menuOpen.value && handleMenuKey(event)) return
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submit()
  }
}
</script>

<template>
  <div class="composer-wrap">
    <div
      class="composer"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <div
        v-if="photos.error.value || photos.notice.value || photos.busy.value"
        class="photos-status"
        :class="{ bad: !!photos.error.value }"
      >
        <span class="photos-text">{{ photos.busy.value ? photosProgress : photos.error.value || photos.notice.value }}</span>
        <button v-if="photos.busy.value" type="button" class="photos-action" @click="photos.cancel()">Cancel</button>
        <button v-else type="button" class="photos-action" title="Dismiss" @click="photos.clearMessages()">
          <X :size="12" />
        </button>
      </div>

      <div v-if="attachments.length" class="attachments">
        <div v-for="item in attachments" :key="item.id" class="attachment" :class="{ file: !isImage(item.mime) }">
          <!-- A picture is worth enlarging before it is sent, to check it is the
               one meant — so the thumbnail opens the same viewer the thread
               uses. Only the picture is clickable; the remove button over it is
               not part of it. -->
          <img
            v-if="isImage(item.mime)"
            :src="item.url"
            :alt="item.filename"
            class="zoomable"
            :title="`${item.filename} — click to enlarge`"
            @click="openImage(item.url, item.filename)"
          />
          <template v-else>
            <FileText :size="18" />
            <span class="file-name" :title="item.filename">{{ item.filename }}</span>
          </template>
          <button type="button" class="remove" :title="`Remove ${item.filename}`" @click="removeAttachment(item.id)">
            <X :size="12" />
          </button>
        </div>
      </div>

      <div class="input-wrap">
        <SlashMenu
          v-if="menuOpen"
          :items="slashItems"
          :selected="slashSelected"
          @pick="acceptCommand"
        />
        <textarea
          ref="textarea"
          v-model="draft"
          class="input"
          rows="1"
          spellcheck="false"
          :placeholder="placeholder"
          @input="syncMenu"
          @click="syncMenu"
          @keyup="syncMenu"
          @blur="slash = null"
          @keydown="onKeydown"
          @paste="onPaste"
        />
        <kbd v-if="shortcutsVisible" class="kbd floating">C</kbd>
      </div>

      <div class="bar">
        <div class="bar-left">
          <input
            ref="fileInput"
            class="file-input"
            type="file"
            multiple
            @change="onFilePicked"
          />
          <button type="button" class="attach" title="Attach files" @click="pickFiles">
            <Paperclip :size="16" />
          </button>
          <button
            v-if="photos.available.value"
            type="button"
            class="attach photos"
            :title="photosTitle"
            :disabled="photos.busy.value"
            @click="photos.pick()"
          >
            <Spinner v-if="photos.busy.value" :size="14" />
            <Images v-else :size="16" />
          </button>
          <div class="control-group" title="Model and reasoning effort">
            <ModelSelector :grouped="selectedModelVariants.length ? 'start' : 'both'" />
            <template v-if="selectedModelVariants.length">
              <span class="control-divider" aria-hidden="true" />
              <VariantSelector grouped />
            </template>
          </div>
          <span v-if="attachmentsUnsupported()" class="warn" title="The selected model may not accept images">
            <TriangleAlert :size="12" /> model may not accept images
          </span>
        </div>
        <div class="bar-right">
          <button v-if="isBusy || awaitingUser" class="send stop" title="Stop (Alt+X)" @click="stop">
            <kbd v-if="shortcutsVisible" class="kbd floating">X</kbd>
            <Square :size="14" fill="currentColor" />
          </button>
          <button
            v-else
            class="send"
            :disabled="(!draft.trim() && !attachments.length) || sending"
            title="Send (Enter)"
            @click="submit"
          >
            <ArrowUp :size="16" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer-wrap {
  /* A gutter each side, matching the message content: the avatars hang outside
     that width, so the card lines up with the bubbles rather than with them. */
  padding: 6px 40px 12px;
  max-width: var(--content-width);
  margin: 0 auto;
  width: 100%;
}
@media (max-width: 900px) {
  .composer-wrap {
    padding: 6px 16px 12px;
  }
}
.composer {
  position: relative;
  border: 1px solid var(--border);
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  padding: 10px 12px 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
  transition: border-color 0.12s;
}
.input::placeholder {
  color: var(--text-faint);
}
.composer:focus-within {
  border-color: var(--border-strong);
}
.composer.dragging {
  border-color: var(--accent);
  border-style: dashed;
}
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 4px 8px;
}
.attachment {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}
.attachment img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* A thumbnail is a picture as much as an attachment, so it opens full size. */
.attachment img.zoomable {
  cursor: zoom-in;
}
.attachment .remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  display: grid;
  place-items: center;
}
.attachment .remove:hover {
  background: rgba(0, 0, 0, 0.85);
}
.attachment.file {
  width: auto;
  max-width: 220px;
  height: 40px;
  padding: 0 26px 0 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
}
.attachment.file .file-name {
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-input {
  display: none;
}
.attach {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  display: grid;
  place-items: center;
  transition: background 0.12s, color 0.12s;
}
.attach:hover {
  background: var(--bg-active);
  color: var(--text);
}
.attach:disabled {
  opacity: 0.75;
  cursor: default;
}
.attach.photos:hover:not(:disabled) {
  color: var(--accent);
}
/* The picker runs in another tab, so this row is where the flow's state and its
   failures are visible back in the composer. */
.photos-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 2px 8px;
  padding: 6px 8px 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.4;
}
.photos-status.bad {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}
.photos-text {
  flex: 1;
  min-width: 0;
}
.photos-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.photos-action:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.input-wrap {
  position: relative;
}
.input {
  width: 100%;
  max-height: 320px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 15px;
  line-height: 1.5;
  padding: 2px 4px 8px;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bar-left {
  display: flex;
  align-items: center;
  /* Tight: the bar carries several controls plus the attach button on one line. */
  gap: 6px;
  flex-wrap: wrap;
  /* Shrink below the contents so the model pill yields instead of pushing the
     send button out of the bar. */
  min-width: 0;
}
/* One pill for the two things a run needs: which model, and how hard it thinks.
   The segments inside it are the selectors themselves, so each keeps its own
   popup and its own shortcut. Not clipped: the Alt-key badges float above the
   segments, and each segment rounds its own end instead. */
.control-group {
  display: inline-flex;
  align-items: center;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elevated);
  transition: border-color 0.12s;
  /* Let the pill shrink with the bar; its segments keep their own floors. */
  min-width: 0;
}
.control-group:focus-within {
  border-color: var(--accent);
}
.control-group > * {
  display: inline-flex;
  min-width: 0;
}
.control-divider {
  width: 1px;
  height: 16px;
  flex: none;
  background: var(--border);
}
.warn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--accent);
}
.bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.send {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--accent);
  color: var(--accent-text);
  display: grid;
  place-items: center;
  transition: background 0.12s, opacity 0.12s;
}
.send:hover:not(:disabled) {
  background: var(--accent-hover);
}
.send:disabled {
  opacity: 0.4;
  cursor: default;
}
.send.stop {
  position: relative;
  background: var(--bg-active);
  color: var(--text);
}
</style>
