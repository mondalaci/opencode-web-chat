/**
 * Attaching photos straight out of Google Photos.
 *
 * The flow is Google's: this app opens a Google-hosted picking session in a small
 * popup window, waits for the user to finish there, then pulls the picked bytes
 * through the local broker and drops them into the composer as ordinary
 * attachments — indistinguishable from a pasted or dropped file once they land.
 *
 * The window is as close to "inside the tab" as Google permits: `photos.google.com`
 * sends `x-frame-options: SAMEORIGIN`, so the picker can never be framed by this
 * page, and a popup is the one form of it that leaves the composer and its status
 * line visible. On a touch browser, which ignores window features, the same call
 * simply opens a tab.
 *
 * That window is then out of reach, and this is the part worth knowing: Google's
 * page also sends `cross-origin-opener-policy: same-origin-allow-popups`, so the
 * moment it loads, the browser severs the opener and the handle this app holds
 * reports `closed` whether or not the window is still there. Nothing here may
 * therefore depend on the window's liveness — not to notice it being closed by
 * hand, not to close it. What the flow watches instead is the session, which is
 * Google's own signal that the user is done; Google's page closes its own window
 * at that point (the `/autoclose` suffix), which it is still free to do. Cancel is
 * the way out of a window the user abandoned, and the session is deleted either way.
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

/** How long the consent window is watched before the attempt is given up on. */
const CONSENT_TIMEOUT_MS = 3 * 60 * 1000
const CONSENT_POLL_MS = 1500
/** Fallback when a session does not report its own expiry. */
const SESSION_TIMEOUT_MS = 60 * 60 * 1000

/**
 * The name of the picking window.
 *
 * Naming it keeps a second attempt from leaving a second picker behind, for as
 * long as the name can still be resolved: once the window is on Google's origin
 * the browser has severed it, and the name reaches nothing.
 */
const PICKER_WINDOW = "opencode-photos-picker"

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
 * Window features for the picker: a popup, sized to a photo grid and centred over
 * this window, so it reads as something the app put up rather than as a stray tab.
 */
function pickerWindowFeatures() {
  const width = 470
  const height = Math.max(560, Math.min(880, (window.screen?.availHeight ?? 900) - 80))
  const originX = Number.isFinite(window.screenX) ? window.screenX : 0
  const originY = Number.isFinite(window.screenY) ? window.screenY : 0
  const left = Math.max(0, Math.round(originX + ((window.outerWidth || width) - width) / 2))
  const top = Math.max(0, Math.round(originY + ((window.outerHeight || height) - height) / 2))
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`
}

/**
 * The picker URL with Google's `/autoclose` suffix, so the window closes itself
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
  async function authorize(target: Window | null) {
    const { url } = await photosApi.authUrl()
    open(url, target)
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

  /**
   * Show a URL in the window opened alongside the click, or in that same named
   * window if it is still ours.
   *
   * No `noopener` here, deliberately: a window opened with it hands back `null`,
   * and the initial navigate-and-reuse below needs the reference while the window
   * is still blank. Once Google's page has loaded the reference is severed anyway,
   * so nothing downstream leans on it.
   */
  function open(url: string, target: Window | null): Window | null {
    if (target && !target.closed) {
      target.location.href = url
      return target
    }
    return window.open(url, PICKER_WINDOW, pickerWindowFeatures())
  }

  /**
   * Create a session, open its picker, and wait for the selection to be made.
   *
   * The wait is the session's own `mediaItemsSet`, and only that: the window
   * cannot be watched (see the note at the top of this file), so a picker closed
   * by hand goes unnoticed until the session expires — Cancel is the way out.
   */
  async function collect(target: Window | null): Promise<PickedItem[]> {
    const created = await photosApi.createSession()
    session = created
    open(withAutoclose(created.pickerUri), target)

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
   * The popup is opened before anything is awaited — a window opened after an
   * `await` has no user activation and is liable to be blocked — and the session
   * is always deleted on the way out, whether the user picked anything or not, as
   * Google asks.
   */
  async function pick() {
    if (phase.value !== "idle") return
    error.value = null
    setNotice(null)
    cancelled = false
    const popup = window.open("", PICKER_WINDOW, pickerWindowFeatures())
    try {
      if (!authorized.value) {
        phase.value = "authorizing"
        await authorize(popup)
        if (cancelled) return
      }
      phase.value = "picking"
      const items = await collect(popup)
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
      // Only reaches a window that never left our origin: once the picker has
      // loaded, the handle this app holds is severed and closes nothing.
      if (popup && !popup.closed) popup.close()
    }
  }

  /** Give up on the flow in flight: the window, the session, whatever it is waiting on. */
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
