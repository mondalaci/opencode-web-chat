/**
 * Attaching photos straight out of Google Photos.
 *
 * The flow is Google's: this app opens a Google-hosted picking session in a new
 * tab, waits for the user to finish there, then pulls the picked bytes through
 * the local broker and drops them into the composer as ordinary attachments —
 * indistinguishable from a pasted or dropped file once they land.
 *
 * The broker (`server/photos-broker.mjs`) is what makes the sign-in possible at
 * all: it holds the OAuth client secret and the refresh token, and it is the
 * only thing that ever touches the bearer token the media bytes require. When it
 * is not running — the usual state of a plain checkout — nothing here is reachable
 * and the composer simply has no Google Photos button.
 */
import { computed, ref } from "vue"
import { PhotosError, photosApi, type PickedItem, type PickerSession } from "@/api/photos"
import { addFile } from "./draft"

/** Where the flow is, for the composer's button. */
export type PhotosPhase = "idle" | "authorizing" | "picking" | "attaching"

/** How long the consent tab is watched before the attempt is given up on. */
const CONSENT_TIMEOUT_MS = 3 * 60 * 1000
const CONSENT_POLL_MS = 1500
/** Fallback when a session does not report its own expiry. */
const SESSION_TIMEOUT_MS = 60 * 60 * 1000

const available = ref(false)
const configured = ref(false)
const authorized = ref(false)
const phase = ref<PhotosPhase>("idle")
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

let initialized = false
/** Set by Cancel; every loop checks it before its next step. */
let cancelled = false
/** The session in flight, so Cancel can clean it up on Google's side too. */
let session: PickerSession | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The picker URL with Google's `/autoclose` suffix, so the tab closes itself
 * once the user presses the button in it. The suffix belongs to the path, not
 * after the query string.
 */
function withAutoclose(uri: string) {
  const [path, query] = uri.split("?")
  return `${(path ?? uri).replace(/\/$/, "")}/autoclose${query ? `?${query}` : ""}`
}

/** A name for an attachment, keeping picked files from colliding in the strip. */
function attachName(item: PickedItem, taken: Set<string>) {
  const extension = (item.mimeType.split("/")[1] ?? "jpg").replace(/\+.*$/, "")
  const base = (item.filename || `google-photos-${item.id}`).trim()
  const wanted = base.includes(".") ? base : `${base}.${extension}`
  const dot = wanted.lastIndexOf(".")
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted
  const suffix = dot > 0 ? wanted.slice(dot) : ""
  let name = wanted
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${suffix}`
  taken.add(name)
  return name
}

function message(error: unknown) {
  if (error instanceof PhotosError && error.status === 0) {
    return "The Google Photos broker is not running. Start it to attach photos from Google Photos."
  }
  return error instanceof Error ? error.message : String(error)
}

/** A reassurance is worth a few seconds; a failure is worth keeping on screen. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined

function setNotice(text: string | null) {
  if (noticeTimer !== undefined) clearTimeout(noticeTimer)
  notice.value = text
  if (text) noticeTimer = setTimeout(() => (notice.value = null), 8000)
}

export function usePhotos() {
  /** Whether the broker answered at all; without it there is nothing to offer. */
  async function init() {
    if (initialized) return
    initialized = true
    try {
      const status = await photosApi.status()
      available.value = true
      configured.value = status.configured
      authorized.value = status.authorized
    } catch {
      available.value = false
    }
  }

  /** Walk the user through Google's consent, until the broker has a token. */
  async function authorize(tab: Window | null) {
    const { url } = await photosApi.authUrl()
    open(url, tab)
    const deadline = Date.now() + CONSENT_TIMEOUT_MS
    while (Date.now() < deadline && !cancelled) {
      await sleep(CONSENT_POLL_MS)
      const status = await photosApi.status().catch(() => null)
      if (status?.authorized) {
        authorized.value = true
        configured.value = status.configured
        return
      }
    }
    // A cancel is not a failure; only an attempt nobody finished is.
    if (!cancelled) throw new Error("The Google sign-in was not completed. Nothing was attached.")
  }

  /** Show a URL in the tab opened alongside the click, or in a fresh one. */
  function open(url: string, tab: Window | null) {
    if (tab && !tab.closed) tab.location.href = url
    else window.open(url, "_blank", "noopener,noreferrer")
  }

  /** Create a session, open its picker, and wait for the selection to be made. */
  async function collect(tab: Window | null): Promise<PickedItem[]> {
    const created = await photosApi.createSession()
    session = created
    open(withAutoclose(created.pickerUri), tab)

    const deadline = created.expireTime ? Date.parse(created.expireTime) : Date.now() + SESSION_TIMEOUT_MS
    const interval = Math.max(1000, created.pollIntervalMs || 3000)
    while (!cancelled) {
      if (Date.now() > deadline) throw new Error("The Google Photos picking session expired.")
      await sleep(interval)
      if (cancelled) break
      const state = await photosApi.session(created.id)
      if (state.mediaItemsSet) return (await photosApi.items(created.id)).items
    }
    return []
  }

  /** Pull the picked bytes and hand them to the composer. */
  async function attach(items: PickedItem[]) {
    const photos = items.filter((item) => item.type === "PHOTO" || item.mimeType.startsWith("image/"))
    const taken = new Set<string>()
    for (const item of photos) {
      if (cancelled) return
      const response = await fetch(item.contentUrl, { cache: "no-store" })
      if (!response.ok) throw new PhotosError(response.status, `Fetching ${item.filename} failed`)
      const blob = await response.blob()
      await addFile(new File([blob], attachName(item, taken), { type: item.mimeType }))
    }
    const skipped = items.length - photos.length
    const attached = photos.length === 1 ? "1 photo" : `${photos.length} photos`
    setNotice(
      skipped
        ? `Attached ${attached} from Google Photos; ${skipped === 1 ? "1 video was" : `${skipped} videos were`} left out.`
        : `Attached ${attached} from Google Photos.`,
    )
  }

  /**
   * The whole gesture: consent if it is needed, pick, attach.
   *
   * The tab is opened before anything is awaited — a window opened after an
   * `await` is a popup the browser blocks — and the session is always deleted on
   * the way out, whether the user picked anything or not, as Google asks.
   */
  async function pick() {
    if (phase.value !== "idle") return
    error.value = null
    setNotice(null)
    cancelled = false
    const tab = window.open("", "_blank")
    try {
      if (!authorized.value) {
        phase.value = "authorizing"
        await authorize(tab)
        if (cancelled) return
      }
      phase.value = "picking"
      const items = await collect(tab)
      if (cancelled) return
      phase.value = "attaching"
      await attach(items)
    } catch (err) {
      error.value = message(err)
    } finally {
      phase.value = "idle"
      const current = session
      session = null
      if (current) await photosApi.removeSession(current.id).catch(() => undefined)
      if (tab && !tab.closed) tab.close()
    }
  }

  /** Give up on the flow in flight: the tab, the session, whatever it is waiting on. */
  function cancel() {
    cancelled = true
    error.value = null
  }

  function clearMessages() {
    error.value = null
    setNotice(null)
  }

  return {
    available,
    configured,
    authorized,
    phase,
    error,
    notice,
    busy: computed(() => phase.value !== "idle"),
    init,
    pick,
    cancel,
    clearMessages,
  }
}
