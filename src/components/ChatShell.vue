<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { X, Archive, CircleAlert, Check, Hash, Moon, Sun } from "lucide-vue-next"
import type { SessionMessageAssistant } from "@/api/types"
import Sidebar from "./Sidebar.vue"
import MessageThread from "./MessageThread.vue"
import Composer from "./Composer.vue"
import McpDialog from "./McpDialog.vue"
import PromptDock from "./PromptDock.vue"
import { TITLE_SUFFIX } from "@/brand"
import { useApp } from "@/stores/app"
import { requestComposerFocus } from "@/stores/draft"
import { requestOpen, shortcutKeys, shortcutsVisible, togglePronunciation } from "@/stores/shortcuts"
import { searchOpen, openSearch } from "@/stores/search"
import { theme, toggleTheme } from "@/theme"
import { formatConversationDate, formatConversationDateTime, formatCost } from "@/utils/format"

const app = useApp()
const { current } = app.sessions
const { error, messages, isBusy, awaitingUser } = app.chat
const { models, selectedModelInfo } = app.server
const { newChat } = app

/** Whether the open conversation is an archived one being previewed. */
const isArchived = computed(() => Boolean(current.value?.time?.archived))

/** Briefly confirm that the session id reached the clipboard. */
const sessionCopied = ref(false)

async function copySessionID() {
  const id = current.value?.id
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    sessionCopied.value = true
    setTimeout(() => (sessionCopied.value = false), 1500)
  } catch {
    /* clipboard unavailable */
  }
}

const SIDEBAR_KEY = "opencode-web-chat.sidebar-width"
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 520
const DEFAULT_SIDEBAR = 264

function loadSidebarWidth() {
  const value = Number(localStorage.getItem(SIDEBAR_KEY))
  return Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? value : DEFAULT_SIDEBAR
}

const sidebarWidth = ref(loadSidebarWidth())

