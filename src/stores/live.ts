import { ref } from "vue"
import type { ServerClient } from "@/api/client"
import type { V2Event } from "@/api/types"
import { useChat } from "./chat"
import { usePresence } from "./presence"
import { useSessions } from "./sessions"

const live = ref(false)
const connecting = ref(false)
const lastEventAt = ref<number | null>(null)

const chat = useChat()
const sessions = useSessions()
const presence = usePresence()

/**
 * Every tab shares a single `/api/event` stream per server.
 *
 * Browsers cap HTTP/1.1 at six connections per origin, and one server-sent
 * event stream per tab is enough to exhaust that pool once a handful of tabs
 * are open. After that every other request — the session list included —
 * queues forever and the app looks dead. So instead of each tab holding its own
 * stream, a BroadcastChannel elects one leader per server to hold the stream
 * and fan the events out to the other tabs.
 *
 * The v2 stream is instance-wide (it is not scoped to a project), so this key
 * is the server origin alone.
 */
const CHANNEL_NAME = "opencode-web-chat.events"
const PING_MS = 2000
const LEADER_TIMEOUT_MS = PING_MS * 3
/** Grace period a joining tab waits for the current leader to answer before
 *  claiming leadership itself. */
const ELECT_GRACE_MS = 400

const supported = typeof BroadcastChannel !== "undefined"
const tabID = Math.random().toString(36).slice(2)
const seen = new Set<string>()

type Msg =
  | { t: "event"; key: string; event: V2Event }
  | { t: "ping"; key: string; id: string }
  | { t: "hello"; key: string; id: string }
  | { t: "resync"; key: string }
  | { t: "vacate"; key: string; id: string }

let channel: BroadcastChannel | null = null
let listenerAttached = false
let unloadHooked = false
let activeClient: ServerClient | null = null
let activeKey = ""
let activeDirectory: string | null | undefined
let role: "idle" | "leader" | "follower" = "idle"
let controller: AbortController | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let watchdog: ReturnType<typeof setInterval> | null = null
let electTimer: ReturnType<typeof setTimeout> | null = null
let lastPingAt = 0

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function keyFor(client: ServerClient) {
  return client.origin
}

function post(msg: Msg) {
  channel?.postMessage(msg)
}

function apply(event: V2Event) {
  if (event.id) {
    if (seen.has(event.id)) return
    seen.add(event.id)
    if (seen.size > 4000) {
      // Bound memory; keeping the newest half is enough for dedupe.
      const keep = [...seen].slice(-2000)
      seen.clear()
      for (const id of keep) seen.add(id)
    }
  }
  lastEventAt.value = Date.now()

  const client = activeClient
  if (client) {
    // The stream is instance-wide: ignore session bookkeeping for other
    // projects so the sidebar only lists the active one.
    const directory = "location" in event ? event.location?.directory : undefined
    if (!directory || !activeDirectory || directory === activeDirectory) {
      sessions.applyEvent(event, client)
    }
    chat.applyEvent(event, client)
    // Presence follows every project: a conversation in another one is still a
    // conversation the studio app may need to speak up about.
    presence.applyEvent(event)
  }
}

async function resync(client: ServerClient, directory?: string | null) {
  try {
    await sessions.load(client, directory)
  } catch {
    /* ignore */
  }
  const currentID = sessions.currentID.value
  if (currentID) {
    try {
      await chat.open(client, currentID, directory)
    } catch {
      /* ignore */
    }
  }
}

/** SSE event handler for the leader: apply locally, then fan out to followers. */
function onStreamEvent(event: V2Event) {
  apply(event)
  post({ t: "event", key: activeKey, event })
}

function openStream() {
  const client = activeClient
  if (!client) return
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  connecting.value = true

  void (async () => {
    let first = true
    while (!signal.aborted) {
      try {
        await client.subscribe(onStreamEvent, {
          signal,
          onOpen: () => {
            live.value = true
            connecting.value = false
            void resync(client, activeDirectory)
            post({ t: "resync", key: activeKey })
          },
        })
      } catch {
        /* connection dropped */
      }
      live.value = false
      if (signal.aborted) break
      if (!first) connecting.value = true
      first = false
      await sleep(1000, signal)
    }
  })()
}

