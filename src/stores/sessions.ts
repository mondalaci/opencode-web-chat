import { computed, ref } from "vue"
import type { ServerClient } from "@/api/client"
import type { ModelRef, SessionInfo, V2Event } from "@/api/types"

const DEFAULT_LIMIT = 100

const sessions = ref<SessionInfo[]>([])
const currentID = ref<string | null>(null)
const loading = ref(false)

function upsert(session: SessionInfo) {
  const index = sessions.value.findIndex((item) => item.id === session.id)
  if (index === -1) {
    sessions.value = [session, ...sessions.value]
  } else {
    const next = sessions.value.slice()
    next[index] = { ...next[index], ...session }
    sessions.value = next
  }
}

export function useSessions() {
  const current = computed(() => sessions.value.find((item) => item.id === currentID.value) ?? null)

  const sorted = computed(() =>
    [...sessions.value].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0)),
  )

  async function load(client: ServerClient, directory?: string | null, limit = DEFAULT_LIMIT) {
    loading.value = true
    try {
      // The sidebar only needs the newest page; `page` walks the whole list for
      // the search view, which fetches on demand.
      const page = await client.listSessions(directory, { limit })
      sessions.value = page.data.filter((session) => !session.parentID)
    } finally {
      loading.value = false
    }
  }

  /** Query conversations without mutating the sidebar (used by the search view). */
  async function query(
    client: ServerClient,
    opts: { directory?: string | null; search?: string; limit?: number } = {},
  ) {
    const page = await client.listSessions(opts.directory, {
      limit: Math.min(opts.limit ?? DEFAULT_LIMIT, 200),
      search: opts.search,
    })
    return page.data.filter((session) => !session.parentID)
  }

  /**
   * Every conversation for a directory, following the server's cursors. The
   * list endpoint caps a page at 200 entries, so paging is the only way to get
   * the whole history.
   */
  async function queryAll(client: ServerClient, directory?: string | null, pageSize = 200) {
    const all: SessionInfo[] = []
    let cursor: string | undefined
    let guard = 0
    do {
      const page = await client.listSessions(directory, { limit: pageSize, cursor })
      all.push(...page.data)
      cursor = page.next ?? undefined
    } while (cursor && guard++ < 500)
    return all.filter((session) => !session.parentID)
  }

  async function create(
    client: ServerClient,
    body: { title?: string; agent?: string; model?: ModelRef },
    directory?: string | null,
  ) {
    const session = await client.createSession(body, directory)
    upsert(session)
    currentID.value = session.id
    return session
  }

  async function remove(client: ServerClient, sessionID: string) {
    await client.removeSession(sessionID)
    forget(sessionID)
  }

  /** Drop a conversation from the local lists, without touching the server. */
  function forget(sessionID: string) {
    sessions.value = sessions.value.filter((item) => item.id !== sessionID)
    if (currentID.value === sessionID) currentID.value = null
  }

  async function rename(client: ServerClient, sessionID: string, title: string) {
    // The patch answers without a body, so the wrapper reads the row back and
    // the sidebar shows the server's own title.
    const session = await client.updateSession(sessionID, { title })
    upsert(session)
    return session.title ?? title
  }

  /** Refresh one session from the server (used after session events). */
  async function refresh(client: ServerClient, sessionID: string) {
    try {
      const info = await client.getSession(sessionID)
      if (info.parentID) {
        sessions.value = sessions.value.filter((item) => item.id !== sessionID)
        return
      }
      upsert(info)
    } catch {
      /* the session may have been deleted meanwhile */
    }
  }

  function applyEvent(event: V2Event, client?: ServerClient) {
    switch (event.type) {
      case "session.created": {
        if (event.data.parentID) return
        if (client) void refresh(client, event.data.sessionID)
        break
      }
      case "session.renamed": {
        const existing = sessions.value.find((item) => item.id === event.data.sessionID)
        if (existing) upsert({ ...existing, title: event.data.title })
        break
      }
      case "session.deleted": {
        sessions.value = sessions.value.filter((item) => item.id !== event.data.sessionID)
        if (currentID.value === event.data.sessionID) currentID.value = null
        break
      }
      case "session.moved":
      case "session.metadata.updated": {
        if (client) void refresh(client, event.data.sessionID)
        break
      }
      case "session.usage.updated": {
        const existing = sessions.value.find((item) => item.id === event.data.sessionID)
        if (existing) upsert({ ...existing, cost: event.data.cost, tokens: event.data.tokens })
        break
      }
      case "session.permissions": {
        const existing = sessions.value.find((item) => item.id === event.data.sessionID)
        if (existing) upsert({ ...existing, permissions: event.data.permissions })
        break
      }
      default:
        break
    }
  }

  function reset() {
    sessions.value = []
    currentID.value = null
  }

  return {
    sessions,
    sorted,
    current,
    currentID,
    loading,
    load,
    query,
    queryAll,
    create,
    remove,
    forget,
    rename,
    refresh,
    applyEvent,
    reset,
    upsert,
  }
}
