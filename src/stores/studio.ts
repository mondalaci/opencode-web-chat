import { computed, onScopeDispose, watch } from "vue"
import type { ConversationState } from "@/utils/conversation"
import { usePresence, type ReportedConversation } from "./presence"

/**
 * Reports this tab's conversations to OpenCode Projects Studio, which shows them
 * on its system tray icon.
 *
 * Studio cannot poll a browser, so the tab pushes. Three pushes make up the
 * protocol:
 *
 *  - on every change, so the dot and the chime are immediate;
 *  - on a slow heartbeat, so a tab that is killed rather than closed (a crash, a
 *    browser force-quit) does not leave a status behind forever;
 *  - once on unload, so a tab that *is* closed clears at once instead of waiting
 *    for the heartbeat to lapse.
 *
 * Reports are keyed by a per-tab client id, so two tabs do not overwrite each
 * other's and closing one leaves the other's status standing.
 */

/**
 * Where studio listens. It is a constant rather than a setting because the two
 * apps live on the same machine: studio's main process binds this port on
 * loopback at startup (`electron/status-server.cjs` there), and this is the only
 * place the web app has to agree with it.
 */
const ENDPOINT = "http://127.0.0.1:45998/status"

/**
 * How often a tab re-states itself when nothing has changed. Hidden tabs have
 * their timers throttled by the browser — to roughly one a minute at worst — so
 * studio's expiry is several times this, and a background turn keeps its dot.
 */
const HEARTBEAT_MS = 20_000

/** How long a change waits for the next one, so a burst of events sends once. */
const COALESCE_MS = 250

const CLIENT_KEY = "opencode-web-chat.studio-client"

/** One report, as studio receives it. */
export interface StudioReport {
  /** Stable per-tab id: which tab this report comes from. */
  client: string
  /** The app root, so studio can build a link to a conversation. */
  url: string
  /** Epoch ms, for studio's expiry. */
  at: number
  /** The tab as a whole: the most actionable state it holds. */
  state: ConversationState
  /** How many conversations the tab has open, with news or without. */
  open: number
  conversations: ReportedConversation[]
  /** Set on the unload beacon: forget this client rather than wait for it. */
  gone?: boolean
}

/** A per-tab id that survives a reload, so a refreshed tab is not a new one. */
function clientID(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY)
    if (existing) return existing
    const created = Math.random().toString(36).slice(2)
    sessionStorage.setItem(CLIENT_KEY, created)
    return created
  } catch {
    return Math.random().toString(36).slice(2)
  }
}

export function useStudio() {
  const presence = usePresence()
  const client = clientID()

  const report = computed<StudioReport>(() => ({
    client,
    url: new URL(import.meta.env.BASE_URL || "/", location.origin).href,
    at: Date.now(),
    state: presence.state.value,
    open: presence.open.value,
    conversations: presence.conversations.value,
  }))

  /** What studio keys its expiry off: everything but the timestamp. */
  const signature = computed(() =>
    JSON.stringify({
      state: report.value.state,
      open: report.value.open,
      conversations: report.value.conversations,
    }),
  )

  /**
   * Send one report. The body is `text/plain` on purpose: that keeps the request
   * simple, so the browser sends it without a preflight it could fail. Studio
   * parses it as JSON either way, and nothing here reads the response.
   */
  function post(next: StudioReport) {
    try {
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(next),
        keepalive: true,
      }).catch(() => undefined)
    } catch {
      /* studio is not running, or the request was blocked: nothing to do */
    }
  }

  let coalesce: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let beaconed = false

  /**
   * Tell studio this tab is going away.
   *
   * `pagehide` is the event that actually fires on a tab close and on a
   * navigation — `beforeunload` is skipped in cases the browser decides are not
   * worth interrupting for, which is exactly the case a beacon exists for. Both
   * are listened for, since a browser that runs only one of them must still
   * clear the client, and `beaconed` keeps that from being two reports.
   */
  function onLeave() {
    if (beaconed) return
    beaconed = true
    // A beacon is the one request the browser promises to finish while the page
    // is going away, which is what makes a closed tab clear immediately.
    try {
      const gone: StudioReport = { ...report.value, state: "idle", conversations: [], gone: true }
      navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(gone)], { type: "text/plain" }))
    } catch {
      /* nothing to do on the way out */
    }
  }

  function start() {
    watch(
      signature,
      () => {
        if (coalesce) clearTimeout(coalesce)
        coalesce = setTimeout(() => post(report.value), COALESCE_MS)
      },
      { immediate: true },
    )
    heartbeat = setInterval(() => post(report.value), HEARTBEAT_MS)
    window.addEventListener("pagehide", onLeave)
    window.addEventListener("beforeunload", onLeave)
  }

  onScopeDispose(() => {
    if (coalesce) clearTimeout(coalesce)
    if (heartbeat) clearInterval(heartbeat)
    window.removeEventListener("pagehide", onLeave)
    window.removeEventListener("beforeunload", onLeave)
  })

  return { report, start }
}
