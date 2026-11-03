<script setup lang="ts">
import { nextTick, ref, watch } from "vue"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui"
import {
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-vue-next"
import Spinner from "./Spinner.vue"
import ProjectSelector from "./ProjectSelector.vue"
import SidebarSearch from "./SidebarSearch.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import iconUrl from "../../build/icon.png"
import { useApp } from "@/stores/app"
import { relativeTime } from "@/utils/format"
import { shortcutsVisible, openRequests } from "@/stores/shortcuts"
import { openSearch, searchOpen } from "@/stores/search"

const app = useApp()
const { sorted, currentID, loading } = app.sessions
const { newChat, selectSession, deleteSession, renameSession } = app

const editingID = ref<string | null>(null)
const editTitle = ref("")
const editInput = ref<HTMLInputElement | null>(null)

function setRenameInput(el: Element | { $el?: Element } | null) {
  if (!el) {
    editInput.value = null
    return
  }
  const node = (el as { $el?: Element }).$el ?? (el as Element)
  editInput.value = node instanceof HTMLInputElement ? node : null
}

async function startRename(id: string, title: string) {
  editingID.value = id
  editTitle.value = title
  await nextTick()
  editInput.value?.focus()
  editInput.value?.select()
}

async function commitRename() {
  const id = editingID.value
  if (!id) return
  const title = editTitle.value.trim()
  editingID.value = null
  if (title) await renameSession(id, title)
}

function cancelRename() {
  editingID.value = null
}

/* ----------------------------- delete a session ----------------------------- */

/** The conversation a delete confirmation is open for, if any. */
const pendingDelete = ref<{ id: string; title: string } | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function askDelete(id: string, title: string) {
  deleteError.value = null
  pendingDelete.value = { id, title: title || "Untitled" }
}

function cancelDelete() {
  if (deleting.value) return
  pendingDelete.value = null
  deleteError.value = null
}

async function confirmDelete() {
  const pending = pendingDelete.value
  if (!pending || deleting.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await deleteSession(pending.id)
    pendingDelete.value = null
  } catch (cause) {
    deleteError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    deleting.value = false
  }
}

/* ------------------------------ session list nav ------------------------------ */

const sessionsNav = ref<HTMLElement | null>(null)
/** Index of the arrow-key cursor in the session list, or -1 when inactive. */
const navIndex = ref(-1)

function scrollNavIntoView() {
  const items = sessionsNav.value?.querySelectorAll<HTMLElement>(".session")
  items?.[navIndex.value]?.scrollIntoView({ block: "nearest" })
}

// Alt+S jumps into the session list, cursoring on the current session.
watch(
  () => openRequests.sessions,
  () => {
    const list = sorted.value
    if (!list.length) return
    const current = list.findIndex((session) => session.id === currentID.value)
    navIndex.value = current >= 0 ? current : 0
    void nextTick(() => {
      sessionsNav.value?.focus()
      scrollNavIntoView()
    })
  },
)

function endNav() {
  navIndex.value = -1
}

function moveNav(delta: number) {
  const list = sorted.value
  navIndex.value = Math.min(list.length - 1, Math.max(0, navIndex.value + delta))
  void nextTick(scrollNavIntoView)
}

function onSessionsKeydown(event: KeyboardEvent) {
  if (navIndex.value < 0) return
  const list = sorted.value
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault()
      moveNav(1)
      break
    case "ArrowUp":
      event.preventDefault()
      moveNav(-1)
      break
    case "Home":
      event.preventDefault()
      navIndex.value = 0
      void nextTick(scrollNavIntoView)
      break
    case "End":
      event.preventDefault()
      navIndex.value = list.length - 1
      void nextTick(scrollNavIntoView)
      break
    case "Enter": {
      event.preventDefault()
      const session = list[navIndex.value]
      if (session) void selectSession(session.id)
      endNav()
      break
    }
    case "Escape":
      event.preventDefault()
      endNav()
      break
    default:
      break
  }
}
</script>

