function readParam(name: string): string | null {
  try {
    return new URL(window.location.href).searchParams.get(name)
  } catch {
    return null
  }
}

/** Session id encoded in the URL, so the same URL opens the same chat. */
export function readSessionParam(): string | null {
  return readParam("session")
}

/**
 * Message id encoded in the URL, from `?message=` — the other half of a
 * permalink, naming the message in the chat to land on.
 */
export function readMessageParam(): string | null {
  return readParam("message")
}

/** Initial composer text, prefilled from `?query=`. */
export function readQueryParam(): string | null {
  return readParam("query")
}

/**
 * Project (location directory) to open, from `?project=`.
 *
 * One-time, like `?query=`: a launcher shortcut uses it to drop the app into a
 * project for one visit, without moving the project the app remembers.
 */
export function readProjectParam(): string | null {
  return readParam("project")
}

/** Whether the initial query should be sent automatically, from `?submit=`. */
export function readAutoSubmitParam(): boolean {
  const value = readParam("submit")
  if (value === null) return false
  const normalized = value.trim().toLowerCase()
  return normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes"
}

/** Drop one-time prompt params so a reload does not resend the query. */
export function clearPromptParams() {
  dropParams(["query", "submit"])
}

/** Drop the one-time `?project=` so a reload returns to the remembered project. */
export function clearProjectParam() {
  dropParams(["project"])
}

function dropParams(names: string[]) {
  try {
    const url = new URL(window.location.href)
    for (const name of names) url.searchParams.delete(name)
    history.replaceState(history.state, "", url.toString())
  } catch {
    /* history unavailable */
  }
}

export function writeSessionParam(id: string | null, replace = true) {
  try {
    const url = new URL(window.location.href)
    // A message belongs to one chat: opening another one does not carry the
    // message the URL happened to name.
    if (url.searchParams.get("session") !== id) url.searchParams.delete("message")
    if (id) url.searchParams.set("session", id)
    else url.searchParams.delete("session")
    const state = { session: id }
    if (replace) history.replaceState(state, "", url.toString())
    else history.pushState(state, "", url.toString())
  } catch {
    /* history unavailable */
  }
}

/**
 * Point the URL at one message of the open chat, which is what a timestamp's
 * own link does. Pushed rather than replaced, so Back returns to the place the
 * reader was reading before they followed it.
 */
export function writeMessageParam(id: string | null) {
  try {
    const url = new URL(window.location.href)
    // Asking for the message the URL already names is not a step to go back to.
    if (url.searchParams.get("message") === id) return
    if (id) url.searchParams.set("message", id)
    else url.searchParams.delete("message")
    const previous = history.state && typeof history.state === "object" ? history.state : {}
    history.pushState({ ...previous, message: id }, "", url.toString())
  } catch {
    /* history unavailable */
  }
}

/**
 * The absolute URL that opens a chat at one message: what a timestamp copies,
 * and what the address bar carries once it is clicked.
 */
export function messagePermalink(sessionID: string, messageID: string): string {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set("session", sessionID)
    url.searchParams.set("message", messageID)
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}
