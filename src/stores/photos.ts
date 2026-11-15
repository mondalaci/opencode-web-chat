/**
 * Attaching photos straight out of Google Photos.
 *
 * The picking itself is Google's own page, and it takes this tab over: pressing
 * the composer's button creates a session and sends the tab to Google Photos,
 * where the user searches and selects in a full page. Pressing Google's **Done**
 * leaves a "Done! Continue in the other app or device" screen, and the browser's
 * own Back button brings the app back — which is the moment this store picks the
 * selection up, pulls the bytes through the local broker, and drops them into the
 * composer as ordinary attachments.
 *
 * A tab is the only place it can happen, and the reason is Google's: the picker
 * page sends `x-frame-options: SAMEORIGIN`, so nothing in this app may frame it —
 * there is no overlay, no inline picker, no iframe. Taking the tab over is
 * therefore the whole trick, and it is the flow Google documents for a web app.
 * The window Google's own docs mention is not an option here: a separate popup
 * leaves the tab behind rather than staying in it.
 *
 * What that costs is the page: the tab navigates away, so the session, the draft
 * and the attachments all have to survive on the browser's side rather than in
 * memory. The session and the draft do (see `PENDING_KEY` and `stores/draft`), so
 * coming back finds the composer as it was and finishes the job. Attachments
 * already in the composer are the exception — they are data URLs held in memory,
 * and a navigation drops them.
 *
 * The broker (`server/photos-broker.mjs`) is what makes the sign-in possible at
 * all: it holds the OAuth client secret and the refresh token, and it is the only
 * thing that ever touches the bearer token the media bytes require. If it is not
 * running — the usual state of a plain checkout — nothing here is reachable and
 * the composer simply has no Google Photos button.
 */
import { computed, ref } from "vue"
import { connectUrl, PhotosError, photosApi, type PickedItem, type PickerSession } from "@/api/photos"
import { addFile } from "./draft"

/** Where the flow is, for the composer's button. */
export type PhotosPhase = "idle" | "picking" | "attaching"

/** Fallback when a session does not report its own expiry. */
const SESSION_TIMEOUT_MS = 60 * 60 * 1000
/** Bounds on Google's own suggested interval between polls. */
const POLL_MIN_MS = 1000
const POLL_DEFAULT_MS = 3000

/**
 * Where the pending session waits while the tab is off at Google Photos.
 *
 * `sessionStorage`, because it belongs to this tab and to this navigation: the
 * session is meaningless to another tab, and it should not outlive the tab it was
 * started in.
 */
const PENDING_KEY = "opencode-photos-pending"

const available = ref(false)
const configured = ref(false)
const authorized = ref(false)
const phase = ref<PhotosPhase>("idle")
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
/** The session the user is off picking in, when there is one. */
const pending = ref<PickerSession | null>(null)

let initialized = false
/** Set by Cancel; the watch loop checks it before its next step. */
let cancelled = false
/** True while the loop runs, so a resumed session cannot be watched twice. */
let watching = false

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The stored session, or null when the tab is not mid-pick. */
function readPending(): PickerSession | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PickerSession
    return parsed?.id && parsed?.pickerUri ? parsed : null
  } catch {
    return null
  }
}

function writePending(session: PickerSession | null) {
  try {
    if (session) sessionStorage.setItem(PENDING_KEY, JSON.stringify(session))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    /* A browser that refuses storage only costs the resume, not the flow. */
  }
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
      return
    }
    // A session in storage means this page is a return trip: the user was away
    // picking photos, and whatever they chose is waiting to be collected.
    const stored = readPending()
    if (!stored) return
    if (!authorized.value) {
      writePending(null)
      return
    }
    pending.value = stored
    void collect(stored)
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
   * Wait for the user to finish in Google Photos, then attach what they picked.
   *
   * The wait is the session's own `mediaItemsSet` — Google's signal that the user
   * is done — polled at the interval Google asks for. It only ever runs while this
   * page is in front of the user, which is exactly when it is on the way back from
   * the picker; while the tab is at Google Photos this code is not running at all.
   */
  async function collect(session: PickerSession) {
    if (watching) return
    watching = true
    phase.value = "picking"
    try {
      const deadline = session.expireTime ? Date.parse(session.expireTime) : Date.now() + SESSION_TIMEOUT_MS
      const interval = Math.max(POLL_MIN_MS, session.pollIntervalMs || POLL_DEFAULT_MS)
      while (!cancelled) {
        if (Date.now() > deadline) throw new Error("The Google Photos picking session expired.")
        await sleep(interval)
        if (cancelled) break
        const state = await photosApi.session(session.id)
        if (state.mediaItemsSet) {
          phase.value = "attaching"
          await attach((await photosApi.items(session.id)).items)
          break
        }
      }
    } catch (err) {
      error.value = message(err)
    } finally {
      watching = false
      phase.value = "idle"
      pending.value = null
      writePending(null)
      // The session has served its purpose — picked, abandoned or expired — and
      // Google asks for it to be deleted rather than left to time out.
      await photosApi.removeSession(session.id).catch(() => undefined)
    }
  }

  /**
   * Start a pick: create the session, remember it, and hand the tab to Google.
   *
   * The navigation is the last thing this page does, so nothing here may depend on
   * what comes after it — the flow continues in `init`, on the way back.
   */
  async function start() {
    if (phase.value !== "idle" || watching) return
    error.value = null
    setNotice(null)
    cancelled = false
    if (!authorized.value) {
      error.value = configured.value
        ? "Google Photos is not connected yet. Use Connect, then pick again."
        : "No Google OAuth client was found. See the README."
      return
    }
    try {
      const session = await photosApi.createSession()
      writePending(session)
      pending.value = session
      location.assign(session.pickerUri)
    } catch (err) {
      error.value = message(err)
    }
  }

  /**
   * Go back to the picker for the session already in flight.
   *
   * Worth having because the way back from Google's Done screen is the browser's
   * Back button, and a user who returns there before picking has no other way to
   * resume: the session, and the URL that serves it, are still open.
   */
  function reopen() {
    const session = pending.value
    if (session) location.assign(session.pickerUri)
  }

  /** Give up on the session in flight, and forget it. */
  function cancel() {
    cancelled = true
    error.value = null
    // Nothing was being watched — the user returned and cancelled before the loop
    // started, say — so the session has to be dropped here instead.
    const session = pending.value
    if (session && !watching) {
      pending.value = null
      writePending(null)
      void photosApi.removeSession(session.id).catch(() => undefined)
    }
  }

  function clearMessages() {
    error.value = null
    setNotice(null)
  }

  /** Where the Connect link sends the tab: the broker, which redirects to Google. */
  const consentUrl = () => connectUrl(window.location.origin)

  return {
    available,
    configured,
    authorized,
    phase,
    error,
    notice,
    pending,
    busy: computed(() => phase.value !== "idle"),
    consentUrl,
    init,
    start,
    reopen,
    cancel,
    clearMessages,
  }
}