function applySidebarWidth() {
  document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth.value}px`)
}

/** Split.js-style drag handle between the sidebar and the conversation. */
function startResize(event: PointerEvent) {
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const onMove = (move: PointerEvent) => {
    sidebarWidth.value = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, move.clientX))
    applySidebarWidth()
  }
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove)
    handle.removeEventListener("pointerup", onUp)
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth.value))
    } catch {
      /* ignore */
    }
  }
  handle.addEventListener("pointermove", onMove)
  handle.addEventListener("pointerup", onUp)
}

const title = computed(() => current.value?.title || "New chat")

// Reflect the active chat in the browser tab title.
watch(
  title,
  (value) => {
    document.title = current.value ? `${value} · ${TITLE_SUFFIX}` : TITLE_SUFFIX
  },
  { immediate: true },
)

// Session cost: the session total, which the server keeps up to date, with the
// sum of assistant message costs as a fallback while streaming.
const sessionCost = computed(() => {
  const total = messages.value.reduce((sum, item) => (item.type === "assistant" ? sum + (item.cost ?? 0) : sum), 0)
  return Math.max(current.value?.cost ?? 0, total)
})

// Context usage is taken from the last assistant message that produced output.
const lastAssistant = computed<SessionMessageAssistant | null>(() => {
  const list = messages.value
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]
    if (message.type === "assistant" && (message.tokens?.output ?? 0) > 0) return message
  }
  return null
})

const contextTokens = computed(() => {
  const tokens = lastAssistant.value?.tokens
  if (!tokens) return 0
  return (
    (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
  )
})

const contextLimit = computed(() => {
  const info = lastAssistant.value
  if (info?.model) {
    const model = models.value.find((item) => item.providerID === info.model.providerID && item.id === info.model.id)
    if (model?.limit?.context) return model.limit.context
  }
  return selectedModelInfo.value?.limit?.context ?? 0
})

const contextPercent = computed(() => (contextLimit.value ? Math.round((contextTokens.value / contextLimit.value) * 100) : 0))

const costTitle = computed(() => `Session cost: ${formatCost(sessionCost.value)}`)
// The conversation date, showing a range when it spans more than one day.
const conversationDate = computed(() => formatConversationDate(current.value?.time))
const conversationDateTitle = computed(() => formatConversationDateTime(current.value?.time))
const contextTitle = computed(() =>
  contextLimit.value
    ? `${contextTokens.value.toLocaleString()} tokens (${contextPercent.value}% of context)`
    : `${contextTokens.value.toLocaleString()} tokens`,
)

function dismissError() {
  error.value = null
}

/**
 * Shortcuts use `Alt` + a letter; matching on `event.code` keeps them working on
 * macOS, where Option+letter produces a different `event.key`. Holding Alt
 * reveals the key badges on the controls they trigger.
 */
function onKeyDown(event: KeyboardEvent) {
  if (event.altKey) shortcutsVisible.value = true
  if (!event.altKey) return
  switch (event.code) {
    case shortcutKeys.model:
      event.preventDefault()
      requestOpen("model")
      break
    case shortcutKeys.project:
      event.preventDefault()
      requestOpen("project")
      break
    case shortcutKeys.sessions:
      event.preventDefault()
      requestOpen("sessions")
      break
    case shortcutKeys.search:
      event.preventDefault()
      openSearch()
      break
    case shortcutKeys.effort:
      event.preventDefault()
      requestOpen("effort")
      break
    case shortcutKeys.tools:
      event.preventDefault()
      requestOpen("tools")
      break
    case shortcutKeys.pronounce:
      event.preventDefault()
      togglePronunciation()
      break
    case shortcutKeys.stop:
      event.preventDefault()
      if (isBusy.value || awaitingUser.value) void app.abort()
      break
    case shortcutKeys.newChat:
      event.preventDefault()
      void newChat()
      break
    case shortcutKeys.focusChat:
      event.preventDefault()
      requestComposerFocus()
      break
    default:
      break
  }
}

function onKeyUp(event: KeyboardEvent) {
  if (event.key === "Alt" || !event.altKey) shortcutsVisible.value = false
}

function onBlur() {
  shortcutsVisible.value = false
}

function onPopState() {
  void app.openSessionFromUrl()
}

onMounted(() => {
  applySidebarWidth()
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)
  window.addEventListener("blur", onBlur)
  window.addEventListener("popstate", onPopState)
})
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown)
  window.removeEventListener("keyup", onKeyUp)
  window.removeEventListener("blur", onBlur)
  window.removeEventListener("popstate", onPopState)
  shortcutsVisible.value = false
})
</script>

<template>
  <div class="shell" :class="{ searching: searchOpen }">
    <div class="sidebar-host">
      <Sidebar />
    </div>
    <div class="resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" @pointerdown="startResize"></div>

    <main class="main">
      <header class="topbar">
        <h1 class="title">{{ title }}</h1>
        <span v-if="isArchived" class="archived-pill" title="This conversation is archived">
          <Archive :size="12" /> Archived
        </span>
        <div v-if="current" class="stats">
          <span v-if="conversationDate" class="stat" :title="conversationDateTitle">{{ conversationDate }}</span>
          <span v-if="conversationDate" class="stat-divider">·</span>
          <span class="stat" :title="costTitle">{{ formatCost(sessionCost) }}</span>
          <span class="stat-divider">·</span>
          <span class="stat" :class="{ warn: contextPercent >= 80 }" :title="contextTitle">
            {{ contextLimit ? `${contextPercent}%` : "—" }}
          </span>
        </div>
        <button
          class="theme-btn"
          :title="theme === 'dark' ? 'Light theme' : 'Dark theme'"
          aria-label="Toggle dark mode"
          @click="toggleTheme()"
        >
          <Sun v-if="theme === 'dark'" :size="16" />
          <Moon v-else :size="16" />
        </button>
        <button
          v-if="current"
          class="app-btn"
          :class="{ active: sessionCopied }"
          :title="sessionCopied ? 'Session id copied' : `Copy session id (${current.id})`"
          aria-label="Copy session id"
          @click="copySessionID"
        >
          <Check v-if="sessionCopied" :size="16" />
          <Hash v-else :size="16" />
        </button>
      </header>

      <MessageThread />

      <div class="bottom">
        <div v-if="error" class="error-banner">
          <CircleAlert :size="15" />
          <span>{{ error }}</span>
          <button @click="dismissError"><X :size="14" /></button>
        </div>
        <PromptDock />
        <!-- An archived conversation is read-only: restoring it is what puts it
             back in play, so the composer says so instead of half-working. -->
        <div v-if="isArchived" class="archived-bar">
          <Archive :size="15" />
          <span>This conversation is archived. Restore it from the archive to continue it.</span>
        </div>
        <Composer v-else />
      </div>
    </main>

    <McpDialog />

  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.sidebar-host {
  flex: none;
  height: 100%;
}
@media (max-width: 720px) {
  .sidebar-host {
    display: none;
  }
  /* Search has no full-page view any more: overlay the sidebar on small
     screens so results stay reachable. */
  .shell.searching .sidebar-host {
    display: flex;
    position: fixed;
    inset: 0;
    z-index: 30;
  }
  .shell.searching .sidebar-host :deep(.sidebar) {
    width: 100%;
  }
}
.resizer {
  flex: none;
  width: 5px;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
  transition: background 0.12s;
}
.resizer:hover,
.resizer:active {
  background: var(--accent);
  opacity: 0.5;
}
@media (max-width: 720px) {
  .resizer {
    display: none;
  }
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.topbar {
  position: relative;
  z-index: 2;
  height: var(--header-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(8px);
}
/* Fade the top of the conversation toward the header. */
.topbar::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  height: 14px;
  background: linear-gradient(to bottom, var(--bg), transparent);
  pointer-events: none;
  z-index: 1;
}
.title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* A flex item will not shrink below its content without this, so a long title
     is not ellipsised — it pushes the header row wider than the window. */
  min-width: 0;
  flex: 1;
}
.stats {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.stat {
  cursor: default;
  white-space: nowrap;
}
.stat:hover {
  color: var(--text-muted);
}
.stat.warn {
  color: var(--accent);
}
.stat-divider {
  opacity: 0.5;
}
.theme-btn,
.app-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
}
/* An archived conversation is previewed from the archive, so the header says so. */
.archived-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-active);
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.archived-bar {
  max-width: var(--content-width);
  margin: 0 auto 10px;
  width: calc(100% - 40px);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.archived-bar span {
  flex: 1;
}
.theme-btn {
  margin-left: 12px;
}
.theme-btn:hover,
.app-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.app-btn.active {
  color: #4ade80;
}
.bottom {
  position: relative;
  flex: none;
}
/* Fade the conversation out as it approaches the composer. */
.bottom::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: -10px;
  height: 10px;
  background: linear-gradient(to bottom, transparent, var(--bg));
  pointer-events: none;
  z-index: 1;
}
.error-banner {
  max-width: var(--content-width);
  margin: 0 auto 10px;
  width: calc(100% - 40px);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.error-banner span {
  flex: 1;
}
.error-banner button {
  background: transparent;
  border: none;
  color: inherit;
  display: inline-flex;
}
</style>