import { computed, ref } from "vue"
import type { V2Event } from "@/api/types"
import {
  QUESTION_REASON,
  conversationState,
  stateLabel,
  worstState,
  type ConversationState,
} from "@/utils/conversation"
import { useChat } from "./chat"
import { useSessions } from "./sessions"

/**
 * Live state for every conversation in the open project.
 *
 * The v2 event stream is instance-wide, so the subscription that already drives
 * the open conversation also says what every other one is doing. Folding it here
 * is what lets a background chat report as working or blocked instead of
 * looking idle — the difference between the tray chiming for a conversation the
 * user has scrolled away from and staying silent.
 *
 * Pending permissions and questions are not tracked here: the chat store already
 * holds the whole project's, and folding over those is what marks a conversation
 * blocked. The status of the open conversation is not taken from the chat store
 * either, so that one fold describes every conversation, the open one included.
 *
 * Unread ("done") is the one state this store owns outright: a turn that ends
 * while the tab is not being looked at is something to come back to, and looking
 * at it is what clears it.
 */

const UNREAD_KEY = "opencode-web-chat.unread-sessions"

interface SessionSignals {
  status?: string
}

const signals = ref<Record<string, SessionSignals>>({})
const unread = ref<Set<string>>(loadUnread())

function loadUnread(): Set<string> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return new Set()
  }
}

function persistUnread() {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread.value]))
  } catch {
    /* storage unavailable */
  }
}

/** One conversation as the studio app receives it. */
export interface ReportedConversation {
  id: string
  title: string
  /** The project the conversation lives in, for the tray entry's label. */
  project: string
  state: ConversationState
  reason: string
}

export function usePresence() {
  const chat = useChat()
  const sessions = useSessions()

  function unfocused() {
    if (typeof document === "undefined") return false
    return document.hidden || !document.hasFocus()
  }

  function patch(sessionID: string, next: Partial<SessionSignals>) {
    const current = signals.value[sessionID] ?? {}
    signals.value = { ...signals.value, [sessionID]: { ...current, ...next } }
  }

  /**
   * Why this conversation is blocked, or undefined. Both lists cover the whole
   * project, so a conversation the user is not looking at is found here too.
   */
  function blockedReason(sessionID: string): string | undefined {
    for (const request of chat.permissions.value) {
      if (request.sessionID === sessionID) return `permission: ${request.action}`
    }
    for (const form of chat.forms.value) {
      if (form.sessionID === sessionID) return QUESTION_REASON
    }
    return undefined
  }

  /** Fold one event from the global stream into the per-session status. */
  function applyEvent(event: V2Event) {
    const data = event.data as { sessionID?: string; status?: { type?: string } } | undefined
    const sessionID = data?.sessionID
    if (!sessionID) return

    switch (event.type) {
      case "session.execution.started":
      case "session.step.started":
      case "session.tool.called":
      case "session.tool.input.started":
        patch(sessionID, { status: "busy" })
        break
      case "session.status": {
        const status = data?.status?.type
        if (status) patch(sessionID, { status })
        break
      }
      case "session.idle":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        patch(sessionID, { status: "idle" })
        // A turn that ends while the tab is elsewhere is something to come back
        // to; one that ends in front of the user is not.
        if (unfocused() && !unread.value.has(sessionID)) {
          unread.value = new Set(unread.value).add(sessionID)
          persistUnread()
        }
        break
      default:
        break
    }
  }

  function stateFor(sessionID: string | null | undefined): ConversationState {
    if (!sessionID) return "idle"
    return conversationState({
      blocked: Boolean(blockedReason(sessionID)),
      status: signals.value[sessionID]?.status,
      unread: unread.value.has(sessionID),
    })
  }

  function reasonFor(sessionID: string | null | undefined): string {
    if (!sessionID) return "idle"
    const blocked = blockedReason(sessionID)
    if (blocked) return blocked
    return stateLabel(conversationState({ status: signals.value[sessionID]?.status }), {
      status: signals.value[sessionID]?.status,
    })
  }

  function markSeen(sessionID: string | null | undefined) {
    if (!sessionID || !unread.value.has(sessionID)) return
    const next = new Set(unread.value)
    next.delete(sessionID)
    unread.value = next
    persistUnread()
  }

  /**
   * The conversations worth reporting: the ones with something to say. An idle
   * conversation is not one of them — the tray shows nothing for it, so shipping
   * it would only spend the report's budget on noise, and a long session list
   * would push a blocked conversation past the limit that protects the endpoint.
   *
   * `sessions.sorted` is the sidebar's own list, so what the tray sees is what
   * the user sees here.
   */
  const conversations = computed<ReportedConversation[]>(() =>
    sessions.sorted.value
      .map((session) => ({
        id: session.id,
        title: session.title || "Untitled",
        project: session.location?.directory ?? "",
        state: stateFor(session.id),
        reason: reasonFor(session.id),
      }))
      .filter((conversation) => conversation.state !== "idle"),
  )

  /** How many conversations the tab has open, with news or without. */
  const open = computed(() => sessions.sorted.value.length)

  /** The tab as a whole: the most actionable state any conversation is in. */
  const state = computed<ConversationState>(() =>
    worstState(conversations.value.map((conversation) => conversation.state)),
  )

  let detachAttention: (() => void) | null = null

  /** Look at a conversation, and clear whatever it was telling the user. */
  function watchWindow() {
    const acknowledge = () => markSeen(sessions.currentID.value)
    const onVisibility = () => {
      if (!document.hidden) acknowledge()
    }
    window.addEventListener("focus", acknowledge)
    document.addEventListener("visibilitychange", onVisibility)
    detachAttention = () => {
      window.removeEventListener("focus", acknowledge)
      document.removeEventListener("visibilitychange", onVisibility)
      detachAttention = null
    }
  }

  /**
   * Start following the window's focus. Called once, for the life of the tab:
   * the acknowledgement is about this page, not about a server connection.
   */
  function start() {
    if (detachAttention) return
    watchWindow()
  }

  function reset() {
    signals.value = {}
    unread.value = new Set()
    persistUnread()
  }

  return {
    signals,
    unread,
    conversations,
    open,
    state,
    stateFor,
    reasonFor,
    markSeen,
    applyEvent,
    start,
    reset,
  }
}

export type PresenceStore = ReturnType<typeof usePresence>
