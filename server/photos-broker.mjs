#!/usr/bin/env node
/**
 * Google Photos Picker broker for OpenCode Chat.
 *
 * The Picker API needs two things a browser page cannot hold on its own: an
 * OAuth client secret, and the bearer token that the `baseUrl` of a picked item
 * demands before it returns bytes. So this little loopback service owns the
 * token instead, and the UI talks to it through the Vite proxy under
 * `/photos-api` — same origin, no CORS, nothing to configure in the app.
 *
 * What it does, in the order the UI uses it:
 *
 *   1. `GET  /photos-api/status`                     — is it configured, is it authorized
 *   2. `GET  /photos-api/auth-url`                   — the Google consent URL to open
 *   3. `GET  /photos-api/oauth/callback`             — Google's redirect; stores the tokens
 *   4. `POST /photos-api/sessions`                   — a picking session, plus its `pickerUri`
 *   5. `GET  /photos-api/sessions/{id}`              — poll until `mediaItemsSet`
 *   6. `GET  /photos-api/sessions/{id}/items`        — the picked items
 *   7. `GET  /photos-api/sessions/{id}/items/{i}/content` — the bytes, token attached
 *   8. `DELETE /photos-api/sessions/{id}`            — clean up, as Google asks
 *
 * Only picked media is ever reachable: a content request is resolved against an
 * item the broker itself listed, so a caller cannot make it fetch an arbitrary
 * URL with the bearer token.
 *
 * It is a plain Node process with no dependencies, supervised by PM2 like the
 * Vite dev server (`ecosystem.config.cjs`). Configuration, all optional:
 *
 *   PHOTOS_BROKER_PORT   loopback port                   (default 4174)
 *   PHOTOS_OAUTH_KEYS    Google OAuth client JSON        (see KEYS_PATHS below)
 *   PHOTOS_TOKEN_FILE    where the tokens are kept       (~/.config/opencode-web-chat/photos-token.json)
 *   PHOTOS_MAX_PIXELS    long edge of an attached image  (default 2048)
 */
import { createServer } from "node:http"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"

const PORT = Number(process.env.PHOTOS_BROKER_PORT || 4174)
const HOST = "127.0.0.1"

/** Google endpoints. The Picker API lives on its own host, not the Library one. */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const PICKER_BASE = "https://photospicker.googleapis.com/v1"

/**
 * The one scope the Picker API needs. It grants access only to media the user
 * explicitly picks in a session — never to the library at large.
 */
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"

/** Long edge, in pixels, of an image fetched for an attachment. */
const MAX_PIXELS = Number(process.env.PHOTOS_MAX_PIXELS || 2048)

/**
 * Where the OAuth client is looked for.
 *
 * The app's own directory first, then the gmail MCP's — an already-installed
 * Google Cloud project with a desktop client, which is a valid home for this
 * scope too, so the picker usually needs no new credentials at all.
 */
const KEYS_PATHS = [
  process.env.PHOTOS_OAUTH_KEYS,
  join(homedir(), ".config", "opencode-web-chat", "photos-oauth.keys.json"),
  join(homedir(), ".config", "gmail-mcp", "gcp-oauth.keys.json"),
].filter(Boolean)

const TOKEN_FILE = process.env.PHOTOS_TOKEN_FILE || join(homedir(), ".config", "opencode-web-chat", "photos-token.json")

/** The `redirect_uri` Google is handed. A desktop client allows any loopback port. */
const REDIRECT_URI = `http://localhost:${PORT}/photos-api/oauth/callback`

/* -------------------------------------------------------------------------- */
/* OAuth client and tokens                                                    */
/* -------------------------------------------------------------------------- */

/** The client id and secret, from whichever keys file exists first. */
async function loadClient() {
  for (const path of KEYS_PATHS) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8"))
      // A downloaded client wraps its fields in `installed` or `web`; a hand-written
      // one may be flat. Accept all three shapes.
      const block = raw.installed ?? raw.web ?? raw
      if (block?.client_id && block?.client_secret) {
        return { clientId: block.client_id, clientSecret: block.client_secret, path }
      }
    } catch {
      /* try the next location */
    }
  }
  return null
}

/** The stored tokens, or null before the first consent. */
async function loadTokens() {
  try {
    const tokens = JSON.parse(await readFile(TOKEN_FILE, "utf8"))
    return tokens?.refresh_token ? tokens : null
  } catch {
    return null
  }
}