function closeStream() {
  controller?.abort()
  controller = null
}

function startPings() {
  stopPings()
  // Ping immediately so tabs joining at the same moment settle quickly.
  post({ t: "ping", key: activeKey, id: tabID })
  pingTimer = setInterval(() => post({ t: "ping", key: activeKey, id: tabID }), PING_MS)
}

function stopPings() {
  if (pingTimer) clearInterval(pingTimer)
  pingTimer = null
}

function becomeLeader() {
  role = "leader"
  closeStream()
  openStream()
  startPings()
}

function becomeFollower() {
  role = "follower"
  stopPings()
  closeStream()
}

/**
 * Ask for the current leader; if none answers within the grace period, claim
 * leadership. Two claimers that start together are reconciled by id in
 * `onMessage` (the smaller id wins), so the overlap is brief.
 */
function elect() {
  if (!supported) {
    becomeLeader()
    return
  }
  role = "follower"
  connecting.value = true
  lastPingAt = 0
  post({ t: "hello", key: activeKey, id: tabID })
  if (electTimer) clearTimeout(electTimer)
  electTimer = setTimeout(
    () => {
      electTimer = null
      if (role === "follower" && lastPingAt === 0) becomeLeader()
    },
    ELECT_GRACE_MS + Math.random() * ELECT_GRACE_MS,
  )
}

function onMessage(event: MessageEvent<Msg>) {
  const msg = event.data
  if (!msg || msg.key !== activeKey) return
  if ("id" in msg && msg.id === tabID) return

  switch (msg.t) {
    case "event":
      apply(msg.event)
      break
    case "ping":
      if (role === "leader") {
        // Another leader is alive; the smaller id wins deterministically.
        if (msg.id < tabID) becomeFollower()
        break
      }
      lastPingAt = Date.now()
      live.value = true
      connecting.value = false
      break
    case "hello":
      // Answer a joiner so it does not claim leadership unnecessarily.
      if (role === "leader") post({ t: "ping", key: activeKey, id: tabID })
      break
    case "resync":
      if (role === "follower" && activeClient) void resync(activeClient, activeDirectory)
      break
    case "vacate":
      if (role === "follower") {
        lastPingAt = 0
        elect()
      }
      break
  }
}

function stop() {
  if (role === "leader" && supported) post({ t: "vacate", key: activeKey, id: tabID })
  if (electTimer) {
    clearTimeout(electTimer)
    electTimer = null
  }
  stopPings()
  if (watchdog) {
    clearInterval(watchdog)
    watchdog = null
  }
  closeStream()
  role = "idle"
  lastPingAt = 0
  live.value = false
  connecting.value = false
  seen.clear()
}

export function useLive() {
  function start(client: ServerClient, directory?: string | null) {
    stop()
    activeClient = client
    activeDirectory = directory
    activeKey = keyFor(client)

    if (!supported) {
      // No cross-tab channel available: fall back to a per-tab stream.
      becomeLeader()
      return
    }

    if (!channel) channel = new BroadcastChannel(CHANNEL_NAME)
    if (!listenerAttached) {
      channel.onmessage = onMessage
      listenerAttached = true
    }
    if (!unloadHooked && typeof window !== "undefined") {
      // Let the others take over promptly when this tab closes.
      window.addEventListener("beforeunload", () => {
        if (role === "leader") post({ t: "vacate", key: activeKey, id: tabID })
      })
      unloadHooked = true
    }

    watchdog = setInterval(() => {
      if (role === "follower" && lastPingAt > 0 && Date.now() - lastPingAt > LEADER_TIMEOUT_MS) elect()
    }, PING_MS)

    elect()
  }

  /** Point the stream at a different project without dropping it. */
  function setDirectory(directory: string | null | undefined) {
    activeDirectory = directory
  }

  return { live, connecting, lastEventAt, start, stop, setDirectory }
}