<template>
  <aside class="sidebar">
    <SidebarSearch v-if="searchOpen" />
    <template v-else>
    <header class="head">
      <img class="logo" :src="iconUrl" alt="" />
      <ProjectSelector />
      <button class="icon search-btn" title="Search conversations (Alt+F)" @click="openSearch()">
        <Search :size="16" />
        <kbd v-if="shortcutsVisible" class="kbd floating">F</kbd>
      </button>
      <button class="icon new-chat-btn" title="New chat (Alt+N)" @click="newChat()">
        <MessageSquarePlus :size="18" />
        <kbd v-if="shortcutsVisible" class="kbd floating">N</kbd>
      </button>
    </header>

    <div class="sessions-wrap">
      <nav ref="sessionsNav" class="sessions" tabindex="-1" @keydown="onSessionsKeydown" @blur="endNav">
      <div v-if="loading && !sorted.length" class="muted"><Spinner :size="14" /></div>
      <button
        v-for="(session, index) in sorted"
        :key="session.id"
        class="session"
        :class="{ active: session.id === currentID, 'kb-active': index === navIndex }"
        @click="selectSession(session.id)"
        @dblclick="startRename(session.id, session.title ?? '')"
      >
        <input
          v-if="editingID === session.id"
          :ref="setRenameInput"
          v-model="editTitle"
          class="rename"
          @click.stop
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <template v-else>
          <span class="session-title">{{ session.title || "Untitled" }}</span>
          <span class="session-time">{{ relativeTime(session.time?.updated ?? session.time?.created) }}</span>
        </template>
        <DropdownMenuRoot v-if="editingID !== session.id">
          <DropdownMenuTrigger as-child>
            <span class="session-menu" @click.stop><MoreHorizontal :size="15" /></span>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent class="opencode-menu" :side-offset="4" align="start">
              <DropdownMenuItem class="opencode-menu-item" @select="startRename(session.id, session.title ?? '')">
                <Pencil :size="14" /> Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator class="opencode-menu-sep" />
              <DropdownMenuItem class="opencode-menu-item danger" @select="askDelete(session.id, session.title ?? '')">
                <Trash2 :size="14" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </button>
      <p v-if="!loading && !sorted.length" class="muted empty">No conversations yet</p>
      </nav>
      <kbd v-if="shortcutsVisible" class="kbd floating">S</kbd>
    </div>
    </template>

    <ConfirmDialog
      :open="Boolean(pendingDelete)"
      title="Delete conversation?"
      :message="pendingDelete ? `This removes “${pendingDelete.title}” and its messages from opencode. It cannot be undone.` : ''"
      confirm-label="Delete"
      danger
      :busy="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
}
.logo {
  /* The app icon itself, so the header carries no second drawing of the logo. */
  flex: none;
  width: 26px;
  height: 26px;
  display: block;
}
/* Project selector fills the space between the logo and the new-chat button. */
.head :deep(.opencode-project-root) {
  flex: 1;
  min-width: 0;
}
.head :deep(.opencode-project-anchor) {
  width: 100%;
}
.head :deep(.opencode-project-input) {
  flex: 1;
  min-width: 0;
  width: auto;
}
.new-chat-btn {
  position: relative;
  flex: none;
}
.search-btn {
  position: relative;
  flex: none;
}
.sessions-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.sessions {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  outline: none;
}
.session.kb-active {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.session {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  width: 100%;
}
.session:hover {
  background: var(--bg-hover);
}
.session.active {
  background: var(--bg-active);
}
.session-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}
.session:hover .session-time {
  visibility: hidden;
}
.session-menu {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  color: var(--text-muted);
  opacity: 0;
  padding: 3px;
  border-radius: 5px;
}
.session:hover .session-menu {
  opacity: 1;
}
.session-menu:hover {
  background: var(--bg-active);
}
.rename {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 3px 6px;
  font-size: 13px;
  outline: none;
}
.muted {
  color: var(--text-faint);
  font-size: 12.5px;
}
.empty {
  text-align: center;
  padding: 22px 0;
}
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 6px;
  border-radius: var(--radius-sm);
}
.icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
</style>