async function saveTokens(tokens) {
  await mkdir(dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  await chmod(TOKEN_FILE, 0o600).catch(() => undefined)
}

/**
 * A usable access token, refreshed when it is near or past its expiry.
 *
 * Refreshes are serialized: the picker and the content fetches can ask at the
 * same moment, and Google invalidates a refresh token that is used twice at once.
 */
let refreshing = null
/** Set when Google rejects a token that had not yet looked stale, to force one refresh. */
let refreshForced = false

async function accessToken() {
  const client = await loadClient()
  if (!client) throw Object.assign(new Error("No Google OAuth client found"), { status: 500 })
  const tokens = await loadTokens()
  if (!tokens) throw Object.assign(new Error("Google Photos is not connected"), { status: 401, code: "unauthorized" })

  const fresh =
    !refreshForced && tokens.access_token && tokens.expiry_date && tokens.expiry_date - Date.now() > 60_000
  refreshForced = false
  if (fresh) return tokens.access_token

  if (!refreshing) {
    refreshing = (async () => {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token",
        }),
      })
      const body = await response.json()
      if (!response.ok) {
        // A refresh token the user revoked (or the scope was removed) reads the same
        // as an expiry here: forget it and let the UI offer the consent again.
        if (body.error === "invalid_grant") await saveTokens({})
        throw Object.assign(new Error(body.error_description || body.error || "Token refresh failed"), {
          status: response.status === 400 ? 401 : response.status,
          code: body.error,
        })
      }
      const next = {
        refresh_token: body.refresh_token ?? tokens.refresh_token,
        access_token: body.access_token,
        scope: body.scope ?? tokens.scope,
        expiry_date: Date.now() + (body.expires_in ?? 3600) * 1000,
      }
      await saveTokens(next)
      return next.access_token
    })().finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

