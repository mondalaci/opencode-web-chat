import { computed, ref, watch } from "vue"
import type { V2Event } from "@/api/types"
import {
  QUESTION_REASON,
  conversationState,
  stateLabel,
  worstState,
  type ConversationState,
} from "@/utils/conversation"
import { useChat } from "./chat"
import { useConnection } from "./connection"
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
 * at it is what clears it. Looking at a conversation also publishes the idle
 * stamp to the server (`time.viewed`), because the studio app and the Cinnamon
 * panel read that marker rather than this browser's private set - without it
 * their green dot stays lit for a finish the user has already read here.
 *
 * That set belongs to the app rather than to the tab. Every tab watches the same
 * stream, so every hidden one marks the same conversation unread; if each kept
 * its own set, looking at the conversation in one tab would clear it there and
 * leave the others still reporting it — and the studio app, whose tray sees all
 * of them, would go on showing it. So the set lives in storage, the tabs share it
 * through `storage` events, and looking at a conversation in any tab clears it
 * for all of them.
 */

const UNREAD_KEY = "opencode-web-chat.unread-sessions"

interface SessionSignals {
  status?: string
}

const signals = ref<Record<string, SessionSignals>>({})
const unread = ref<Set<string>>(readUnread())

/**
 * The idle stamps this tab has already published, keyed `<sessionID>:<idle>`.
 *
 * Acknowledging runs on every focus change and every unread change, so the same
 * finish would otherwise be posted over and over. Keying on the stamp rather
 * than the session is what lets a later turn's finish be published too.
 */
const published = new Set<string>()

function readUnread(): Set<string> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return new Set()
  }
}

/**
 * Change the set by re-reading it first, then writing back.
 *
 * Two tabs catching two different turns at the same moment must not overwrite
 * each other's, so a change is applied to what is stored rather than to whatever
 * this tab last read.
 */
function updateUnread(mutate: (set: Set<string>) => void) {
  const next = readUnread()
  mutate(next)
  unread.value = next
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...next]))
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
  const connection = useConnection()
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
        // A turn that ends in front of the user is not news; one that ends
        // elsewhere is something to come back to. Reading the finish is what
        // publishes the view (see `markSeen`), not the turn ending: a tab left
        // open on a conversation is not proof that its reply was seen.
        if ((sessions.currentID.value !== sessionID || unfocused()) && !unread.value.has(sessionID)) {
          updateUnread((set) => set.add(sessionID))
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

  /**
   * Publish "I have seen this finish" to the server.
   *
   * This app's unread set is private to the browser, so it cannot tell the
   * panel that a green dot has been dealt with. Posting the idle transition to
   * `time.viewed` is what clears the same conversation's dot in the studio and
   * in the Cinnamon panel.
   *
   * The stamp is read fresh: the event stream carries only a session id, so a
   * cached record's `time` is whatever load last saw. Posting an older idle
   * leaves the panel lit for a newer finish, and the server only ever moves
   * `viewed` forward, so it cannot repair that later.
   *
   * Best effort: nothing here waits for it.
   */
  async function publishViewed(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    let key: string | null = null
    try {
      const session = await client.getSession(sessionID)
      sessions.upsert(session)
      const idle = session.time?.idle
      if (!idle) return
      key = `${sessionID}:${idle}`
      if (published.has(key)) return
      published.add(key)
      await client.viewSession(sessionID, idle)
    } catch {
      // The next acknowledgement may retry; keep the marker honest either way.
      if (key) published.delete(key)
    }
  }

  function markSeen(sessionID: string | null | undefined) {
    if (!sessionID) return
    if (unread.value.has(sessionID)) updateUnread((set) => set.delete(sessionID))
    // Opening a conversation is the user saying they have seen it, whether or
    // not this tab ever flagged it. The panel reads the server's marker, so a
    // finish another window watched still has to be told.
    void publishViewed(sessionID)
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

  /** Whether this tab is in front of the user, as a value that can be watched. */
  const looking = ref(false)

  function refreshLooking() {
    looking.value = !unfocused()
  }

  /**
   * Clear the open conversation, if this tab is actually showing it to the user.
   *
   * A visit is what marks a conversation seen: selecting it, or coming back to
   * the window. A turn finishing is not a visit - the tab can sit open on a
   * conversation for hours while the user works elsewhere - so the reply stays
   * green in the panel until somebody really looks at it.
   */
  function acknowledge() {
    if (!looking.value) return
    markSeen(sessions.currentID.value)
  }

  function onAttention() {
    refreshLooking()
    acknowledge()
  }

  /**
   * A mark another tab made, or cleared. The set belongs to the app, so the tabs
   * have to agree on it: without this, looking at a conversation here would leave
   * the other tabs reporting it as unread, which is what the studio app's tray
   * reads.
   */
  function onStorage(event: StorageEvent) {
    if (event.key !== null && event.key !== UNREAD_KEY) return
    unread.value = readUnread()
  }

  let started = false

  /**
   * Start following the window's focus. Called once, for the life of the tab:
   * the acknowledgement is about this page, not about a server connection.
   */
  function start() {
    if (started) return
    started = true
    refreshLooking()
    window.addEventListener("focus", onAttention)
    window.addEventListener("blur", onAttention)
    document.addEventListener("visibilitychange", onAttention)
    window.addEventListener("storage", onStorage)
    // Only a visit acknowledges something. Watching `unread` here would let a
    // background turn's mark publish the conversation this tab happens to have
    // open, which is how a dot nobody read could disappear.
    watch(() => sessions.currentID.value, acknowledge, { immediate: true })
  }

  /**
   * Forget what this tab knows about the stream. The unread marks are left alone:
   * they belong to the app's conversations, not to this tab's connection, and
   * another tab may be showing one of them right now.
   */
  function reset() {
    signals.value = {}
    published.clear()
  }

  return {
    signals,
    unread,
    looking,
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
