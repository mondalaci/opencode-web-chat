/**
 * The local Google Photos broker, reached through the Vite proxy at
 * `/photos-api` (see `server/photos-broker.mjs`).
 *
 * It is a separate loopback process because the Picker API needs an OAuth client
 * secret and a bearer token that a page cannot hold; the app only ever speaks to
 * its own origin, so nothing here needs CORS or credentials.
 */

/** Where Vite forwards `/photos-api`. */
const BASE = "/photos-api"

/** How the broker is doing, as the composer's button needs to know it. */
export interface PhotosStatus {
  /** False when no Google OAuth client could be found at all. */
  configured: boolean
  /** True once a consent has stored a refresh token. */
  authorized: boolean
  /** The keys file the broker settled on, for the error message. */
  clientPath?: string | null
}

/**
 * A picking session, as Google hands it out.
 *
 * The whole of it is kept — in the tab's own storage — because the session has to
 * outlive the page: the picker takes the tab over, and the app only returns to the
 * session after the user comes back.
 */
export interface PickerSession {
  id: string
  /** The Google Photos URL the user picks in; not openable in an iframe. */
  pickerUri: string
  /** Google's own recommended interval between polls, in ms. */
  pollIntervalMs: number
  /** When the session stops being usable, as an RFC 3339 timestamp. */
  expireTime?: string
}

/** One picked photo or video. */
export interface PickedItem {
  id: string
  type: "PHOTO" | "VIDEO"
  mimeType: string
  filename: string
  /** Broker-relative URL that streams the bytes with the token attached. */
  contentUrl: string
}

/** A broker failure, carrying the status it answered with. */
export class PhotosError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "PhotosError"
  }

  /** True when the broker wants a consent before it can do anything else. */
  get needsConsent() {
    return this.status === 401
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
      cache: "no-store",
    })
  } catch {
    // A broker that is not running looks like this; the caller treats it as
    // "the feature is not available" rather than as an error to show.
    throw new PhotosError(0, "The Google Photos broker is not running")
  }
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new PhotosError(response.status, body?.error?.message ?? `The broker answered ${response.status}`)
  return body as T
}

/** The consent URL, for a link the user follows in this very tab. */
export function connectUrl(returnTo: string) {
  return `${BASE}/oauth/start?return=${encodeURIComponent(returnTo)}`
}

export const photosApi = {
  status: () => call<PhotosStatus>("/status"),
  createSession: () => call<PickerSession>("/sessions", { method: "POST", body: "{}" }),
  session: (id: string) => call<{ mediaItemsSet: boolean; expireTime?: string }>(`/sessions/${encodeURIComponent(id)}`),
  items: (id: string) => call<{ items: PickedItem[] }>(`/sessions/${encodeURIComponent(id)}/items`),
  removeSession: (id: string) => call<void>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
}