/** Call the Picker API with the bearer token, refreshing and retrying once on a 401. */
async function picker(path, init = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken()
    const response = await fetch(`${PICKER_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    })
    if (response.status === 401 && attempt === 0) {
      // The token looked fresh, so the expiry it carries is wrong — a revoked or
      // half-written one. Ask for a new one rather than replaying the same bytes.
      refreshForced = true
      continue
    }
    if (!response.ok) {
      const detail = await response.text()
      throw Object.assign(new Error(pickerError(detail) || `Google Photos answered ${response.status}`), {
        status: response.status,
      })
    }
    return response
  }
  throw new Error("Google Photos rejected the access token")
}

/** Google's own message out of an error body, when it has one. */
function pickerError(text) {
  try {
    const body = JSON.parse(text)
    return body?.error?.message
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Picking sessions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sessions whose item list this process has seen, keyed by session id.
 *
 * A content request is resolved through this map (or a fresh listing), never
 * through a URL the caller supplies, so the bearer token cannot be pointed at
 * something the user did not pick.
 */
const sessionItems = new Map()

/** A Google duration such as `3s` or `1.5s`, in ms. */
function durationMs(value, fallback) {
  const match = /^([\d.]+)s$/.exec(String(value ?? ""))
  return match ? Number(match[1]) * 1000 : fallback
}

/** List every picked item of a session, following pagination. */
async function listItems(sessionId) {
  const items = []
  let pageToken
  do {
    const query = new URLSearchParams({ sessionId, pageSize: "100" })
    if (pageToken) query.set("pageToken", pageToken)
    const response = await picker(`/mediaItems?${query}`)
    const body = await response.json()
    for (const item of body.mediaItems ?? []) {
      items.push({
        id: item.id,
        type: item.type === "VIDEO" ? "VIDEO" : "PHOTO",
        mimeType: item.mediaFile?.mimeType ?? "application/octet-stream",
        filename: item.mediaFile?.filename ?? `${item.id}`,
        baseUrl: item.mediaFile?.baseUrl ?? "",
      })
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  sessionItems.set(sessionId, items)
  return items
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

function sendError(response, error) {
  // A failure part-way through a media download has already sent its headers;
  // the only honest thing left is to drop the connection.
  if (response.headersSent) return response.destroy()
  const status = Number.isInteger(error?.status) ? error.status : 500
  sendJson(response, status, { error: { message: error?.message || String(error), code: error?.code } })
}

/** Answers Google's redirect with a page the user can close. */
function sendCallbackPage(response, { ok, message }) {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenCode Chat</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #191919;
         color: #e8e8e8; font: 15px/1.5 system-ui, sans-serif }
  div { max-width: 32rem; padding: 2rem; text-align: center }
  h1 { font-size: 1.05rem; margin: 0 0 .6rem }
  p { margin: 0; color: #a0a0a0; font-size: .9rem }
  .ok { color: #6bd18a } .bad { color: #f0886f }
</style></head>
<body><div>
<h1 class="${ok ? "ok" : "bad"}">${ok ? "Google Photos connected" : "Google Photos could not be connected"}</h1>
<p>${message}</p>
</div></body></html>`
  response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
  response.end(body)
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`)
  const path = url.pathname
  const method = request.method ?? "GET"

  if (path === "/photos-api/status" && method === "GET") {
    const client = await loadClient()
    const tokens = await loadTokens()
    return sendJson(response, 200, {
      configured: !!client,
      authorized: !!tokens,
      clientPath: client?.path ?? null,
    })
  }

  if (path === "/photos-api/auth-url" && method === "GET") {
    const client = await loadClient()
    if (!client) {
      throw Object.assign(new Error(`No Google OAuth client found. Looked in: ${KEYS_PATHS.join(", ")}`), { status: 500 })
    }
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      // Offline access plus an explicit prompt, so a refresh token always comes back
      // and the broker can keep working without the user present.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    })
    return sendJson(response, 200, { url: `${AUTH_ENDPOINT}?${query}` })
  }

  if (path === "/photos-api/oauth/callback" && method === "GET") {
    const failure = url.searchParams.get("error")
    if (failure) return sendCallbackPage(response, { ok: false, message: `${failure}: the consent was not granted.` })
    const code = url.searchParams.get("code")
    if (!code) return sendCallbackPage(response, { ok: false, message: "Google did not return an authorization code." })
    const client = await loadClient()
    if (!client) return sendCallbackPage(response, { ok: false, message: "The OAuth client disappeared." })

    const tokenResponse = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    })
    const body = await tokenResponse.json()
    if (!tokenResponse.ok) {
      return sendCallbackPage(response, {
        ok: false,
        message: body.error_description || body.error || "The token exchange failed.",
      })
    }
    await saveTokens({
      refresh_token: body.refresh_token,
      access_token: body.access_token,
      scope: body.scope,
      expiry_date: Date.now() + (body.expires_in ?? 3600) * 1000,
    })
    return sendCallbackPage(response, { ok: true, message: "You can close this tab and return to the chat." })
  }

  if (path === "/photos-api/sessions" && method === "POST") {
    const createResponse = await picker("/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    const session = await createResponse.json()
    return sendJson(response, 200, {
      id: session.id,
      pickerUri: session.pickerUri,
      pollIntervalMs: durationMs(session.pollingConfig?.pollInterval, 3000),
      expireTime: session.expireTime,
    })
  }

  const sessionMatch = /^\/photos-api\/sessions\/([^/]+)$/.exec(path)
  if (sessionMatch && method === "GET") {
    const sessionId = decodeURIComponent(sessionMatch[1])
    const sessionResponse = await picker(`/sessions/${encodeURIComponent(sessionId)}`)
    const session = await sessionResponse.json()
    return sendJson(response, 200, { mediaItemsSet: !!session.mediaItemsSet, expireTime: session.expireTime })
  }

  if (sessionMatch && method === "DELETE") {
    const sessionId = decodeURIComponent(sessionMatch[1])
    await picker(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined)
    sessionItems.delete(sessionId)
    response.writeHead(204)
    return response.end()
  }

  const itemsMatch = /^\/photos-api\/sessions\/([^/]+)\/items$/.exec(path)
  if (itemsMatch && method === "GET") {
    const sessionId = decodeURIComponent(itemsMatch[1])
    const items = await listItems(sessionId)
    return sendJson(response, 200, {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        mimeType: item.mimeType,
        filename: item.filename,
        contentUrl: `/photos-api/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(item.id)}/content`,
      })),
    })
  }

  const contentMatch = /^\/photos-api\/sessions\/([^/]+)\/items\/([^/]+)\/content$/.exec(path)
  if (contentMatch && method === "GET") {
    const sessionId = decodeURIComponent(contentMatch[1])
    const itemId = decodeURIComponent(contentMatch[2])
    let item = sessionItems.get(sessionId)?.find((candidate) => candidate.id === itemId)
    if (!item) item = (await listItems(sessionId)).find((candidate) => candidate.id === itemId)
    if (!item) throw Object.assign(new Error("That media item is not part of this session"), { status: 404 })

    // The base URL only answers with a size or a download parameter attached. An
    // image is taken at a bounded long edge, which keeps the prompt it becomes
    // reasonable; a video is asked for as itself.
    const suffix = item.type === "VIDEO" ? "=dv" : `=w${MAX_PIXELS}-h${MAX_PIXELS}`
    const token = await accessToken()
    const upstream = await fetch(`${item.baseUrl}${suffix}`, { headers: { authorization: `Bearer ${token}` } })
    if (!upstream.ok || !upstream.body) {
      throw Object.assign(new Error(`Fetching the media item failed (${upstream.status})`), { status: 502 })
    }
    response.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? item.mimeType,
      "content-disposition": `inline; filename="${item.filename.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    })
    const stream = Readable.fromWeb(upstream.body)
    // A download that breaks half-way has no way back to a JSON error; it just
    // ends, and the UI reports the attachment it could not fetch.
    stream.on("error", () => response.destroy())
    return stream.pipe(response)
  }

  throw Object.assign(new Error(`No route for ${method} ${path}`), { status: 404 })
}

const server = createServer((request, response) => {
  // The UI reaches this through the Vite proxy, so only loopback origins and
  // requests without one are served. That keeps a random page in the browser
  // from driving the Google token.
  const origin = request.headers.origin
  if (origin && !/^https?:\/\/(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    return sendJson(response, 403, { error: { message: "Cross-origin requests are not served" } })
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": origin ?? "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
    })
    return response.end()
  }
  handle(request, response).catch((error) => {
    if (error?.code === "unauthorized" || error?.status === 401) {
      return sendError(response, Object.assign(error, { status: 401, message: "Google Photos is not connected" }))
    }
    sendError(response, error)
  })
})

// Bind the loopback address only: this process hands out the Google token's
// authority, and nothing but the local UI has any business reaching it.
server.listen(PORT, HOST, () => {
  console.log(`photos broker listening on http://${HOST}:${PORT}`)
  console.log(`  keys:   ${KEYS_PATHS.join("\n          ")}`)
  console.log(`  tokens: ${TOKEN_FILE}`)
})
